'use strict';
// Opens and keeps the SSH port forward that a loopback Hermes address needs: the Hermes API server (8642) and
// Hermes Desktop (9120) listen only on the server's own loopback. One `ssh -N` carries every port that nothing on
// this computer already answers, restarts with a capped backoff while it is still wanted, and is stopped by
// killing exactly the child this module started.
const net = require('node:net');
const { isSshTarget } = require('./core.cjs');
const { SSH_OPTIONS } = require('./tailnet.cjs');

const BACKOFF_MAX_MS = 30000, UP_POLL_MS = 250, EXTERNAL_RECHECK_MS = 30000;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const bindOf = (host) => host === '[::1]' ? '[::1]' : '127.0.0.1';

const probeTcp = (port, bind) => new Promise((resolve) => {
  const socket = net.connect({ port, host: bind.replace(/^\[|\]$/g, '') });
  const done = (ok) => { socket.destroy(); resolve(ok); };
  socket.setTimeout(1000, () => done(false));
  socket.once('connect', () => done(true));
  socket.once('error', () => done(false));
});

// First stderr line that says something, with no control characters.
const reasonOf = (text) => String(text).split('\n').map((line) => line.replace(/[\x00-\x1f\x7f]/g, ' ').trim()).find((line) => line && !/^Warning:/i.test(line))?.slice(0, 160) || '';

function createSshForward({ spawn, probe = probeTcp, isHost = isSshTarget, sshOptions = SSH_OPTIONS, timers = { set: setTimeout, clear: clearTimeout }, onChange = () => {} }) {
  let wanted = null, child = null, timer = null, failures = 0, current = { state: 'off', reason: '' };
  const waiters = new Set();
  const after = (fn, ms) => { timer = timers.set(fn, ms); timer?.unref?.(); };
  const setState = (state, reason = '') => {
    if (current.state === state && current.reason === reason) return;
    current = { state, reason };
    if (state !== 'connecting') { for (const wake of [...waiters]) wake(); }
    onChange();
  };
  const kill = () => { if (child && Number.isInteger(child.pid) && child.pid > 1) { try { child.kill(); } catch {} } };

  async function start() {
    timer = null;
    const mine = wanted;
    if (!mine) return;
    const open = await Promise.all(mine.targets.map((t) => probe(t.port, t.bind)));
    if (wanted !== mine) return;
    const needed = mine.targets.filter((_, i) => !open[i]);
    if (!needed.length) { failures = 0; setState('external'); after(start, EXTERNAL_RECHECK_MS); return; }
    const args = ['-N', ...sshOptions, '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
      '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=accept-new', ...needed.flatMap((t) => ['-L', `${t.bind}:${t.port}:127.0.0.1:${t.port}`]), mine.host];
    if (current.state === 'external') setState('connecting');
    let proc, err = '', over = false;
    const finish = (code, spawnError) => {
      if (over) return;
      over = true;
      timers.clear(timer); timer = null;
      if (child === proc) child = null;
      if (wanted === mine) {
        failures += 1;
        setState('failed', spawnError || reasonOf(err) || `ssh stopped (${code ?? 'no exit code'})`);
        after(start, Math.min(BACKOFF_MAX_MS, 1000 * 2 ** (failures - 1)));
      } else if (wanted) after(start, 0); // Replaced: start the new wish only once the old ssh has let go of its ports.
    };
    try { proc = spawn('ssh', args, { stdio: ['ignore', 'ignore', 'pipe'] }); } catch (e) { proc = null; failures += 1; setState('failed', reasonOf(e.message)); after(start, Math.min(BACKOFF_MAX_MS, 1000 * 2 ** (failures - 1))); return; }
    child = proc;
    proc.stderr?.on('data', (chunk) => { if (err.length < 2048) err += chunk; });
    proc.once('exit', (code) => finish(code));
    proc.once('error', (e) => finish(null, reasonOf(e.message)));
    const poll = async () => {
      const ok = await Promise.all(needed.map((t) => probe(t.port, t.bind)));
      if (child !== proc) return;
      if (ok.every(Boolean)) { failures = 0; setState('up'); } else after(poll, UP_POLL_MS);
    };
    after(poll, UP_POLL_MS);
  }

  return {
    // host: the saved SSH login. targets: [{ host, port }] taken from the chat addresses; only loopback http ones count.
    // Returns whether anything is wanted. Calling again with the same wish changes nothing.
    set(host, targets = []) {
      host = typeof host === 'string' ? host.trim() : '';
      const seen = new Map();
      for (const t of targets) if (t && LOOPBACK.has(t.host) && Number.isInteger(t.port) && t.port >= 1 && t.port <= 65535) seen.set(`${bindOf(t.host)}:${t.port}`, { bind: bindOf(t.host), port: t.port });
      const list = host && isHost(host) ? [...seen.values()].sort((a, b) => a.port - b.port || a.bind.localeCompare(b.bind)) : [];
      const key = list.length ? `${host}|${list.map((t) => `${t.bind}:${t.port}`)}` : '';
      if (key === (wanted?.key || '')) return !!wanted;
      timers.clear(timer); timer = null; failures = 0;
      wanted = list.length ? { key, host, targets: list } : null;
      setState(wanted ? 'connecting' : 'off');
      if (child) kill(); else if (wanted) after(start, 0);
      return !!wanted;
    },
    state: () => ({ ...current }),
    // Words for the chat, or '' when there is nothing to say.
    note: () => current.state === 'connecting' ? 'Connecting to your server…'
      : current.state === 'failed' ? `Can't open the connection to your server (${current.reason}). Check that Tailscale is on and that your SSH key works. Workspace keeps trying.` : '',
    // Resolves once the first connection attempt has an outcome (or after ms).
    ready: (ms = 10000) => current.state !== 'connecting' ? Promise.resolve() : new Promise((resolve) => {
      const t = timers.set(resolve, ms);
      t?.unref?.();
      const wake = () => { waiters.delete(wake); timers.clear(t); resolve(); };
      waiters.add(wake);
    }),
    stop() { this.set('', []); },
  };
}

module.exports = { createSshForward, probeTcp };

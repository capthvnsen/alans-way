// Canvas Terminal: one shell per bot, started only by a user click or shortcut. Nothing here takes text from a bot or a web page.
const { spawn, execFile } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const fs = require('node:fs');
const { isSshTarget } = require('./core.cjs');

const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
const size = (value, fallback, max) => Number.isInteger(value) ? Math.min(max, Math.max(2, value)) : fallback;
const userShell = (env, exists) => typeof env.SHELL === 'string' && /^\/[\w./+-]+$/.test(env.SHELL) && exists(env.SHELL) ? env.SHELL : '/bin/sh';
const killProcessGroup = (pid, kill = process.kill) => { if (Number.isInteger(pid) && pid > 1) kill(-pid, 'SIGKILL'); };

// `script` supplies the pty. macOS's refuses a socket for stdin, which is what a Node pipe is, so `cat` feeds it a real pipe.
// The inner script is fixed: size and program arrive as separate arguments and fd 3 reports the tty path and the end of the session.
// When the program ends, its last output is still in flight through script and cat: stdin is closed so they finish and 'close' ends the
// session; the kill after a second is only for a pipeline that does not.
// The program waits for one line back on fd 3, so the pane's real size can be applied before its startup files draw anything.
function terminalCommand({ platform = process.platform, env = process.env, sshHost = '', sshOptions = [], cols, rows, exists = fs.existsSync } = {}) {
  if (platform === 'win32') return { unavailable: 'Terminal is not available on Windows yet.' };
  if (sshHost && !isSshTarget(sshHost)) return { unavailable: 'The saved SSH address is not valid.' };
  const program = sshHost ? ['ssh', '-tt', ...sshOptions, '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=accept-new', '--', sshHost] : [userShell(env, exists), '-l'];
  const inner = ['/bin/sh', '-c', 'stty cols "$1" rows "$2"; tty >&3; read -r _ <&3; shift 2; "$@"; echo done >&3', 'sh', String(size(cols, 80, 500)), String(size(rows, 24, 200)), ...program];
  const script = platform === 'darwin' ? ['-q', '/dev/null', ...inner] : ['-qfc', inner.map(quote).join(' '), '/dev/null'];
  return { file: '/bin/sh', args: ['-c', 'cat | script "$@"', 'sh', ...script] };
}

function createTerminals({ platform = process.platform, spawnProcess = spawn, killGroup = spawnProcess === spawn ? killProcessGroup : () => {}, run = execFile, build = terminalCommand, waitMs = 1500, flushMs = 16, maxBufferBytes = 65536, onData, onExit }) {
  const sessions = new Map();
  const flush = (id, session) => {
    clearTimeout(session.flushTimer);
    session.flushTimer = undefined;
    if (!session.buffer) return;
    const text = session.buffer;
    session.buffer = '';
    onData(id, text);
  };
  const end = (id, session, quiet) => {
    if (sessions.get(id) !== session) return;
    clearTimeout(session.timer); clearTimeout(session.grace); clearTimeout(session.flushTimer);
    const tail = session.decoder.end();
    if (tail) session.buffer += tail;
    if (!quiet && session.buffer) { const text = session.buffer; session.buffer = ''; onData(id, text); }
    else session.buffer = '';
    sessions.delete(id);
    try { killGroup(session.child.pid); } catch {}
    if (!quiet) onExit(id);
  };
  return {
    ids: () => [...sessions.keys()],
    start(id, { sshHost = '', sshOptions = [], cols, rows } = {}) {
      if (sessions.has(id)) return { ok: true };
      const command = build({ platform, sshHost, sshOptions, cols, rows });
      if (command.unavailable) return { ok: false, reason: command.unavailable };
      const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
      for (const key of Object.keys(env)) if (key.startsWith('ELECTRON_')) delete env[key];
      const child = spawnProcess(command.file, command.args, { env, detached: true, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
      const decoder = new StringDecoder('utf8');
      const session = { child, decoder, tty: null, buffer: '', flushTimer: undefined, go: () => { clearTimeout(session.timer); if (!session.went) { session.went = true; child.stdio[3].write('go\n'); } } };
      sessions.set(id, session);
      // Leading-and-trailing batching: isolated keystroke echoes deliver in 0 ms,
      // while high-rate output bursts coalesce into one IPC/xterm write per frame.
      const arm = () => {
        if (flushMs <= 0) return;
        session.flushTimer = setTimeout(() => {
          session.flushTimer = undefined;
          if (session.buffer) { const text = session.buffer; session.buffer = ''; onData(id, text); arm(); }
        }, flushMs);
        session.flushTimer.unref?.();
      };
      const emit = (text) => {
        if (!text) return;
        if (flushMs <= 0) { onData(id, text); return; }
        if (!session.flushTimer) { onData(id, text); arm(); return; }
        session.buffer += text;
        if (session.buffer.length >= maxBufferBytes) { flush(id, session); arm(); }
      };
      child.stdout.on('data', (chunk) => emit(decoder.write(chunk)));
      child.stderr.on('data', (chunk) => emit(String(chunk).replace(/\n/g, '\r\n')));
      child.stdio[3].on('data', (chunk) => { for (const line of String(chunk).split('\n').filter(Boolean)) { if (session.tty === null) { session.tty = /^\/dev\/[\w/]+$/.test(line) ? line : ''; session.timer = setTimeout(session.go, waitMs).unref(); if (session.pending) this.resize(id, ...session.pending); } else if (!session.grace) { child.stdin.end(); session.grace = setTimeout(() => end(id, session), 1000); } } });
      for (const stream of [child.stdin, child.stdout, child.stderr, child.stdio[3]]) stream.on('error', () => {});
      child.once('error', (error) => { emit(`${error.message}\r\n`); end(id, session); });
      child.once('close', () => end(id, session));
      return { ok: true };
    },
    input(id, data) {
      const session = sessions.get(id);
      if (session && typeof data === 'string' && data.length <= 65536) session.child.stdin.write(data);
    },
    // The kernel's window size is changed from outside, so a program running in the shell sees SIGWINCH and no text is typed into it.
    resize(id, cols, rows) {
      const session = sessions.get(id);
      if (session && session.tty === null) session.pending = [cols, rows];
      else if (session?.tty) run('stty', [platform === 'darwin' ? '-f' : '-F', session.tty, 'cols', String(size(cols, 80, 500)), 'rows', String(size(rows, 24, 200))], session.go);
    },
    kill(id) { const session = sessions.get(id); if (session) end(id, session); },
    killAll() { for (const [id, session] of [...sessions]) end(id, session, true); },
    keepOnly(ids) { for (const id of this.ids()) if (!ids.includes(id)) this.kill(id); },
  };
}

module.exports = { terminalCommand, createTerminals, killProcessGroup };

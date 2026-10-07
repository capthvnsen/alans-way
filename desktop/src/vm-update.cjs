'use strict';

// Drives a release update on every saved agent machine over SSH, before the
// local app updates itself. The bundled script is piped over stdin so nothing
// is installed on the VM; it prints one JSON result line that becomes the
// per-VM status. All SSH is BatchMode with pinned host keys, exactly like
// vps-browser.cjs and watchdog.cjs.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { isSshTarget } = require('./core.cjs');
const { isNewer } = require('./mac-update.cjs');

const TAG_RE = /^v\d+\.\d+\.\d+$/;
const SSH_OPTIONS = ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=yes'];
const VM_TIMEOUT_MS = 300000;
const CHECK_TIMEOUT_MS = 30000;
const SNOOZE_MS = 24 * 60 * 60 * 1000;
const SCRIPTS = { posix: 'vm-update.sh', windows: 'vm-update.ps1' };

const tail = (text) => String(text || '').trim().split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 300);

function vmTargets(prefs) {
  const cfg = prefs?.vpsBrowser;
  if (!cfg?.sshHost) return [];
  return [{ id: 'agent', label: prefs?.remotePlatform === 'mac' ? 'Mac VM' : 'VPS',
    sshHost: cfg.sshHost, scriptPath: cfg.scriptPath || '', sudo: cfg.sudo === true }];
}

// The guest script answers with one JSON object on its last line; anything
// above it is progress the caller may log.
function parseResultLine(output) {
  const lines = String(output || '').split('\n').filter((line) => line.trimStart().startsWith('{'));
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function defaultRun(bin, args, { input, timeoutMs = 45000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { timeout: timeoutMs });
    let out = '', err = '';
    child.stdout.on('data', (c) => { if (out.length < 40000) out += c; });
    child.stderr.on('data', (c) => { if (err.length < 8000) err += c; });
    child.on('error', (error) => resolve({ code: -1, out, err: `${err}${error.message || error}` }));
    child.on('close', (code) => resolve({ code, out, err }));
    if (input !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(input); }
  });
}

const defaultReadScript = (name) => fs.readFileSync(path.join(__dirname, '..', 'scripts', name), 'utf8');

function createVmUpdater({ run = defaultRun, readScript = defaultReadScript, log = () => {} } = {}) {
  const ssh = (host, remote, opts) => run('ssh', [...SSH_OPTIONS, host, remote], opts);

  // A saved scriptPath ending in a drive letter means the guest runs Windows
  // (setup schedules tasks there); a POSIX path means sh. Without one, node
  // is guaranteed on the guest because the services run it.
  async function guestKind(vm) {
    if (/^[A-Za-z]:/.test(vm.scriptPath || '')) return 'windows';
    if ((vm.scriptPath || '').startsWith('/')) return 'posix';
    const probe = await ssh(vm.sshHost, 'node -p process.platform', { timeoutMs: 10000 });
    return /win32/.test(probe.out) ? 'windows' : 'posix';
  }

  function remoteFor(kind, { tag, check }) {
    if (kind === 'windows') {
      const setting = check ? 'ALANS_WAY_VM_CHECK=1' : `ALANS_WAY_VM_TAG=${tag}`;
      // cmd exists under every Windows sshd shell (cmd, PowerShell, Git Bash).
      return { script: SCRIPTS.windows, remote: `cmd /d /c "set ${setting}&& powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command -"` };
    }
    return { script: SCRIPTS.posix, remote: check ? 'sh -s -- --check' : `sh -s -- ${tag}` };
  }

  async function runGuest(vm, { tag, check = false, timeoutMs = VM_TIMEOUT_MS }) {
    const host = String(vm.sshHost || '').trim();
    if (!isSshTarget(host)) return { ok: false, state: 'failed', error: 'The saved VM SSH address is invalid. Re-enter it as user@host or host.' };
    if (!check && !TAG_RE.test(String(tag))) return { ok: false, state: 'failed', error: `Refusing non-release tag "${tag}".` };
    const kind = await guestKind(vm);
    const { script, remote } = remoteFor(kind, { tag, check });
    let text;
    try { text = readScript(script); } catch { return { ok: false, state: 'failed', error: `The bundled ${script} is missing; reinstall the app.` }; }
    const res = await ssh(host, remote, { input: text, timeoutMs });
    const result = parseResultLine(res.out) || {};
    if (res.code !== 0 && !Object.keys(result).length)
      return { ok: false, state: 'failed', error: `Could not reach the VM over SSH. ${tail(res.err) || `exit ${res.code}`}` };
    return result;
  }

  async function updateVm(vm, tag) {
    try {
      const result = await runGuest(vm, { tag });
      if (result.ok === true) return { ok: true, state: 'ok', version: String(result.version || tag.replace(/^v/, '')) };
      const error = String(result.error || 'The VM update failed without a reason.');
      return { ok: false, state: error === 'busy' ? 'busy' : 'failed', version: String(result.version || ''), error: error === 'busy' ? 'VM busy, will retry' : error };
    } catch (error) {
      log('vm-update', error);
      return { ok: false, state: 'failed', error: tail(error.message) || 'The VM update failed.' };
    }
  }

  async function checkVm(vm) {
    try {
      const result = await runGuest(vm, { check: true, timeoutMs: CHECK_TIMEOUT_MS });
      if (result.ok !== true) return { ok: false, error: String(result.error || 'check failed') };
      return { ok: true, version: String(result.version || ''), hostVersion: String(result.hostVersion || ''), busy: result.busy === true };
    } catch (error) {
      log('vm-check', error);
      return { ok: false, error: tail(error.message) || 'check failed' };
    }
  }

  async function updateAll(tag, targets) {
    return Promise.all((targets || []).map(async (vm) => ({ id: vm.id, label: vm.label, ...(await updateVm(vm, tag)) })));
  }

  // The release order: every VM first, then the local app. A VM that failed
  // or timed out is reported, never thrown, so the app update always runs.
  async function updateAppAndVms({ tag, targets, applyAppUpdate }) {
    const vms = await updateAll(tag, targets);
    const app = await applyAppUpdate();
    return { vms, app };
  }

  return { updateVm, checkVm, updateAll, updateAppAndVms };
}

function shouldShowUpdatePopup({ available, snoozedUntil, now, busy } = {}) {
  return Boolean(available) && !busy && Number(now) >= Number(snoozedUntil || 0);
}
const snoozeUntil = (now) => Number(now) + SNOOZE_MS;

// The persistent banner shown after relaunch while any saved VM still runs an
// older host than the app, or its last update failed.
function vmRetryState(appVersion, vms) {
  for (const entry of Object.values(vms || {})) {
    if (entry?.failed) return { show: true, version: String(entry.version || ''), failed: String(entry.failed) };
    if (entry?.version && isNewer(appVersion, entry.version)) return { show: true, version: String(entry.version), failed: '' };
  }
  return { show: false, version: '', failed: '' };
}

module.exports = { createVmUpdater, vmTargets, parseResultLine, shouldShowUpdatePopup, snoozeUntil, vmRetryState, VM_TIMEOUT_MS, CHECK_TIMEOUT_MS, TAG_RE };

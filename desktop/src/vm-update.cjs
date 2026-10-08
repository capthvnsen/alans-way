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
const DOCTOR_TIMEOUT_MS = 120000;
// A remote-side cap a little under VM_TIMEOUT_MS: killing the local ssh does
// not reliably kill a piped `sh -s` (no TTY, no SIGHUP), so where timeout(1)
// exists the guest run terminates instead of orphaning an npm ci.
const VM_TIMEOUT_REMOTE_S = 285;
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

function defaultRun(bin, args, { input, timeoutMs = 45000, onStdout } = {}) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { timeout: timeoutMs });
    let out = '', err = '';
    child.stdout.on('data', (c) => {
      if (out.length < 40000) out += c;
      if (onStdout) { try { onStdout(String(c)); } catch {} }
    });
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

  function remoteFor(kind, { tag, check, doctor }) {
    if (kind === 'windows') {
      const setting = check ? 'ALANS_WAY_VM_CHECK=1' : `ALANS_WAY_VM_TAG=${tag}`;
      // cmd exists under every Windows sshd shell (cmd, PowerShell, Git Bash).
      return { script: SCRIPTS.windows, remote: `cmd /d /c "set ${setting}&& powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command -"` };
    }
    if (doctor) return { script: SCRIPTS.posix, remote: 'sh -s -- --doctor' };
    if (check) return { script: SCRIPTS.posix, remote: 'sh -s -- --check' };
    const timeoutJson = `printf '%s\\n' '{"ok":false,"version":"","restarted":false,"error":"the update timed out on the VM"}'`;
    return { script: SCRIPTS.posix,
      remote: `if command -v timeout >/dev/null 2>&1; then timeout ${VM_TIMEOUT_REMOTE_S} sh -s -- ${tag}; rc=$?; if [ "$rc" -eq 124 ]; then ${timeoutJson}; fi; exit "$rc"; else exec sh -s -- ${tag}; fi` };
  }

  async function runGuest(vm, { tag, check = false, doctor = false, timeoutMs = VM_TIMEOUT_MS, onProgress } = {}) {
    const host = String(vm.sshHost || '').trim();
    if (!isSshTarget(host)) return { ok: false, state: 'failed', error: 'The saved VM SSH address is invalid. Re-enter it as user@host or host.' };
    if (!check && !doctor && !TAG_RE.test(String(tag))) return { ok: false, state: 'failed', error: `Refusing non-release tag "${tag}".` };
    const kind = await guestKind(vm);
    if (doctor && kind === 'windows') return { ok: false, error: 'windows' };
    const { script, remote } = remoteFor(kind, { tag, check, doctor });
    let text;
    try { text = readScript(script); } catch { return { ok: false, state: 'failed', error: `The bundled ${script} is missing; reinstall the app.` }; }
    // The guest script narrates phases as "vm-update: <text>" lines; forward the
    // ones that map to UI text so the popup can say what it is doing.
    let pending = '';
    const onStdout = onProgress ? (chunk) => {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) {
        const mapped = line.startsWith('vm-update: ') ? vmPhaseText(line.slice(11)) : '';
        if (mapped) onProgress(vm.id, mapped);
      }
    } : undefined;
    const res = await ssh(host, remote, { input: text, timeoutMs, onStdout });
    const result = parseResultLine(res.out) || {};
    if (res.code !== 0 && !Object.keys(result).length)
      return { ok: false, state: 'failed', error: `Could not reach the VM over SSH. ${tail(res.err) || `exit ${res.code}`}` };
    return result;
  }

  async function updateVm(vm, tag, onProgress) {
    try {
      const result = await runGuest(vm, { tag, onProgress });
      const plugins = Array.isArray(result.plugins) ? result.plugins : [];
      const gatewayRestarted = result.gatewayRestarted === true;
      const gatewayRestartCmd = result.gatewayRestartCmd;
      if (result.ok === true) return { ok: true, state: 'ok', version: String(result.version || tag.replace(/^v/, '')),
        plugins, gatewayRestarted, pluginLines: vmPluginLines({ plugins, gatewayRestarted, gatewayRestartCmd }) };
      const error = String(result.error || 'The VM update failed without a reason.');
      return { ok: false, state: error === 'busy' ? 'busy' : 'failed', version: String(result.version || ''), error: error === 'busy' ? 'VM busy, will retry' : error,
        plugins, gatewayRestarted, pluginLines: vmPluginLines({ plugins, gatewayRestarted, gatewayRestartCmd }) };
    } catch (error) {
      log('vm-update', error);
      return { ok: false, state: 'failed', error: tail(error.message) || 'The VM update failed.', plugins: [], gatewayRestarted: false, pluginLines: [] };
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

  // Read-only health report for Check setup. Never throws: a failure is a result.
  async function doctorVm(vm) {
    try {
      const result = await runGuest(vm, { doctor: true, timeoutMs: DOCTOR_TIMEOUT_MS });
      return result.ok === true ? result : { ok: false, error: String(result.error || 'The server check failed.') };
    } catch (error) {
      log('vm-doctor', error);
      return { ok: false, error: tail(error.message) || 'The server check failed.' };
    }
  }

  async function updateAll(tag, targets, onProgress) {
    return Promise.all((targets || []).map(async (vm) => ({ id: vm.id, label: vm.label, ...(await updateVm(vm, tag, onProgress)) })));
  }

  // The release order: every VM first, then the local app. A VM that failed
  // or timed out is reported, never thrown, so the app update always runs.
  async function updateAppAndVms({ tag, targets, applyAppUpdate, onProgress }) {
    const vms = await updateAll(tag, targets, onProgress);
    const app = await applyAppUpdate();
    return { vms, app };
  }

  return { updateVm, checkVm, doctorVm, updateAll, updateAppAndVms };
}

function shouldShowUpdatePopup({ available, snoozedUntil, now, busy } = {}) {
  return Boolean(available) && !busy && Number(now) >= Number(snoozedUntil || 0);
}
const snoozeUntil = (now) => Number(now) + SNOOZE_MS;

// The persistent banner shown after relaunch while any saved VM still runs an
// older host than the app, or its last update failed. Only currently
// configured targets count: a record for a VM whose address was removed must
// not wedge the banner.
function vmRetryState(appVersion, vms, targets) {
  for (const target of targets || []) {
    const entry = vms?.[target.id];
    if (entry?.failed) return { show: true, version: String(entry.version || ''), failed: String(entry.failed) };
    if (entry?.version && isNewer(appVersion, entry.version)) return { show: true, version: String(entry.version), failed: '' };
  }
  return { show: false, version: '', failed: '' };
}

// A version check reports what the VM runs now; a successful one refreshes
// the record: a same or newer report clears a stale failure, while an older
// or unparseable report must not erase a fresher recorded result (an update
// that landed while the check was in flight).
// Returns the vmUpdates entry to store, or null to keep the existing one.
function vmCheckEntry(previous, check) {
  const reported = String(check?.version || check?.hostVersion || '');
  const known = String(previous?.version || '');
  if (!/^\d+\.\d+\.\d+$/.test(reported) || (known && isNewer(known, reported))) return null;
  if (reported === known && !previous?.failed) return null;
  return { version: reported, failed: '' };
}

// Records are keyed by target id; drop every record whose id is not a saved
// VM (a removed target, or an id an older build wrote by mistake) so only
// live targets can ever steer the retry banner.
function pruneVmUpdates(vms, targets) {
  const ids = new Set((targets || []).map((target) => target.id));
  const next = {};
  for (const [id, entry] of Object.entries(vms || {})) {
    if (ids.has(id)) next[id] = entry;
  }
  return next;
}

// Maps the guest script's "vm-update: <text>" progress lines to UI text.
// Anything else returns '' so only phases worth surfacing reach the popup.
function vmPhaseText(line) {
  const text = String(line || '').toLowerCase();
  if (text.includes('restarting the agent')) return 'Restarting your agent…';
  if (text.includes('plugin')) return 'Updating agent plugins…';
  return '';
}

// One UI line for a plugin result. `qualified` adds the plugin name (and the
// profile for named profiles) when a VM reports more than one entry.
function pluginStatusText(p, { qualified = false } = {}) {
  const name = String(p?.name || '');
  const profile = String(p?.profile || '');
  const subject = qualified ? `Plugin ${profile && profile !== 'default' ? `${name} (${profile})` : name}` : 'Plugin';
  const cmd = `hermes${profile && profile !== 'default' ? ` -p ${profile}` : ''} plugins update ${name}`;
  const ver = (v) => `v${String(v || '').replace(/^v/, '')}`;
  switch (p?.status) {
    case 'updated':
      return p.before && p.after && p.before !== p.after
        ? `${subject} updated (${ver(p.before)} to ${ver(p.after)})` : `${subject} updated`;
    case 'current': return `${subject} is current`;
    case 'needs_approval': return `${subject} update needs your approval. On your VM run: ${cmd}`;
    case 'skipped': return `${subject} update skipped: ${p.error || 'local changes'}`;
    default: return `${subject} update failed: ${p.error || 'unknown reason'}`;
  }
}

// The plugin lines shown under a VM's update result, plus a warning when new
// plugin code never got loaded because the gateway restart did not finish.
// Plugin problems are warnings; they never change the VM's ok/failed state.
function vmPluginLines({ plugins, gatewayRestarted, gatewayRestartCmd } = {}) {
  const list = Array.isArray(plugins) ? plugins : [];
  const qualified = list.length > 1;
  const lines = list.map((p) => ({
    text: pluginStatusText(p, { qualified }),
    tone: p.status === 'updated' ? 'ok' : p.status === 'current' ? 'info' : 'warn',
  }));
  if (gatewayRestarted === false && list.some((p) => p.status === 'updated')) {
    // The guest names the restart that works there: a supervisorctl command
    // when the gateway runs under a service manager like supervisord.
    const cmd = String(gatewayRestartCmd || 'hermes gateway restart');
    lines.push({ text: `Your agent needs a restart to load the new plugin. On your VM run: ${cmd}`, tone: 'warn' });
  }
  return lines;
}

module.exports = { createVmUpdater, vmTargets, parseResultLine, shouldShowUpdatePopup, snoozeUntil, vmRetryState, vmCheckEntry, pruneVmUpdates, vmPhaseText, pluginStatusText, vmPluginLines, VM_TIMEOUT_MS, CHECK_TIMEOUT_MS, DOCTOR_TIMEOUT_MS, TAG_RE };

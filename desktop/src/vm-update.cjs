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
const { posixCommand } = require('./remote-shell.cjs');
const { isNewer } = require('./mac-update.cjs');
const { compareVersions, normalizeVersion } = require('./update-version.cjs');
const { redactReport } = require('./setup-check.cjs');

const TAG_RE = /^v\d+\.\d+\.\d+$/;
const SSH_OPTIONS = ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=yes'];
const VM_TIMEOUT_MS = 300000;
// The check also asks Hermes for its version, `update --check` (a git fetch)
// and gateway status, which took 15s on a live server.
const CHECK_TIMEOUT_MS = 90000;
// The whole Check setup run should stay under two minutes: the reach probe
// (15s) and the platform probe in guestKind (10s) run before this, so the
// doctor cap keeps the worst case at ~115s. The guest-side doctor budget
// (ALANS_WAY_VM_DOCTOR_BUDGET, 75s) stays under it so the result line lands.
const DOCTOR_TIMEOUT_MS = 90000;
// A remote-side cap a little under VM_TIMEOUT_MS: killing the local ssh does
// not reliably kill a piped `sh -s` (no TTY, no SIGHUP), so where timeout(1)
// exists the guest run terminates instead of orphaning an npm ci.
const VM_TIMEOUT_REMOTE_S = 285;
const HERMES_UPDATE_TIMEOUT_MS = 300000;
const HERMES_UPDATE_REMOTE_S = 285;
const SNOOZE_MS = 24 * 60 * 60 * 1000;
const SCRIPTS = { posix: 'vm-update.sh', windows: 'vm-update.ps1' };
const HERMES_UPDATE_SCRIPTS = { posix: 'hermes-update.sh', windows: 'hermes-update.ps1' };

// A Hermes on the app's own machine (no saved server) runs the same scripts
// through the local shell instead of ssh.
const LOCAL_TARGET = Object.freeze({ id: 'local', label: 'this computer', local: true });

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

function defaultRun(bin, args, { input, timeoutMs = 45000, onStdout, verbatim = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { timeout: timeoutMs, windowsVerbatimArguments: verbatim });
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
  // The remote command is what sshd would hand the guest's shell; locally the
  // same string goes to sh, or to cmd with the whole line quoted once more so
  // /s strips only that outer pair and the inner cmd /c line stays intact.
  const exec = (vm, remote, opts) => !vm.local ? ssh(String(vm.sshHost || '').trim(), remote, opts)
    : process.platform === 'win32' ? run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${remote}"`], { ...opts, verbatim: true })
    : run('/bin/sh', ['-c', remote], opts);

  // A saved scriptPath ending in a drive letter means the guest runs Windows
  // (setup schedules tasks there); a POSIX path means sh. Without one, node
  // is guaranteed on the guest because the services run it.
  async function guestKind(vm) {
    if (vm.local) return process.platform === 'win32' ? 'windows' : 'posix';
    if (/^[A-Za-z]:/.test(vm.scriptPath || '')) return 'windows';
    if ((vm.scriptPath || '').startsWith('/')) return 'posix';
    const probe = await ssh(vm.sshHost, 'node -p process.platform', { timeoutMs: 10000 });
    return /win32/.test(probe.out) ? 'windows' : 'posix';
  }

  function remoteFor(kind, { tag, check, doctor, hermesUpdate, plugins }) {
    if (kind === 'windows') {
      // cmd exists under every Windows sshd shell (cmd, PowerShell, Git Bash).
      if (hermesUpdate) return { script: HERMES_UPDATE_SCRIPTS.windows, remote: 'cmd /d /c "powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command -"' };
      const setting = check ? 'ALANS_WAY_VM_CHECK=1' : plugins ? 'ALANS_WAY_VM_PLUGINS=1' : `ALANS_WAY_VM_TAG=${tag}`;
      return { script: SCRIPTS.windows, remote: `cmd /d /c "set ${setting}&& powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command -"` };
    }
    if (hermesUpdate) {
      const timeoutJson = `printf '%s\\n' '{"ok":false,"version":"","updated":false,"error":"the update timed out on the VM","messaged":false,"messages":[]}'`;
      return { script: HERMES_UPDATE_SCRIPTS.posix,
        remote: `if command -v timeout >/dev/null 2>&1; then timeout ${HERMES_UPDATE_REMOTE_S} sh -s; rc=$?; if [ "$rc" -eq 124 ]; then ${timeoutJson}; fi; exit "$rc"; else exec sh -s; fi` };
    }
    if (doctor) return { script: SCRIPTS.posix, remote: 'sh -s -- --doctor' };
    if (check) return { script: SCRIPTS.posix, remote: 'sh -s -- --check' };
    const args = plugins ? '--plugins' : tag;
    const timeoutJson = `printf '%s\\n' '{"ok":false,"version":"","restarted":false,"error":"the update timed out on the VM"}'`;
    return { script: SCRIPTS.posix,
      remote: `if command -v timeout >/dev/null 2>&1; then timeout ${VM_TIMEOUT_REMOTE_S} sh -s -- ${args}; rc=$?; if [ "$rc" -eq 124 ]; then ${timeoutJson}; fi; exit "$rc"; else exec sh -s -- ${args}; fi` };
  }

  // `vars` become shell (or $env:) assignments ahead of the piped script, so
  // values reach it without touching the remote command line. Values are
  // reduced to plain text first; nothing in them can quote its way out.
  async function runGuestRaw(vm, { tag, check = false, doctor = false, hermesUpdate = false, plugins = false, vars = {}, timeoutMs = VM_TIMEOUT_MS, onProgress } = {}) {
    if (!vm.local && !isSshTarget(String(vm.sshHost || '').trim())) return { ok: false, state: 'failed', error: 'The saved VM SSH address is invalid. Re-enter it as user@host or host.' };
    if (!check && !doctor && !hermesUpdate && !plugins && !TAG_RE.test(String(tag))) return { ok: false, state: 'failed', error: `Refusing non-release tag "${tag}".` };
    const kind = await guestKind(vm);
    if (doctor && kind === 'windows') return { ok: false, error: 'windows' };
    const { script, remote } = remoteFor(kind, { tag, check, doctor, hermesUpdate, plugins });
    let text;
    try { text = readScript(script); } catch { return { ok: false, state: 'failed', error: `The bundled ${script} is missing; reinstall the app.` }; }
    const prelude = Object.entries(vars).map(([name, value]) => kind === 'windows'
      ? `$env:${name} = '${plainText(value)}'\n` : `${name}='${plainText(value)}'\n`).join('');
    text = prelude + (kind === 'windows' ? text : posixCommand(text));
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
    const res = await exec(vm, remote, { input: text, timeoutMs, onStdout });
    const result = parseResultLine(res.out) || {};
    if (doctor && !Object.keys(result).length) return res.code === null ? { ok: false, error: 'The server check ran out of time.' }
      : { ok: false, executionError: { prefix: 'The server check stopped without a report: ', text: `${res.out}\n${res.err}`, fallback: `exit ${res.code}` } };
    if (res.code !== 0 && !Object.keys(result).length)
      return { ok: false, state: 'failed', executionError: { prefix: 'Could not reach the VM over SSH. ', text: res.err, fallback: `exit ${res.code}` } };
    return result;
  }

  // One app boundary for guest JSON, raw execution failures and exceptions.
  // No settings, persistent record, report or logger receives unsanitized data.
  function sanitizeGuest(value) {
    // Older guests may already have cut off a URL's scheme. Remove its
    // remaining userinfo and query/fragment before any app consumer sees it.
    if (typeof value === 'string') return redactReport(value)
      .replace(/([^\s/]+)@([a-z\d][a-z\d.-]*|\[[\da-f:.]+\])?(:[^\s/?#]*)?/gi,
        // A username and a non-port colon suffix identify a credential-free scp remote.
        (match, userinfo, host, port) => !userinfo.includes(':') && (!host || port && !/^:\d+$/.test(port))
          ? match : `[redacted]@${host || ''}${port || ''}`)
      .replace(/([^\s?#]*\/[^\s?#]*|(?:\[[\da-f:.]+\]|(?:[a-z\d-]+\.)+[a-z\d-]+|localhost|@[a-z\d][a-z\d.-]*)(?::\d+)?|(?=[?#][^\s]*=))[?#][^\s]*/gi, '$1[redacted]');
    if (Array.isArray(value)) return value.map(sanitizeGuest);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
      .map(([key, item]) => [sanitizeGuest(key), sanitizeGuest(item)]));
    return value;
  }
  async function runGuest(vm, opts) {
    try {
      const result = sanitizeGuest(await runGuestRaw(vm, opts));
      // Truncate only after redaction: a long URL must not lose the syntax
      // the redactor needs to recognize a credential.
      if (result.executionError) {
        const { prefix, text, fallback } = result.executionError;
        result.error = prefix + (tail(text) || fallback);
        delete result.executionError;
      }
      return result;
    }
    catch (error) {
      const reason = sanitizeGuest(error?.message || String(error));
      log('vm-guest', reason);
      return { ok: false, state: 'failed', error: tail(reason) || 'The guest operation failed.' };
    }
  }

  // Every result carries the target's id/label: callers key per-VM progress
  // and the persistent prefs.vmUpdates retry record off result.id directly,
  // whether the result came from updateVm or updateAll.
  // `pluginsOnly` runs just the Hermes plugin phase (vm-update --plugins): no
  // tag, no browser host checkout needed, so it also works on a local Hermes.
  async function updateVm(vm, tag, onProgress, { pluginsOnly = false } = {}) {
    try {
      const result = await runGuest(vm, { tag, plugins: pluginsOnly, onProgress });
      const plugins = Array.isArray(result.plugins) ? result.plugins : [];
      const gatewayRestarted = result.gatewayRestarted === true;
      const gatewayRestartCmd = result.gatewayRestartCmd;
      if (result.ok === true) return { id: vm.id, label: vm.label, ok: true, state: 'ok', version: String(result.version || ''),
        plugins, gatewayRestarted, pluginLines: vmPluginLines({ plugins, gatewayRestarted, gatewayRestartCmd }, { target: pluginsOnly ? '' : normalizeVersion(tag) }) };
      const error = String(result.error || 'The VM update failed without a reason.');
      return { id: vm.id, label: vm.label, ok: false, state: error === 'busy' ? 'busy' : 'failed', version: String(result.version || ''), error: error === 'busy' ? 'VM busy, will retry' : error,
        plugins, gatewayRestarted, pluginLines: vmPluginLines({ plugins, gatewayRestarted, gatewayRestartCmd }, { target: pluginsOnly ? '' : normalizeVersion(tag) }) };
    } catch (error) {
      error = sanitizeGuest(error?.message || String(error));
      log('vm-update', error);
      return { id: vm.id, label: vm.label, ok: false, state: 'failed', error: tail(error) || 'The VM update failed.', plugins: [], gatewayRestarted: false, pluginLines: [] };
    }
  }

  // The settings "Update Hermes" button: `hermes update` on the guest, then
  // each profile's bot messages the user through `hermes send`. The guest
  // script reports both halves in one JSON result; a message that could not
  // be sent never masks the update outcome.
  // `quiet` updates without the message; `report` skips the update and only
  // sends that text. "Update everything" uses both to message once at the end.
  async function hermesUpdateVm(vm, { quiet = false, report = '' } = {}) {
    try {
      const vars = report ? { ALANS_WAY_HERMES_REPORT: report } : quiet ? { ALANS_WAY_HERMES_QUIET: '1' } : {};
      const result = await runGuest(vm, { hermesUpdate: true, vars, timeoutMs: HERMES_UPDATE_TIMEOUT_MS });
      const messages = (Array.isArray(result.messages) ? result.messages : [])
        .map((m) => ({ profile: String(m?.profile || ''), sent: m?.sent === true, error: String(m?.error || '') }));
      const base = { version: String(result.version || ''), before: String(result.before || ''), current: result.current === true, updated: result.updated === true,
        messaged: result.messaged === true || messages.some((m) => m.sent), messages,
        gatewayRestarted: result.gatewayRestarted === true };
      if (result.ok === true) return { ok: true, state: 'ok', error: String(result.error || ''), ...base };
      return { ok: false, state: 'failed', error: String(result.error || 'The Hermes update failed without a reason.'), ...base };
    } catch (error) {
      error = sanitizeGuest(error?.message || String(error));
      log('hermes-update', error);
      return { ok: false, state: 'failed', error: tail(error) || 'The Hermes update failed.', version: '', updated: false, messaged: false, messages: [], gatewayRestarted: false };
    }
  }

  async function checkVm(vm) {
    try {
      const result = await runGuest(vm, { check: true, timeoutMs: CHECK_TIMEOUT_MS });
      if (result.ok !== true) return { ok: false, error: String(result.error || 'check failed') };
      return { ok: true, version: String(result.version || ''), hostVersion: String(result.hostVersion || ''), busy: result.busy === true,
        hermesVersion: String(result.hermesVersion || ''), hermesCheck: String(result.hermesCheck || ''),
        pluginVersion: String(result.pluginVersion || ''), ...(Array.isArray(result.plugins) ? { plugins: result.plugins } : {}), gatewayRunning: typeof result.gatewayRunning === 'boolean' ? result.gatewayRunning : null };
    } catch (error) {
      error = sanitizeGuest(error?.message || String(error));
      log('vm-check', error);
      return { ok: false, error: tail(error) || 'check failed' };
    }
  }

  // Read-only health report for Check setup. Never throws: a failure is a result.
  async function doctorVm(vm) {
    try {
      const result = await runGuest(vm, { doctor: true, timeoutMs: DOCTOR_TIMEOUT_MS });
      return result.ok === true ? result : { ok: false, error: String(result.error || 'The server check failed.') };
    } catch (error) {
      error = sanitizeGuest(error?.message || String(error));
      log('vm-doctor', error);
      return { ok: false, error: tail(error) || 'The server check failed.' };
    }
  }

  async function updateAll(tag, targets, onProgress) {
    return Promise.all((targets || []).map((vm) => updateVm(vm, tag, onProgress)));
  }

  // The release order: every VM first, then the local app. A VM that failed
  // or timed out is reported, never thrown, so the app update always runs.
  async function updateAppAndVms({ tag, targets, applyAppUpdate, onProgress }) {
    const vms = await updateAll(tag, targets, onProgress);
    const app = await applyAppUpdate();
    return { vms, app };
  }

  const updatePluginsVm = (vm, onProgress) => updateVm(vm, '', onProgress, { pluginsOnly: true });

  return { updateVm, updatePluginsVm, hermesUpdateVm, checkVm, doctorVm, updateAll, updateAppAndVms };
}

function shouldShowUpdatePopup({ available, snoozedUntil, now, busy } = {}) {
  return Boolean(available) && !busy && Number(now) >= Number(snoozedUntil || 0);
}

// One lock for every path that mutates the agent machines: the app update
// flow (update.busy), a VM update retry (vmRetrying), a manual `hermes
// update` (hermesUpdating) and "Update everything" (updatingAll) all stop/start
// the same gateways and plugin trees. Every entry point checks the whole
// lock; a partial check is how two update paths end up running on the same
// machine at once.
function updateLocked({ updateBusy = false, vmRetrying = false, hermesUpdating = false, updatingAll = false } = {}) {
  return Boolean(updateBusy || vmRetrying || hermesUpdating || updatingAll);
}

// Text that can sit inside single quotes in sh and PowerShell, and survive
// cmd: letters, digits, spaces and plain punctuation only.
const plainText = (value) => String(value || '').replace(/[^A-Za-z0-9 .,:;()+\/-]/g, '').slice(0, 300);
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
function pluginStatusText(p, { qualified = false, subject: namedSubject = '' } = {}) {
  const name = String(p?.name || '');
  const profile = String(p?.profile || '');
  const subject = namedSubject || (qualified ? `Plugin ${profile && profile !== 'default' ? `${name} (${profile})` : name}` : 'Plugin');
  const cmd = `hermes${profile && profile !== 'default' ? ` -p ${profile}` : ''} plugins update ${name}`;
  const ver = (v) => `v${String(v || '').replace(/^v/, '')}`;
  switch (p?.status) {
    case 'updated':
      return p.before && p.after && p.before !== p.after
        ? `${subject} updated (${ver(p.before)} to ${ver(p.after)})` : `${subject} updated`;
    case 'current': return `${subject} is current${p.error ? `: ${p.error}` : ''}`;
    case 'needs_approval': return `${subject} update needs your approval${p.error ? `: ${p.error}` : ''}. On your VM run: ${cmd}`;
    case 'blocked': return `${subject} update blocked: ${p.error || 'the gateway is running'}`;
    case 'skipped': return `${subject} update skipped: ${p.error || 'local changes'}`;
    default: return `${subject} update failed: ${p.error || 'unknown reason'}`;
  }
}

// One settings line for a hermesUpdateVm result. The message half is always
// reported alongside the update outcome: the button's promise is that the bot
// tells the user, so a send that could not happen must be said out loud.
function hermesUpdateDetail(result, label) {
  const where = label ? ` on the ${label}` : '';
  const messaged = result?.messaged === true;
  if (result?.ok) {
    const valid = compareVersions(result.version, result.version) !== null;
    const movement = compareVersions(result.version, result.before);
    const moved = movement !== null && (movement > 0 || (result.updated === true && movement === 0 && normalizeVersion(result.version) !== normalizeVersion(result.before)));
    const what = moved ? `Hermes updated${result.version ? ` to v${result.version}` : ''}` : valid && result.current === true ? 'Hermes is already up to date'
      : `Hermes update warning: ${redactReport(result.error || 'version unchanged or unverified')}`;
    if (messaged) return `${what}${where}; your bot messaged you on Telegram.`;
    const first = (result.messages || []).find((m) => !m.sent && m.error)?.error || '';
    return `${what}${where}, but the bot could not message you${first ? `: ${first}` : ' (no Hermes profile answered)'}`;
  }
  const err = String(result?.error || 'The Hermes update failed.');
  return messaged ? `${err} Your bot still messaged you.` : err;
}

// The plugin lines shown under a VM's update result, plus a warning when new
// plugin code never got loaded because the gateway restart did not finish.
// Plugin problems are warnings; they never change the VM's ok/failed state.
function vmPluginLines({ plugins, gatewayRestarted, gatewayRestartCmd } = {}, { target = '' } = {}) {
  const list = Array.isArray(plugins) ? plugins : [];
  const qualified = list.length > 1;
  const lines = list.map((p) => {
    const comparison = target ? compareVersions(p.after, target) : null;
    const missed = target && (comparison === null || comparison < 0);
    const subject = `Plugin ${p.name || 'unknown'} (${p.profile || 'default'})`;
    const evidence = missed ? `${subject} ${comparison === null ? 'version unverified' : `on ${normalizeVersion(p.after)}`} (wanted ${target}): ${p.error || p.status || 'no version evidence'}`
      : target ? pluginStatusText(p, { subject })
      : pluginStatusText(p, { qualified });
    return { text: redactReport(evidence),
      tone: missed ? 'warn' : p.status === 'updated' ? 'ok' : p.status === 'current' ? 'info' : 'warn' };
  });
  if (gatewayRestarted === false && list.some((p) => p.status === 'updated' || (p.status === 'current' && /^version unchanged or unverified:/.test(p.error || '')))) {
    // The guest names the restart that works there: a supervisorctl command
    // when the gateway runs under a service manager like supervisord.
    const cmd = String(gatewayRestartCmd || 'hermes gateway restart');
    lines.push({ text: `Your agent needs a restart to load the new plugin. On your VM run: ${cmd}`, tone: 'warn' });
  }
  return lines;
}

module.exports = { createVmUpdater, vmTargets, LOCAL_TARGET, plainText, parseResultLine, shouldShowUpdatePopup, updateLocked, snoozeUntil, vmRetryState, vmCheckEntry, pruneVmUpdates, vmPhaseText, pluginStatusText, vmPluginLines, hermesUpdateDetail, VM_TIMEOUT_MS, CHECK_TIMEOUT_MS, DOCTOR_TIMEOUT_MS, HERMES_UPDATE_TIMEOUT_MS, TAG_RE };

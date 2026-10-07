// Alan's Watchdog — drives the Settings toggle that routes the agent
// machine's egress through this computer while it stays connected. Locally it
// toggles Tailscale's exit-node advertisement; remotely it uploads the two
// shell scripts from a checkout of this repository and installs (or removes)
// the watchdog systemd unit over plain SSH. All SSH is BatchMode with pinned
// host keys, exactly like vps-browser.cjs.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isSshTarget } = require('./core.cjs');

const SCRIPTS = { watchdog: 'alans-watchdog.sh', installer: 'alans-watchdog-vps.sh' };
// $HOME is the SSH user's on the agent machine — expands remotely, never here.
const REMOTE_DIR = '$HOME/.local/share/hermes-alans-way/watchdog/scripts';
const SSH_OPTIONS = ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=yes'];

const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
const tail = (text) => String(text || '').trim().split('\n').filter(Boolean).pop() || '';
const detail = (text) => String(text || '').trim().split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 300);

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

function tailscaleBin(platform, exists = fs.existsSync) {
  const fixed = platform === 'darwin' ? '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
    : platform === 'win32' ? 'C:\\Program Files\\Tailscale\\tailscale.exe'
      : '';
  return fixed && exists(fixed) ? fixed : 'tailscale';
}

// The watchdog scripts ship with this repository — a dev checkout sits two
// levels up from src/, and the installers keep a clone at ~/alans-way, which
// is what a packaged app finds.
function scriptDirs({ home = os.homedir(), root = path.join(__dirname, '..', '..') } = {}) {
  return [path.join(root, 'scripts'), path.join(home, 'alans-way', 'scripts')];
}

function scriptPayloads(dirs = {}) {
  const out = {};
  for (const name of Object.values(SCRIPTS)) {
    const file = scriptDirs(dirs).map((dir) => path.join(dir, name)).find((f) => fs.existsSync(f));
    if (!file) {
      const error = new Error(`Alan's Watchdog ships with the alans-way repository — clone it (https://github.com/capthvnsen/alans-way) or reinstall the app, then retry.`);
      error.friendly = true;
      throw error;
    }
    out[name] = fs.readFileSync(file, 'utf8');
  }
  return out;
}

const uploadCommand = (name) => `mkdir -p ${REMOTE_DIR} && cat > ${REMOTE_DIR}/${name}`;
const runAsRoot = (inner) =>
  `if [ "$(id -u)" = 0 ]; then ${inner};` +
  ` elif sudo -n true 2>/dev/null; then sudo -n ${inner};` +
  ` else echo WATCHDOG_NEEDS_ROOT; fi`;
const installCommand = (peer) => runAsRoot(`sh ${REMOTE_DIR}/${SCRIPTS.installer} --exit-node ${quote(peer)}`);
const uninstallCommand = () => runAsRoot(`sh ${REMOTE_DIR}/${SCRIPTS.installer} --uninstall`);

function createWatchdog({ run, platform = process.platform, home = os.homedir(), root, payloads } = {}) {
  const runProcess = run || defaultRun;
  const ssh = (host, remote, opts = {}) => runProcess('ssh', [...SSH_OPTIONS, host, remote], { timeoutMs: 90000, ...opts });
  const loadPayloads = () => payloads || scriptPayloads({ home, root });

  async function setEnabled({ enabled, sshHost, remotePlatform }) {
    if (remotePlatform === 'mac') {
      return { ok: false, detail: 'The agent machine is a macOS VM — it already shares this computer’s network, so there is nothing to route.' };
    }
    const host = String(sshHost || '').trim();
    if (!host) return { ok: false, detail: 'Save the agent machine’s SSH address above first.' };
    if (!isSshTarget(host)) return { ok: false, detail: 'The saved agent machine SSH address is invalid.' };
    const ts = tailscaleBin(platform);

    if (!enabled) {
      // Un-advertising locally guarantees routing stops within about a minute
      // (the watchdog's egress probe fails) even when the agent machine is
      // unreachable — so always do it, then best-effort remove the service.
      const off = await runProcess(ts, ['set', '--advertise-exit-node=false']);
      if (off.code !== 0) {
        return { ok: false, detail: `Tailscale refused to stop advertising (${detail(off.err || off.out) || `exit ${off.code}`}). Run: tailscale set --advertise-exit-node=false` };
      }
      const removed = await ssh(host, uninstallCommand());
      const text = `${removed.out}\n${removed.err}`;
      if (removed.code !== 0 || text.includes('WATCHDOG_NEEDS_ROOT')) {
        return { ok: true, detail: `This computer no longer offers itself as an exit node — the agent machine’s watchdog falls back to direct egress within about a minute. Its service could not be removed (${detail(text) || 'unreachable'}); run 'sudo sh ${REMOTE_DIR}/${SCRIPTS.installer} --uninstall' there later.` };
      }
      return { ok: true, detail: 'Watchdog removed and this computer stopped advertising — the agent machine uses its own egress again.' };
    }

    const advertise = await runProcess(ts, ['set', '--advertise-exit-node']);
    if (advertise.code !== 0) {
      return { ok: false, detail: `Tailscale refused exit-node advertising (${detail(advertise.err || advertise.out) || `exit ${advertise.code}`}). Run 'tailscale set --advertise-exit-node' on this computer, or pick Exit Node → Run Exit Node in its menu.` };
    }
    const address = await runProcess(ts, ['ip', '-4']);
    const peer = (String(address.out).match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/) || [])[0] || '';
    if (!peer) return { ok: false, detail: 'Tailscale did not report an IPv4 address — is it signed in and connected?' };

    let files;
    try { files = loadPayloads(); } catch (error) { return { ok: false, detail: error.message }; }
    for (const name of Object.values(SCRIPTS)) {
      const upload = await ssh(host, uploadCommand(name), { input: files[name] });
      if (upload.code !== 0) {
        return { ok: false, detail: `Could not reach the agent machine over SSH (${detail(upload.err) || `exit ${upload.code}`}) — check Tailscale and the saved address.` };
      }
    }
    const installed = await ssh(host, installCommand(peer), { timeoutMs: 120000 });
    const text = `${installed.out}\n${installed.err}`;
    if (text.includes('WATCHDOG_NEEDS_ROOT')) {
      return { ok: false, detail: `The watchdog needs root on the agent machine. Run there: sudo sh ${REMOTE_DIR}/${SCRIPTS.installer} --exit-node ${peer}` };
    }
    if (installed.code !== 0 || !text.includes('enabled and started')) {
      return { ok: false, detail: `The watchdog installer failed on the agent machine. ${detail(text)}` };
    }
    const approval = text.includes('not an approved exit node')
      ? ' Approve this computer in the Tailscale admin console (Machines → ⋯ → Edit route settings) or routing never starts.'
      : '';
    return { ok: true, detail: `Alan's Watchdog is installed on the agent machine — it routes egress through this computer while it stays connected.${approval}` };
  }

  return { setEnabled };
}

module.exports = { createWatchdog, scriptPayloads, scriptDirs, tailscaleBin, REMOTE_DIR, SCRIPTS };

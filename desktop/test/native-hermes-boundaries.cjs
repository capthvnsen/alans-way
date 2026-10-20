'use strict';
// PROVENANCE: adapted from the reviewed pattern
// evidence/quality/workspace-chrome-key-calibration-critic/harness/boundaries.cjs
// (itself from evidence/quality/toolbar-space-critic/harness-r10/boundaries.cjs,
// coordinator-supplied safe generic setup) for task_1d274caeb204, the native
// Hermes conversation surface acceptance run. Same pre-main boundary set —
// deny native input/focus/TCC/dialogs/external URLs/SSH/OS clipboard; owned
// loopback sockets only; memory clipboard; fs writes confined to OUT +
// profile. Fixture-only deltas:
//   * ownedPorts is also seeded from NHC_ALLOWED_PORTS — the stock backend and
//     provider live in OTHER owned processes, so in-process listen() tracking
//     cannot see their ports.
//   * safeStorage is memory-backed (no OS keychain); encrypt/decrypt round-trip
//     in-process so the hub's persistence path is exercised without touching
//     the OS credential store. Persistence proof is therefore qualified:
//     ciphertext writes under the owned profile only.
//   * the final require loads MY driver (NHC_FIXTURE / HERMES_FIXTURE).
// Installed BEFORE any product module loads; refuses fail closed.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const crypto = require('node:crypto'), Module = require('node:module');
const electron = require('electron'), { app, session } = electron;
const out = path.resolve(process.env.HOME_OUT || process.env.NHC_OUT);
const target = path.resolve(process.env.HOME_TARGET || path.join(__dirname, '..'));
const profile = path.resolve(process.env.HERMES_TEST_PROFILE || process.env.HERMES_WORKSPACE_DATA);
const fixture = process.env.NHC_FIXTURE || process.env.HERMES_FIXTURE;
for (const [name, v] of [['HOME_OUT/NHC_OUT', out], ['HOME_TARGET', target], ['HERMES_TEST_PROFILE', profile], ['NHC_FIXTURE', fixture]]) {
  if (!v || !String(v).length) throw new Error(`native-hermes boundary refuses to run: ${name} unset`);
}
const records = [], imports = new Map();
const baseLoad = Module._load;
Module._load = function (request, parent, ...args) {
  const result = baseLoad.call(this, request, parent, ...args);
  try {
    const file = Module._resolveFilename(request, parent);
    if (typeof file === 'string' && file.startsWith(target + path.sep) && fs.statSync(file).isFile()) {
      imports.set(file, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
    }
  } catch { }
  return result;
};
const telegramSessions = new WeakSet();
app.whenReady().then(() => telegramSessions.add(session.fromPartition('persist:telegram')));
const blocked = require(path.join(target, 'test/settings-fixture-boundaries.cjs'))();
const deny = (name, detail = '') => { records.push({ boundary: name, detail: String(detail) }); throw Error('Native-Hermes fixture boundary: ' + name); };
const local = (host) => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(String(host));

// Loopback sockets: only ports this fixture owns (in-process listeners plus
// the seeded backend/provider ports from the orchestrator).
const net = require('node:net'), connect = net.Socket.prototype.connect, ownedPorts = new Set();
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  this.once('listening', () => { const address = this.address(); if (address && typeof address === 'object') ownedPorts.add(address.port); });
  return listen.apply(this, args);
};
for (const p of String(process.env.NHC_ALLOWED_PORTS || '').split(',').map((s) => parseInt(s, 10)).filter((n) => n > 0 && n < 65536)) ownedPorts.add(p);
net.Socket.prototype.connect = function (...args) {
  const a = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host = a && typeof a === 'object' ? a.host || a.hostname || 'localhost' : typeof args[1] === 'string' ? args[1] : 'localhost';
  const port = +(a && typeof a === 'object' ? a.port : a);
  if (typeof a === 'string' && !/^\d+$/.test(a) || a && typeof a === 'object' && a.path || !local(host) || !ownedPorts.has(port)) return deny('node.socket', host + ':' + port);
  return connect.apply(this, args);
};
const tls = require('node:tls'), tlsConnect = tls.connect;
tls.connect = function (...args) { const a = args.find((v) => v && typeof v === 'object') || {}; if (!local(a.host || a.servername || 'localhost')) return deny('node.tls', a.host); return tlsConnect.apply(this, args); };
const dns = require('node:dns');
for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6', 'reverse']) { const fn = dns[name]; dns[name] = function (host, ...args) { if (!local(host)) return deny('node.dns', host); return fn.call(this, host, ...args); }; }
require('node:dgram').createSocket = () => deny('node.dgram');

os.homedir = () => path.join(profile, 'home'); fs.mkdirSync(os.homedir(), { recursive: true });
for (const name of ['appData', 'userData', 'sessionData', 'logs', 'temp', 'crashDumps']) { const p = path.join(profile, name); fs.mkdirSync(p, { recursive: true }); app.setPath(name, p); }
app.setAsDefaultProtocolClient = () => false;
app.on('web-contents-created', (_e, wc) => { wc.sendInputEvent = () => deny('native input'); });
for (const name of ['showOpenDialog', 'showOpenDialogSync', 'showSaveDialog', 'showSaveDialogSync', 'showMessageBox', 'showMessageBoxSync', 'showErrorBox']) electron.dialog[name] = () => deny('dialog.' + name);
electron.Menu.prototype.popup = () => deny('native menu');

// Memory clipboard: every OS clipboard API denied except the memory stand-ins.
let memoryText = '', memoryItems = [];
for (const name of Object.keys(electron.clipboard)) if (typeof electron.clipboard[name] === 'function') electron.clipboard[name] = () => deny('OS clipboard.' + name);
electron.clipboard.writeText = (text) => { memoryText = String(text); memoryItems = [new electron.ClipboardItem({ 'text/plain': new Blob([memoryText], { type: 'text/plain' }) })]; records.push({ boundary: 'clipboard.fixture-write', detail: `len=${memoryText.length}` }); };
electron.clipboard.readText = () => memoryText;
electron.clipboard.read = async () => memoryItems;
electron.clipboard.write = async (items) => { memoryItems = items; memoryText = ''; if (items[0]?.types.includes('text/plain')) { const value = await items[0].getType('text/plain'); memoryText = value instanceof Blob ? await value.text() : String(value); } };

// safeStorage: in-memory tagged stand-in. No OS keychain is touched; the hub's
// persist/read paths still exercise real encrypt/decrypt call order.
try {
  const tag = Buffer.from('NHC1');
  electron.safeStorage.isEncryptionAvailable = () => { records.push({ boundary: 'safeStorage.fixture', detail: 'isEncryptionAvailable' }); return true; };
  electron.safeStorage.encryptString = (plain) => { records.push({ boundary: 'safeStorage.fixture', detail: 'encryptString' }); return Buffer.concat([tag, Buffer.from(Buffer.from(String(plain), 'utf8').toString('base64'), 'utf8')]); };
  electron.safeStorage.decryptString = (buf) => {
    records.push({ boundary: 'safeStorage.fixture', detail: 'decryptString' });
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    if (!b.subarray(0, 4).equals(tag)) throw new Error('fixture safeStorage: unknown ciphertext');
    return Buffer.from(b.subarray(4).toString('utf8'), 'base64').toString('utf8');
  };
  if (typeof electron.safeStorage.getSelectedStorageBackend === 'function') {
    electron.safeStorage.getSelectedStorageBackend = () => 'fixture-memory';
  }
} catch (e) { throw new Error(`required guard failed: safeStorage stub — ${e}`); }

const secured = new WeakSet();
function secure(s) {
  if (secured.has(s)) return; secured.add(s);
  const register = s.webRequest.onBeforeRequest.bind(s.webRequest);
  s.webRequest.onBeforeRequest = (...args) => {
    const fn = args.at(-1);
    register((d, cb) => {
      let stub = false;
      try { const u = new URL(d.url); stub = telegramSessions.has(s) && u.protocol === 'https:' && u.hostname === 'web.telegram.org'; } catch { }
      if (stub) { records.push({ boundary: 'Chromium.request.telegram-stub', detail: d.url }); return cb({}); }
      let okay = false;
      try {
        const u = new URL(d.url);
        okay = ['file:', 'about:', 'data:', 'blob:', 'chrome-extension:', 'hw-avatar:', 'crx:'].includes(u.protocol)
          || ['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol) && local(u.hostname) && ownedPorts.has(+u.port);
      } catch { }
      if (!okay) { records.push({ boundary: 'Chromium.request', detail: d.url }); return cb({ cancel: true }); }
      return typeof fn === 'function' ? fn(d, cb) : cb({});
    });
  };
  s.webRequest.onBeforeRequest(null);
  s.setPermissionRequestHandler((_wc, _permission, cb) => cb(false)); s.setPermissionCheckHandler(() => false);
  s.setPermissionRequestHandler = s.setPermissionCheckHandler = () => { };
  if (s.setDisplayMediaRequestHandler) { s.setDisplayMediaRequestHandler((_r, cb) => cb({})); s.setDisplayMediaRequestHandler = () => { }; }
}
app.on('session-created', secure); app.whenReady().then(() => { secure(session.defaultSession); secure(session.fromPartition('persist:telegram')); });

// fs writes confined to OUT + profile roots (reads unrestricted).
const allowed = (p) => typeof p !== 'string' && !Buffer.isBuffer(p) && !(p instanceof URL)
  || [out, profile].some((root) => { const f = path.resolve(p instanceof URL ? require('node:url').fileURLToPath(p) : String(p)); return f === root || f.startsWith(root + path.sep); });
for (const owner of [fs, fs.promises]) for (const name of ['writeFileSync', 'writeFile', 'appendFileSync', 'appendFile', 'mkdirSync', 'mkdir', 'rmSync', 'rm', 'unlinkSync', 'unlink', 'renameSync', 'rename', 'copyFileSync', 'copyFile', 'cpSync', 'cp', 'chmodSync', 'chmod']) {
  const fn = owner[name];
  if (fn) owner[name] = function (...args) { for (const p of /^(rename|copyFile|cp)/.test(name) ? args.slice(0, 2) : args.slice(0, 1)) if (!allowed(p)) return deny('fs.' + name, p); return fn.apply(this, args); };
}

// Fail closed: every required guard must actually refuse before the fixture loads.
for (const probe of [
  () => require('node:child_process').spawn('ssh', ['fixture.invalid']),
  () => electron.shell.openExternal('https://fixture.invalid'),
  () => electron.systemPreferences.askForMediaAccess('camera'),
  () => net.connect({ host: 'fixture.invalid', port: 443 }),
  () => electron.net.fetch('https://fixture.invalid'),
  () => fs.writeFileSync(path.join(path.dirname(profile), 'nhc-escape-probe'), 'x'),
]) { try { probe(); throw Error('Guard probe did not refuse'); } catch (error) { if (error.message === 'Guard probe did not refuse') throw error; } }

process.on('exit', (code) => {
  try {
    fs.writeFileSync(path.join(out, 'boundaries.json'), JSON.stringify({
      code, records, blocked, ownedPorts: [...ownedPorts], imports: [...imports],
      memoryClipboard: true, nativeInput: false, safeStorage: 'fixture-memory',
      sourceHashes: Object.fromEntries(['main.cjs', 'index.html', 'renderer.js', 'style.css', 'preload.cjs', 'preload.bundle.cjs',
        'hermes-remote.cjs', 'hermes-hub.cjs', 'hermes-view.js', 'hermes-conversation.cjs', 'hermes-session-wire.cjs']
        .map((f) => [f, crypto.createHash('sha256').update(fs.readFileSync(path.join(target, 'src', f))).digest('hex')])),
    }, null, 2));
  } catch { }
});
require(fixture ? path.resolve(fixture) : path.join(__dirname, 'native-hermes-driver.cjs'));

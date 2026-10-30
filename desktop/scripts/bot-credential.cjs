#!/usr/bin/env node
'use strict';
// Run as the broker owner, or root with --broker-uid. Output contains paths,
// identity and operation only; bearer credentials never reach stdout/argv.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { privateJson, registryFile } = require('../src/bot-auth.cjs');

const fileInside = (file, dir) => file === dir || file.startsWith(dir + path.sep);

function provisionUnlocked({ root, botId, uid, output, brokerUid = process.getuid?.(), apply = false }) {
  if (!Number.isInteger(brokerUid) || !Number.isInteger(uid) || uid <= 0 || uid === brokerUid) throw new Error('Use a separate non-root OS user for the bot.');
  if (!botId || botId.length > 100 || /[\x00-\x1f\x7f]/.test(botId)) throw new Error('Invalid bot identity.');
  root = fs.realpathSync(root); output = path.join(fs.realpathSync(path.dirname(output)), path.basename(output));
  const dir = fs.lstatSync(root), exportDir = fs.lstatSync(path.dirname(output));
  if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== brokerUid || (dir.mode & 0o077)) throw new Error('Broker directory must be private and owned by the broker user.');
  if (!exportDir.isDirectory() || exportDir.isSymbolicLink() || ![brokerUid, 0].includes(exportDir.uid) || (exportDir.mode & 0o022)) throw new Error('Export directory must be broker-owned, traversable by the bot, and not writable by bots.');
  for (const start of [root, path.dirname(output)]) for (let dir = start; ; dir = path.dirname(dir)) {
    const info = fs.lstatSync(dir);
    if (![brokerUid, 0].includes(info.uid) || ((info.mode & 0o022) && !(info.uid === 0 && (info.mode & 0o1000)))) throw new Error('Untrusted parent directory.');
    if (dir === path.dirname(dir)) break;
  }
  if (fileInside(output, root)) throw new Error('Export outside the private broker directory.');
  const connection = privateJson(path.join(root, 'connection.json'), brokerUid);
  const url = new URL(connection.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password) throw new Error('Invalid broker connection.');
  const file = registryFile(root);
  let registry;
  try { registry = privateJson(file, brokerUid); } catch (error) { if (error.code !== 'ENOENT') throw error; registry = { bots: {} }; }
  if (!registry.bots || typeof registry.bots !== 'object' || Array.isArray(registry.bots)) throw new Error('Invalid bot registry.');
  if (Object.hasOwn(registry.bots, botId) && registry.bots[botId].uid !== uid) throw new Error('Identity already belongs to another OS user.');
  if (Object.entries(registry.bots).some(([id, entry]) => id !== botId && entry.uid === uid)) throw new Error('Each untrusted bot needs its own OS user.');
  try { if (privateJson(output, uid).botId !== botId) throw new Error('Existing output belongs to another identity or is not a bot credential.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!apply) return { operation: Object.hasOwn(registry.bots, botId) ? 'rotate' : 'provision', botId, uid, registry: file, output, dryRun: true };
  const token = crypto.randomBytes(32).toString('hex');
  const staged = [];
  const stage = (destination, data, owner) => {
    const temp = path.join(path.dirname(destination), '.' + crypto.randomUUID() + '.tmp');
    const fd = fs.openSync(temp, 'wx', 0o600); staged.push(temp);
    try { fs.writeFileSync(fd, JSON.stringify(data, null, 2)); fs.fchownSync(fd, owner, -1); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    return temp;
  };
  try {
    Object.defineProperty(registry.bots, botId, { value: { uid, token, output }, enumerable: true, configurable: true, writable: true });
    const exported = stage(output, { url: connection.url, token, botId, protocol: 1 }, uid);
    const stored = stage(file, registry, brokerUid);
    fs.renameSync(exported, output);
    fs.renameSync(stored, file);
  } finally { for (const temp of staged) fs.rmSync(temp, { force: true }); }
  return { operation: 'provisioned', botId, uid, output, dryRun: false };
}

function provision(options) {
  if (!options.apply) return provisionUnlocked(options);
  if (process.getuid?.() !== 0) throw new Error('Apply requires root to assign credential ownership.');
  const lock = path.join(fs.realpathSync(options.root), 'bot-credentials.lock');
  const fd = fs.openSync(lock, 'wx', 0o600);
  try { return provisionUnlocked(options); }
  finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2), options = {};
    for (let n = 0; n < args.length; n++) {
      const arg = args[n];
      if (arg === '--apply') { options.apply = true; continue; }
      const key = { '--root': 'root', '--bot-id': 'botId', '--uid': 'uid', '--output': 'output', '--broker-uid': 'brokerUid' }[arg];
      if (!key || options[key] !== undefined || !args[n + 1]) throw new Error('Use --root DIR --bot-id ID --uid UID --output FILE [--broker-uid UID] [--apply].');
      options[key] = ['uid', 'brokerUid'].includes(key) ? Number(args[++n]) : args[++n];
    }
    console.log(JSON.stringify(provision(options)));
  } catch { console.error('Credential operation refused. Check paths, ownership and separate OS users; no credentials printed.'); process.exitCode = 1; }
}
module.exports = { provision };

#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { privateJson, registryFile } = require('../src/bot-auth.cjs');
const { provision } = require('./bot-credential.cjs');

function confirmedOffline(raw) {
  const url = new URL(raw);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password) throw new Error('Expected a loopback broker endpoint.');
  return new Promise((resolve, reject) => {
    const request = http.get(new URL('/v1/status', url), { agent: false }, response => {
      response.resume(); reject(new Error('Stop the broker before applying cleanup.'));
    });
    request.setTimeout(1500, () => request.destroy(new Error('Broker state is uncertain.')));
    request.on('error', error => error.code === 'ECONNREFUSED' ? resolve() : reject(new Error('Broker state is uncertain.')));
  });
}

async function cleanup({ root, logDir = root, brokerUid, apply = false }) {
  root = fs.realpathSync(root); logDir = fs.realpathSync(logDir);
  brokerUid ??= fs.lstatSync(root).uid;
  for (const dir of [root, logDir]) {
    const info = fs.lstatSync(dir);
    if (!info.isDirectory() || info.uid !== brokerUid || info.mode & 0o022) throw new Error('Unsafe data/log directory.');
  }
  const connection = privateJson(path.join(root, 'connection.json'), brokerUid);
  if (connection.botId) throw new Error('Use the broker data directory, not a bot export.');
  let registry = { bots: {} }, config = {};
  try { registry = privateJson(registryFile(root), brokerUid); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { config = privateJson(path.join(root, 'config.json'), brokerUid); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const bots = Object.entries(registry.bots);
  const actions = bots.map(([botId, record]) => {
    if (!record.output) throw new Error('Re-provision older bot exports before cleanup.');
    return provision({ root, brokerUid, botId, uid: record.uid, output: record.output });
  });
  const removals = [];
  const inspect = (file, operation, credential = false) => {
    let info;
    try { info = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== brokerUid) throw new Error('Unsafe cleanup target.');
    if (credential) privateJson(file, brokerUid);
    actions.push({ operation, file }); removals.push({ file, info });
  };
  for (const name of ['main.log', 'main.log.old', 'stderr.log', 'stderr.log.old']) inspect(path.join(logDir, name), 'delete-old-log');
  inspect(path.join(root, 'connection.json'), 'rotate-broker-on-restart', true);
  const appToken = config.appTokenFile || path.join(root, 'app-token.json');
  if (!path.isAbsolute(appToken)) throw new Error('App token path must be absolute.');
  inspect(appToken, 'rotate-human-on-restart', true);
  if (!apply) return { dryRun: true, actions };
  if (process.getuid?.() !== 0) throw new Error('Apply requires root for credential ownership.');
  await confirmedOffline(connection.url);
  for (const [botId, record] of bots) provision({ root, brokerUid, botId, uid: record.uid, output: record.output, apply: true });
  for (const { file, info } of removals) {
    const current = fs.lstatSync(file);
    if (!current.isFile() || current.dev !== info.dev || current.ino !== info.ino || current.mtimeMs !== info.mtimeMs || current.size !== info.size) throw new Error('Cleanup target changed; refusing deletion.');
    fs.unlinkSync(file);
  }
  return { dryRun: false, actions, next: 'Start the broker to mint new broker/human credentials; re-provision exports if its loopback port changed.' };
}

if (require.main === module) {
  const args = process.argv.slice(2), options = {};
  try {
    for (let n = 0; n < args.length; n++) {
      if (args[n] === '--apply') { options.apply = true; continue; }
      const key = { '--root': 'root', '--log-dir': 'logDir', '--broker-uid': 'brokerUid' }[args[n]];
      if (!key || options[key] !== undefined || !args[n + 1]) throw new Error('Invalid arguments.');
      options[key] = key === 'brokerUid' ? Number(args[++n]) : args[++n];
    }
    cleanup(options).then(result => console.log(JSON.stringify(result)), () => {
      console.error('Cleanup refused. Verify the broker is stopped, ownership and paths. Earlier rotations may have completed; rerun safely. No credentials printed.'); process.exitCode = 1;
    });
  } catch { console.error('Use --root BROKER_DATA [--log-dir LOG_DIR] [--broker-uid UID] [--apply]. Dry-run is the default.'); process.exitCode = 1; }
}
module.exports = { cleanup, confirmedOffline };

'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { isAuthorized } = require('./core.cjs');

function privateJson(file, uid = process.getuid?.()) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.size > 1000000 || (uid !== undefined && (info.uid !== uid || (info.mode & 0o077)))) throw new Error('Unsafe credential file.');
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally { fs.closeSync(fd); }
}

// Every API path binds the asserted identity before ownership/overseer checks.
// Reread on each call so revocation takes effect without restarting the broker.
function authorizeBot(file, authorization, botId) {
  if (typeof botId !== 'string' || !botId || botId.length > 100 || /[\x00-\x1f\x7f]/.test(botId)) return false;
  try {
    const bots = privateJson(file).bots;
    const record = bots?.[botId];
    if (!record || Object.values(bots).filter(item => (item?.token === record.token || item?.uid === record.uid)).length !== 1) return false;
    return !!record && Number.isInteger(record.uid) && record.uid > 0 && record.uid !== process.getuid?.()
      && typeof record.token === 'string' && /^[a-f0-9]{64}$/.test(record.token) && isAuthorized(authorization, record.token);
  } catch { return false; }
}

function approvalIdentity(file, authorization, botId, brokerToken) {
  if (isAuthorized(authorization, brokerToken)) return undefined;
  return {
    generation: require('node:crypto').createHash('sha256').update(String(authorization || '')).digest('hex'),
    valid: () => authorizeBot(file, authorization, botId),
  };
}

function registryFile(root) { return path.join(root, 'bot-credentials.json'); }
module.exports = { privateJson, authorizeBot, approvalIdentity, registryFile };

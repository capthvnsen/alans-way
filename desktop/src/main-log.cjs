'use strict';

// Append-only main-process log, one old file kept. Nothing here may throw:
// logging must never be the reason the app misbehaves.
const fs = require('node:fs');
const path = require('node:path');

const MAX_BYTES = 1000000;

function createLog(dir, { maxBytes = MAX_BYTES, now = () => new Date() } = {}) {
  const file = path.join(dir, 'main.log');
  function write(label, detail = '') {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const line = `${now().toISOString()} ${label}${detail ? `: ${detail}` : ''}\n`;
      if (fs.existsSync(file) && fs.statSync(file).size + line.length > maxBytes) fs.renameSync(file, `${file}.old`);
      fs.appendFileSync(file, line);
    } catch {}
  }
  function tail(lines = 100) {
    try { return fs.readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).join('\n'); } catch { return ''; }
  }
  return { file, write, tail };
}

module.exports = { createLog };

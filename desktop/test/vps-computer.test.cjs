const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

test('the Linux desktop helper compiles', () => {
  const script = path.join(__dirname, '../scripts/vps-computer.py');
  const result = spawnSync('python3', ['-m', 'py_compile', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

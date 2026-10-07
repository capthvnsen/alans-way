const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');

const script = path.join(__dirname, '../scripts/vps-computer.py');

test('the Linux desktop helper compiles', () => {
  const result = spawnSync('python3', ['-m', 'py_compile', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('the Linux desktop helper passes its pure-logic selftest without a display', () => {
  const result = spawnSync('python3', [script, 'selftest'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const reply = JSON.parse(result.stdout);
  assert.equal(reply.ok, true);
  assert.ok(reply.checks >= 15);
});

test('once answers a bad request with a coded failure', () => {
  const result = spawnSync('python3', [script, 'once'], { encoding: 'utf8', input: '{"id":3,"cmd":"bogus"}\n' });
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout), { ok: false, error: 'unknown command bogus', code: 'bad_request', id: 3 });
  const junk = spawnSync('python3', [script, 'once'], { encoding: 'utf8', input: 'nope\n' });
  assert.equal(JSON.parse(junk.stdout).code, 'bad_request');
});

test('serve answers each line in order and exits on EOF', async () => {
  const child = spawn('python3', [script, 'serve'], { stdio: ['pipe', 'pipe', 'inherit'], env: { PATH: process.env.PATH } });
  let out = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stdin.write('{"id":1,"cmd":"init","policy":{"exact":["keepassxc"],"contains":["1password"]}}\n');
  child.stdin.write('garbage\n');
  child.stdin.write('{"id":"a","cmd":"selftest"}\n');
  child.stdin.write('{"id":2,"cmd":"act","pid":0,"steps":[{"action":"press","ref":"c1"}]}\n');
  child.stdin.end();
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(code, 0);
  const lines = out.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(lines[0], { ok: true, protocol: 2, id: 1 });
  assert.equal(lines[1].code, 'bad_request');
  assert.equal(lines[2].ok, true);
  assert.equal(lines[2].id, 'a');
  assert.equal(lines[3].id, 2);
  assert.equal(lines[3].code, 'not_found');
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { cleanup, confirmedOffline } = require('../scripts/cleanup-workspace-logs.cjs');

test('cleanup is dry-run, reads no raw log contents and limits deletion to known logs', { skip: !process.getuid }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'old-logs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'connection.json'), JSON.stringify({ url: 'http://127.0.0.1:9465', token: 'synthetic-broker-secret' }), { mode: 0o600 });
  for (const name of ['main.log', 'main.log.old', 'keep.txt']) fs.writeFileSync(path.join(root, name), 'synthetic-raw-secret');
  const result = await cleanup({ root });
  assert.equal(result.dryRun, true);
  assert.deepEqual(result.actions.filter(action => action.operation === 'delete-old-log').map(action => path.basename(action.file)), ['main.log', 'main.log.old']);
  assert.doesNotMatch(JSON.stringify(result), /synthetic/);
  for (const name of ['connection.json', 'main.log', 'main.log.old', 'keep.txt']) assert.equal(fs.existsSync(path.join(root, name)), true);
  fs.unlinkSync(path.join(root, 'main.log')); fs.symlinkSync(path.join(root, 'keep.txt'), path.join(root, 'main.log'));
  await assert.rejects(cleanup({ root }), /Unsafe cleanup target/);
});

test('only confirmed connection refusal counts as offline; a live unauthorized broker is active', async t => {
  const server = http.createServer((_req, res) => { res.writeHead(401); res.end(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  await assert.rejects(confirmedOffline(url), /Stop the broker/);
  await new Promise(resolve => server.close(resolve));
  await confirmedOffline(url);
  assert.throws(() => confirmedOffline('http://203.0.113.1'), /loopback/);
});

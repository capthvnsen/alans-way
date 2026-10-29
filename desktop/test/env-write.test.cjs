const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { command } = require('../src/env-write.cjs');

test('remote env transaction preserves content and refuses uncertain or conflicting files', { skip: process.platform === 'win32' }, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-transaction-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, '.env');
  const update = (target = file) => spawnSync('sh', ['-c', command], { encoding: 'utf8', input: JSON.stringify({ path: target, key: 'ANTHROPIC_API_KEY', value: "synthetic-$&-'" }) });
  assert.equal(update().status, 0, 'confirmed missing file is created');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const prior = '# retained\nOTHER=' + 'x'.repeat(30000) + '\nexport ANTHROPIC_API_KEY=old\n';
  fs.writeFileSync(file, prior);
  assert.equal(update().status, 0);
  assert.ok(fs.readFileSync(file, 'utf8').startsWith(prior.slice(0, prior.indexOf('export '))));
  assert.match(fs.readFileSync(file, 'utf8'), /synthetic-\$&-/);
  assert.equal(fs.readFileSync(file, 'utf8').includes('=old'), false);
  for (const content of ['ANTHROPIC_API_KEY=a\nANTHROPIC_API_KEY=b\n', Buffer.from([0xff]), 'x'.repeat(1048577)]) {
    fs.writeFileSync(file, content);
    assert.notEqual(update().status, 0);
    assert.deepEqual(fs.readFileSync(file), Buffer.from(content));
  }
  const link = path.join(dir, 'linked');
  fs.symlinkSync(file, link);
  assert.notEqual(update(link).status, 0);
  assert.notEqual(update(path.join(dir, 'absent', '.env')).status, 0);
  assert.notEqual(update(dir).status, 0);
});


test('profile inventory distinguishes bare installs from failed reads', { skip: process.platform === 'win32' }, t => {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'env-profiles-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const root=path.join(home,'.hermes');fs.mkdirSync(root);
  const inventory=()=>spawnSync('sh',['-c',require('../src/env-write.cjs').profileInventoryCommand],{encoding:'utf8',env:{...process.env,HOME:home}});
  assert.equal(inventory().status,0);assert.equal(inventory().stdout,'');
  fs.mkdirSync(path.join(root,'profiles'));fs.mkdirSync(path.join(root,'profiles','personal'));
  assert.equal(inventory().stdout,'personal\n');
  fs.rmSync(path.join(root,'profiles'),{recursive:true});fs.writeFileSync(path.join(root,'profiles'),'invalid');
  assert.notEqual(inventory().status,0);
  fs.rmSync(root,{recursive:true});assert.notEqual(inventory().status,0);
});

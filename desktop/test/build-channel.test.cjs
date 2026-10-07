const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describeBuild, normalizeBuildInfo, readBuildInfo } = require('../src/build-channel.cjs');

const base = { commit: 'abc1234', dirty: false, builtAt: '2026-10-06T12:00:00.000Z' };

test('release and main builds read as Production', () => {
  for (const channel of ['release', 'main']) {
    const badge = describeBuild({ ...base, channel });
    assert.equal(badge.text, 'Production');
    assert.equal(badge.tone, 'prod');
    assert.match(badge.title, /abc1234/);
    assert.match(badge.title, /2026-10-06/);
  }
});
test('a release candidate reads as Pre-release', () => {
  assert.deepEqual({ ...describeBuild({ ...base, channel: 'prerelease' }), title: '' }, { text: 'Pre-release', tone: 'pre', title: '' });
});
test('a dev build shows its commit and flags local changes', () => {
  assert.deepEqual(describeBuild({ ...base, channel: 'dev' }).text, 'Dev · abc1234');
  assert.equal(describeBuild({ ...base, channel: 'dev' }).tone, 'dev');
  assert.equal(describeBuild({ ...base, channel: 'dev', dirty: true }).text, 'Dev · abc1234 + local changes');
});
test('a dev build with no commit is just Dev', () => {
  assert.equal(describeBuild({ channel: 'dev' }).text, 'Dev');
  assert.equal(describeBuild({ channel: 'dev', dirty: true }).text, 'Dev + local changes');
});
test('unknown or garbled info falls back to dev', () => {
  for (const raw of [null, undefined, 42, 'x', [], {}, { channel: 'production' }, { channel: 7 }]) {
    assert.equal(normalizeBuildInfo(raw).channel, 'dev', JSON.stringify(raw));
    assert.equal(describeBuild(raw).tone, 'dev');
  }
  assert.deepEqual(normalizeBuildInfo({ channel: 'main', commit: { a: 1 }, dirty: 'yes', builtAt: 5 }), { channel: 'main', commit: '', dirty: false, builtAt: '' });
});
test('readBuildInfo treats a missing or garbled file as dev', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-info-'));
  try {
    assert.deepEqual(readBuildInfo(path.join(dir, 'missing.json')), { channel: 'dev', commit: '', dirty: false, builtAt: '' });
    fs.writeFileSync(path.join(dir, 'bad.json'), '{not json');
    assert.equal(readBuildInfo(path.join(dir, 'bad.json')).channel, 'dev');
    fs.writeFileSync(path.join(dir, 'ok.json'), JSON.stringify({ ...base, channel: 'main', version: '0.3.0' }));
    assert.deepEqual(readBuildInfo(path.join(dir, 'ok.json')), { ...base, channel: 'main' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

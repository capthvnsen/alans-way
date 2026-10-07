const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildInfo } = require('../scripts/build-info.cjs');

const NOW = new Date('2026-10-06T12:00:00.000Z');
function fakeGit({ sha = 'abc1234', dirty = false, onMain = true, broken = false } = {}) {
  return (args) => {
    if (broken) throw new Error('git: not found');
    const cmd = args.join(' ');
    if (cmd === 'rev-parse --short HEAD') return `${sha}\n`;
    if (cmd === 'status --porcelain') return dirty ? ' M desktop/src/main.cjs\n' : '';
    if (cmd === 'merge-base --is-ancestor HEAD origin/main') { if (!onMain) throw new Error('exit 1'); return ''; }
    throw new Error(`unexpected git ${cmd}`);
  };
}
const run = (opts) => buildInfo({ version: '0.3.0', now: NOW, env: {}, git: fakeGit(), ...opts });

test('a final release tag is the release channel', () => {
  const info = run({ env: { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v0.3.0' } });
  assert.deepEqual(info, { channel: 'release', version: '0.3.0', commit: 'abc1234', dirty: false, builtAt: '2026-10-06T12:00:00.000Z' });
});
test('a release candidate tag is the prerelease channel', () => {
  assert.equal(run({ env: { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v0.3.0-rc.2' } }).channel, 'prerelease');
});
test('a tag that does not match the package version is not a release', () => {
  assert.equal(run({ env: { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v0.4.0' } }).channel, 'main');
  assert.equal(run({ env: { GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'v0.3.0' } }).channel, 'main');
});
test('a clean checkout contained in origin/main is main', () => {
  assert.equal(run().channel, 'main');
});
test('unpushed commits are dev', () => {
  assert.equal(run({ git: fakeGit({ onMain: false }) }).channel, 'dev');
});
test('a dirty tree is dev and says so', () => {
  const info = run({ git: fakeGit({ dirty: true }) });
  assert.equal(info.channel, 'dev');
  assert.equal(info.dirty, true);
});
test('no git or no origin/main is dev', () => {
  const info = run({ git: fakeGit({ broken: true }) });
  assert.equal(info.channel, 'dev');
  assert.equal(info.commit, '');
});
test('a tarball made by the install scripts is main without git', () => {
  assert.equal(run({ git: fakeGit({ broken: true }), tarball: true }).channel, 'main');
});

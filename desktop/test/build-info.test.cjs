const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildInfo } = require('../scripts/build-info.cjs');
const { describeBuild } = require('../src/build-channel.cjs');

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

// npm version in release.yml changes only these three version fields before
// prepackage runs build-info. Model both HEAD and the stamped working files.
function workflowState(version, { edit, staged = false } = {}) {
  const files = {
    'desktop/package.json': { name: 'badge-fixture', version: '0.21.5' },
    'desktop/package-lock.json': { name: 'badge-fixture', version: '0.21.5', lockfileVersion: 3, packages: { '': { name: 'badge-fixture', version: '0.21.5' } } },
  };
  const working = structuredClone(files);
  working['desktop/package.json'].version = version;
  working['desktop/package-lock.json'].version = version;
  working['desktop/package-lock.json'].packages[''].version = version;
  if (edit === 'package') working['desktop/package.json'].description = 'local edit';
  if (edit === 'lock') working['desktop/package-lock.json'].packages['node_modules/local'] = { version: '1.0.0' };
  if (edit === 'lock-root') working['desktop/package-lock.json'].packages[''].version = '0.99.0';
  const changed = Object.keys(files).filter(file => JSON.stringify(files[file]) !== JSON.stringify(working[file]));
  if (edit === 'source') changed.push('desktop/src/main.cjs');
  return {
    version,
    env: { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: `v${version}` },
    readFile: file => JSON.stringify(working[file]),
    git: args => {
      if (args[0] === 'show' && args[1].startsWith('HEAD:')) return JSON.stringify(files[args[1].slice(5)]);
      if (args.join(' ') === 'status --porcelain') return changed.map(file => `${staged ? 'M ' : ' M'} ${file}`).join('\n');
      return fakeGit({ onMain: false })(args);
    },
  };
}

test('release workflow stamps v0.21.5-rc.1 as Pre-release with its version', () => {
  const info = run(workflowState('0.21.5-rc.1'));
  assert.equal(info.channel, 'prerelease');
  assert.equal(info.version, '0.21.5-rc.1');
  assert.equal(info.dirty, false);
  assert.equal(describeBuild(info).text, 'Pre-release 0.21.5-rc.1');
});
test('release workflow stamps final v0.21.5 as release', () => {
  const info = run(workflowState('0.21.5'));
  assert.equal(info.channel, 'release');
  assert.equal(info.dirty, false);
  assert.equal(describeBuild(info).text, 'Production');
});
test('real local edits stay Dev even with a matching release tag', () => {
  for (const version of ['0.21.5', '0.21.5-rc.1']) {
    for (const edit of ['source', 'package', 'lock', 'lock-root']) {
      for (const staged of [false, true]) {
        const info = run(workflowState(version, { edit, staged }));
        assert.equal(info.channel, 'dev', `${version} ${edit} staged=${staged}`);
        assert.equal(info.dirty, true);
        assert.equal(describeBuild(info).text, 'Dev · abc1234 + local changes');
      }
    }
  }
});
test('a version stamp without a tag is still a dirty dev build', () => {
  const info = run({ ...workflowState('0.21.5-rc.1'), env: {} });
  assert.equal(info.channel, 'dev');
  assert.equal(info.dirty, true);
  assert.equal(describeBuild(info).text, 'Dev · abc1234 + local changes');
});
test('staged stamps and untracked package files are not workflow changes', () => {
  for (const status of ['M  desktop/package.json', '?? desktop/package.json']) {
    const state = workflowState('0.21.5-rc.1');
    const info = run({ ...state, git: args => args[0] === 'status' ? status : state.git(args) });
    assert.equal(info.channel, 'dev');
    assert.equal(info.dirty, true);
  }
});
test('unreadable package files or git metadata cannot hide local changes', () => {
  const state = workflowState('0.21.5-rc.1');
  const broken = () => { throw new Error('unreadable fixture'); };
  for (const opts of [{ readFile: broken }, { git: args => args[0] === 'show' || args[0] === 'status' ? broken() : state.git(args) }]) {
    const info = run({ ...state, ...opts });
    assert.equal(info.channel, 'dev');
    assert.equal(info.dirty, true);
  }
});
test('a different RC stamp or malformed tag cannot claim a release', () => {
  for (const tag of ['v0.21.5', 'v0.21.5-rc.2', 'v0.21.6-rc.1', 'v0.21.5-beta.1']) {
    const info = run({ ...workflowState('0.21.5-rc.1'), env: { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: tag } });
    assert.equal(info.channel, 'dev', tag);
    assert.equal(info.dirty, true);
  }
});

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

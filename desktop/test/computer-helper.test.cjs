const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pickHelper } = require('../src/computer.cjs');

const base = { binary: '/c/mac-computer', source: '/c/mac-computer.swift', bundled: '/app/mac-computer' };
const fs = (files) => ({ exists: (p) => p in files, mtime: (p) => files[p] });

test('a fresh local helper is used as is', () => {
  const f = fs({ '/c/mac-computer': 2, '/c/mac-computer.swift': 1 });
  assert.equal(pickHelper({ ...base, ...f, compile: () => assert.fail('no compile') }), '/c/mac-computer');
});
test('a stale helper is rebuilt when swiftc works', () => {
  const f = fs({ '/c/mac-computer': 1, '/c/mac-computer.swift': 2 });
  assert.equal(pickHelper({ ...base, ...f, compile: () => true }), '/c/mac-computer');
});
test('without swiftc the app bundle helper is used', () => {
  const f = fs({ '/c/mac-computer.swift': 2, '/app/mac-computer': 1 });
  assert.equal(pickHelper({ ...base, ...f, compile: () => false }), '/app/mac-computer');
});
test('without swiftc a stale local helper beats nothing', () => {
  const f = fs({ '/c/mac-computer': 1, '/c/mac-computer.swift': 2 });
  assert.equal(pickHelper({ ...base, ...f, compile: () => false }), '/c/mac-computer');
});
test('no helper and no compiler is an error', () => {
  assert.throws(() => pickHelper({ ...base, ...fs({ '/c/mac-computer.swift': 1 }), compile: () => false }), /Mac computer helper/);
});

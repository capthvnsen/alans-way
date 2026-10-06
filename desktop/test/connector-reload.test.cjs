const { test } = require('node:test');
const assert = require('node:assert/strict');
const { connectorReplaced } = require('../src/connector-reload.cjs');

test('a newer connector file is a reason to exit after the current call', () => {
  const startup = { '/scripts/browser-mcp.cjs': 10, '/src/computer.cjs': 10 };
  assert.equal(connectorReplaced(startup, startup), false);
  assert.equal(connectorReplaced(startup, { ...startup, '/src/computer.cjs': 11 }), true);
  assert.equal(connectorReplaced(startup, { '/scripts/browser-mcp.cjs': 10 }), false);
});

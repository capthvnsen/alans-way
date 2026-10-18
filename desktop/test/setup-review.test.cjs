'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// No-window regression of the verbatim clipboard branch, with explicit fake
// clipboard/platform seams. Electron tests cover the complete IPC and UI path.
const source = fs.readFileSync(path.join(__dirname, '../src/main.cjs'), 'utf8');
const branch = source.slice(source.indexOf("      case 'agent-setup': {"), source.indexOf("      case 'agent-prompt': {"));
function copy(value, overrides = {}, hostLabel = 'mac') {
  const writes = [];
  const context = {
    value, prefs: { bots: [{ id: '101', name: 'Cedar', username: 'cedar_fixture_bot' }], selectedBotId: '101', macSshHost: 'you@your-computer', vpsBrowser: { sshHost: 'you@your-agent-machine' }, ...overrides },
    clipboard: { writeText: text => writes.push(text) },
    HOST_LABEL: hostLabel, app: { getVersion: () => '0.0.0-test' },
    seedMacSshHost() {}, Intl,
  };
  vm.runInNewContext(`switch ('agent-setup') { ${branch} }`, context);
  return writes;
}
test('legacy agent-setup copies review notes with installed-skill pins and explicit human handoffs', () => {
  const [text] = copy({ botId: '101' });
  assert.doesNotMatch(text, /curl|\|\s*(?:ba)?sh|raw\.githubusercontent|--restart/);
  assert.match(text, /review notes.*not shell commands/i);
  assert.match(text, /BOT_ID=101/);
  assert.match(text, /@cedar_fixture_bot/);
  assert.match(text, /MAC_SSH=you@your-computer/);
  assert.match(text, /AGENT_SSH=you@your-agent-machine/);
  assert.match(text, /installed workspace-setup skill/);
  assert.match(text, /reviewed.*pins/);
  assert.match(text, /cannot.*pin.*stop/i);
  assert.match(text, /reviewed catalog/);
  assert.match(text, /wait for.*repl/i);
  assert.match(text, /restart last/i);
  assert.match(text, /Save addresses.*Check saved path/);
});
test('legacy callers without explicit bot keep the selected known bot; stale, empty and altered IDs cannot copy', () => {
  assert.match(copy(undefined)[0], /BOT_ID=101/);
  for (const value of [{ botId: '999' }, { botId: '' }, { botId: '10!1' }]) assert.throws(() => copy(value), /Choose an available bot/);
  assert.throws(() => copy(undefined, { bots: [], selectedBotId: '' }), /Choose an available bot/);
});
test('missing addresses are explicit and copy does not discover or provision a host', () => {
  const [text] = copy({ botId: '101' }, { macSshHost: '', vpsBrowser: {} });
  assert.match(text, /MAC_SSH=not saved/);
  assert.match(text, /AGENT_SSH=not saved/);
  assert.doesNotMatch(text, /undefined|null/);
  assert.doesNotMatch(branch, /seedMacSshHost|spawn\(|exec/);
});
test('review notes keep the platform explicit for Mac, Windows and Linux', () => {
  for (const hostLabel of ['mac', 'windows', 'linux']) assert.match(copy({ botId: '101' }, {}, hostLabel)[0], new RegExp(`Computer OS: ${hostLabel}`));
});
test('renderer labels describe review notes and no terminal procedure substitute', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8');
  const setup = renderer.slice(renderer.indexOf('function mountAgentSetup('), renderer.indexOf('function mountSettingsUpdates('));
  assert.match(setup, /Copy setup review notes/);
  assert.match(setup, /Review notes copied for/);
  assert.match(setup, /Read them before guided setup/);
  assert.doesNotMatch(setup, /Copy setup command|Use the setup command instead|Command copied|Paste in a terminal/);
});

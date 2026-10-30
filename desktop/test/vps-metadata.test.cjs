const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { redactTabForBot } = require('../src/core.cjs');

const source = fs.readFileSync(path.join(__dirname, '../src/main.cjs'), 'utf8');
const held = { id: 'vps-held', botId: 'bot-a', controller: 'human', url: 'https://private.example/document?access=synthetic', title: 'Private title', favicon: 'private-icon', handoff: { note: 'private note' } };

function assertPrivate(tab) {
  assert.equal(tab.url, 'https://private.example');
  assert.equal(tab.title, '');
  assert.equal(tab.favicon, '');
  assert.equal(tab.handoff.note, '');
}

test('the desktop redacts cached VPS tabs before listing them to bots', async () => {
  const start = source.indexOf("      if (url.pathname === '/v1/tabs' && req.method === 'GET')");
  const end = source.indexOf("      if (url.pathname === '/v1/tabs' && req.method === 'POST')", start);
  const run = vm.runInNewContext(`async () => { ${source.slice(start, end)} }`, {
    url: { pathname: '/v1/tabs' }, req: { method: 'GET' }, botId: 'bot-a', overseer: false,
    tabs: new Map(), vpsTabs: new Map([[held.id, held]]), prefs: {}, redactTabForBot,
    send: (_status, body) => body,
  });
  const result = await run();
  assert.equal(result.tabs.length, 1);
  assertPrivate(result.tabs[0]);
  assert.equal(held.title, 'Private title', 'the human UI cache stays complete');
});

test('the desktop redacts direct and nested tab metadata from older VPS hosts', async () => {
  const start = source.indexOf('      if(match&&!tab&&isVpsTab(match[1])){');
  const end = source.indexOf('      if (!tab || tab.extensionPage', start);
  for (const result of [held, { tab: held }]) {
    const run = vm.runInNewContext(`async () => { ${source.slice(start, end)} }`, {
      match: [null, held.id], tab: undefined, isVpsTab: () => true,
      req: { method: 'GET', headers: {} }, url: { pathname: `/v1/tabs/${held.id}`, search: '' },
      vpsBrowser: { request: async () => result }, vpsTabs: new Map(), botId: 'bot-a', nameForBot: () => '',
      broadcast() {}, redactTabForBot, send: (_status, body) => body,
    });
    const reply = await run();
    assertPrivate(reply.tab || reply);
  }
});

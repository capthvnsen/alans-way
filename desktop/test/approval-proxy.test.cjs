const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
// Execute the actual main HTTP proxy branch; the Electron route integration
// separately covers admission, transport and independent remote POST counters.
const source = fs.readFileSync(path.join(__dirname, '../src/main.cjs'), 'utf8');
const start = source.indexOf('      if(match&&!tab&&isVpsTab(match[1])){');
const end = source.indexOf('      if (!tab || tab.extensionPage', start);
assert.ok(start > 0 && end > start);
const run = new (Object.getPrototypeOf(async function () {}).constructor)('body', 'vpsBrowser', 'prefs', `
  const req={method:'POST',headers:{}}, match=['','remote','actions'], tab=undefined,
    url=new URL('http://local/v1/tabs/remote/actions'), botId='fixture', vpsTabs=new Map();
  const isVpsTab=()=>true, readJson=async()=>body, nameForBot=()=>'', broadcast=()=>{}, send=(status,data)=>({status,data});
  ${source.slice(start, end)}
`);

for (const mode of ['old', 'missing', 'fault', 'current', 'changed']) test(`remote approval checks actual backend capability: ${mode}`, async () => {
  const calls = [], prefs = { vpsBrowser: { sshHost: 'fixture-a' } };
  const vpsBrowser = { request: async (path, method, body) => {
    calls.push({ path, method, body });
    if (path === '/v1/status') {
      if (mode === 'fault') throw Error('offline');
      if (mode === 'changed') prefs.vpsBrowser.sshHost = 'fixture-b';
      return mode === 'missing' ? {} : { capabilities: mode === 'old' ? ['tabs'] : ['approval-binding-v1'] };
    }
    return { dispatched: true };
  } };
  const body = { action: 'click', ref: 'e1', approval: { nonce: 'fixture' } };
  if (mode === 'current') assert.equal((await run(body, vpsBrowser, prefs)).status, 200);
  else await assert.rejects(run(body, vpsBrowser, prefs), /approval_binding_unavailable:.*Update.*fresh snapshot/);
  assert.equal(calls.filter(c => c.method === 'POST').length, mode === 'current' ? 1 : 0);
  calls.length = 0;
  assert.equal((await run({ action: 'navigate', url: 'https://fixture.example/guide' }, vpsBrowser, prefs)).status, 200);
  assert.deepEqual(calls.map(c => c.path), ['/v1/tabs/remote/actions'], 'ordinary forwarding requires no stronger capability');
});

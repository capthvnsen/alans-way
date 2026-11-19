'use strict';
// Shared by the vault fill tests: a Hermes-faithful fill request and a fake agent tab.
const { INSPECT, FILL } = require('../src/vault-scripts.cjs');

// A password with every character that could break a naive substitution or a JSON round trip.
const PW = 'CANARY-7c1e9a-$&-$\'-"q"-\\-é- ';
const ORIGIN = 'https://example.com';
const NONCE = '0123456789abcdef';

// Python's json.dumps default: ensure_ascii, ", " and ": " separators — what Hermes actually sends.
function pyDumps(v) {
  if (typeof v === 'string') return JSON.stringify(v).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  if (Array.isArray(v)) return `[${v.map(pyDumps).join(', ')}]`;
  if (v && typeof v === 'object') return `{${Object.entries(v).map(([k, x]) => `${pyDumps(k)}: ${pyDumps(x)}`).join(', ')}}`;
  return JSON.stringify(v);
}
// Function replacers: a `$&` in the password must stay literal, as Python's str.replace keeps it.
const inspectJs = (nonce = NONCE) => INSPECT.replace('__NONCE__', () => pyDumps(nonce));
const fillJs = ({ origin = ORIGIN, fills = [{ index: 1, token: 'current-password', value: PW }], nonce = NONCE } = {}) =>
  FILL.replace('__EXPECTED_ORIGIN__', () => pyDumps(origin)).replace('__FILLS__', () => pyDumps(fills)).replace('__NONCE__', () => pyDumps(nonce));

const originOf = (url) => { try { return new URL(url).origin; } catch { return 'null'; } };

// A fake agent tab shaped like main.cjs's. Page scripts run the way vault-fill runs them: over CDP, in an
// isolated world of the main frame. A script sent to the main world throws, so a test sees it.
function makeTab({ id = 't1', botId = 'bot1', url = `${ORIGIN}/login`, controller = 'agent' } = {}) {
  const frame = { url, origin: originOf(url), detached: false, ran: [], isDestroyed: () => false,
    executeJavaScript: async () => { throw new Error('the main world must not run a vault script'); } };
  const wc = { url, getURL: () => wc.url, mainFrame: frame, destroyed: false, isDestroyed: () => wc.destroyed, isCrashed: () => false,
    executeJavaScript: async () => { throw new Error('the main world must not run a vault script'); } };
  const tab = { id, botId, controller, owner: 'bot', epoch: 1, generation: 1, documentSeq: 1, navigationUrl: '', recoveryUrl: '', error: '', extensionPage: false, localPdf: false,
    view: { webContents: wc }, frame, wc, worlds: [], cleared: [],
    page: { inspect: () => JSON.stringify([{ autocomplete: 'current-password', formIndex: 0, index: 1, maxLength: null, label: 'Password', name: 'pw login', type: 'password' },
      { autocomplete: 'username', formIndex: 0, index: 0, maxLength: null, label: 'Email address', name: 'user', type: 'text' }]), fill: () => '{"filled":1}', clear: () => '{}', controlled: false },
    go(next) { wc.url = next; frame.url = next; frame.origin = originOf(next); tab.generation++; tab.documentSeq++; },
    async cdp(method, params) {
      if (method === 'Network.disable') { tab.networkDisabled = (tab.networkDisabled || 0) + 1; return {}; }
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main-frame' } } };
      if (method === 'Page.createIsolatedWorld') { tab.worlds.push(params); return { executionContextId: 100 + tab.worlds.length }; }
      if (method !== 'Runtime.evaluate' || !(params.contextId > 100) || params.returnByValue !== true) throw new Error(`unexpected ${method}`);
      const code = params.expression;
      if (code.includes('// vault-clear')) { tab.cleared.push(code); return { result: { value: tab.page.clear(code) } }; }
      if (code.includes('serviceWorker')) { tab.swChecks = (tab.swChecks || 0) + 1; return { result: { value: tab.page.sw ? tab.page.sw(code) : JSON.stringify({ controlled: tab.page.controlled }) } }; }
      frame.ran.push(code);
      return { result: { value: code.includes('const expectedOrigin') ? tab.page.fill(code) : tab.page.inspect(code) } };
    } };
  return tab;
}

module.exports = { PW, ORIGIN, NONCE, pyDumps, inspectJs, fillJs, makeTab, originOf };

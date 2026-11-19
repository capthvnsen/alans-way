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

function makeTab({ id = 't1', botId = 'bot1', url = `${ORIGIN}/login`, controller = 'agent' } = {}) {
  const frame = { url, detached: false, ran: [], isDestroyed: () => false };
  const wc = { url, getURL: () => wc.url, mainFrame: frame, destroyed: false, isDestroyed: () => wc.destroyed, isCrashed: () => false };
  const tab = { id, botId, controller, owner: 'bot', epoch: 1, generation: 1, navigationUrl: '', recoveryUrl: '', error: '', extensionPage: false, localPdf: false,
    view: { webContents: wc }, frame, wc,
    page: { inspect: () => JSON.stringify([{ autocomplete: 'current-password', formIndex: 0, index: 1, maxLength: null, label: 'Password', name: 'pw login', type: 'password' },
      { autocomplete: 'username', formIndex: 0, index: 0, maxLength: null, label: 'Email address', name: 'user', type: 'text' }]), fill: () => '{"filled":1}' },
    go(next) { wc.url = next; frame.url = next; tab.generation++; } };
  frame.executeJavaScript = async (code) => {
    frame.ran.push(code);
    return code.includes('const expectedOrigin') ? tab.page.fill(code) : tab.page.inspect(code);
  };
  return tab;
}

module.exports = { PW, ORIGIN, NONCE, pyDumps, inspectJs, fillJs, makeTab };

const test = require('node:test');
const assert = require('node:assert/strict');
const { createVpsBrowser } = require('../src/vps-browser.cjs');

test('VPS SSH failures include a bounded stderr tail', async () => {
  const browser = createVpsBrowser({ getConfig: () => ({ sshHost: '127.0.0.1', scriptPath: '/nonexistent/vps-browser-host.cjs', sudo: false }) });
  await assert.rejects(
    () => browser.request('/v1/status'),
    (error) => error.message.includes('VPS browser SSH unavailable') && /127\.0\.0\.1|Connection refused|connect/i.test(error.message),
  );
});

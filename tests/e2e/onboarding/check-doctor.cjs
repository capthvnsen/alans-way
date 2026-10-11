'use strict';
// Feeds the server's --doctor JSON (stdin) through the app's own Check setup
// logic and fails on any warn/fail row. Computer and connection facts that a
// container cannot produce (Telegram sign-in, SSH both ways) come from argv.
const { buildFindings } = require(process.argv[2]);
const appVersion = process.argv[3];
let text = '';
process.stdin.on('data', (c) => (text += c)).on('end', () => {
  const last = text.trim().split('\n').pop();
  const server = JSON.parse(last);
  const findings = buildFindings({
    platform: 'linux', appVersion, server,
    local: { telegram: 'connected', staleConnector: false },
    connection: { addresses: { server: 'x', computer: 'x' }, reach: { ok: true }, back: { ok: true } },
  });
  // Warnings the container cannot clear: the sim's Hermes predates the computer-use
  // provider API, and binding the proactive route needs a real Telegram DM.
  // E2E_STRICT=1 counts them too.
  const EXPECTED = process.env.E2E_STRICT === '1' ? [] : [/Computer use runs on Hermes/, /no primary route bound/, /proactivity does not know your timezone/];
  for (const f of findings) if (f.level === 'warn' && EXPECTED.some((re) => re.test(f.title))) f.level = 'ok', f.title = `(expected in the sim) ${f.title}`;
  const mark = { ok: 'ok  ', warn: 'WARN', fail: 'FAIL' };
  for (const f of findings) console.log(`${mark[f.level]} ${f.group}: ${f.title}${f.level === 'ok' ? '' : ` -> ${f.fix}`}`);
  process.exit(findings.some((f) => f.level !== 'ok') ? 1 : 0);
});

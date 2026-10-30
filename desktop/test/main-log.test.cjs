const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createLog } = require('../src/main-log.cjs');
const { armQuitWatchdog } = require('../src/update-quit.cjs');
const { buildReport, redactReport } = require('../src/setup-check.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'main-log-'));

test('the log appends timestamped lines and creates its folder', () => {
  const dir = path.join(tmp(), 'logs');
  const log = createLog(dir, { now: () => new Date('2026-10-08T00:00:00Z') });
  log.write('updater checking');
  log.write('vm agent', 'ok');
  assert.equal(fs.readFileSync(log.file, 'utf8'), '2026-10-08T00:00:00.000Z updater checking\n2026-10-08T00:00:00.000Z vm agent: ok\n');
  assert.equal(log.tail(1), '2026-10-08T00:00:00.000Z vm agent: ok');
});

test('the log rotates past the cap and keeps exactly one old file', () => {
  const dir = tmp();
  const log = createLog(dir, { maxBytes: 200 });
  for (let i = 0; i < 40; i++) log.write('line', String(i));
  assert.deepEqual(fs.readdirSync(dir).sort(), ['main.log', 'main.log.old']);
  assert.ok(fs.statSync(log.file).size <= 200);
  assert.match(log.tail(1), /line: 39$/);
  assert.match(fs.readFileSync(`${log.file}.old`, 'utf8'), /line: \d+\n$/);
});

test('logs redact secrets before either current or rotated files reach disk', () => {
  const log = createLog(tmp(), { maxBytes: 1 });
  const detail = 'Authorization: Bearer synthetic.log.token https://example.test/path?ticket=synthetic-ticket';
  log.write('error', detail);
  log.write('password=synthetic-password', detail);
  const text = fs.readFileSync(log.file, 'utf8') + fs.readFileSync(`${log.file}.old`, 'utf8');
  assert.doesNotMatch(text, /synthetic[.-]/);
  assert.match(text, /\[removed\]/);
  if (process.platform !== 'win32') assert.equal(fs.statSync(log.file).mode & 0o777, 0o600);
});

test('main-process errors redact secrets before printing to stderr', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/main.cjs'), 'utf8');
  const printed = [], logged = [];
  const logError = vm.runInNewContext(`(${source.slice(source.indexOf('function logError('), source.indexOf('\nlet mainLogger;'))})`, {
    console: { error: line => printed.push(line) }, setupCheck: { redactReport },
    mainLog: () => ({ write: (...args) => logged.push(args) }),
  });
  logError('Authorization: Bearer synthetic-label', new Error('https://example.test/path?ticket=synthetic-error'));
  assert.equal(printed.length, 1);
  assert.doesNotMatch(printed[0], /synthetic[.-]/);
  assert.match(printed[0], /\[removed\]/);
  assert.equal(logged.length, 1, 'the file logger still receives the error for its own redaction');
});

test('logging into an unwritable place never throws', () => {
  const file = path.join(tmp(), 'blocker'); fs.writeFileSync(file, '');
  const log = createLog(path.join(file, 'logs'));
  log.write('x');
  assert.equal(log.tail(), '');
});

test('the watchdog forces exit after 20 seconds and logs it, not before', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [], lines = [];
  armQuitWatchdog({ exit: (code) => calls.push(code), log: (l) => lines.push(l) });
  t.mock.timers.tick(19999);
  assert.deepEqual(calls, []);
  t.mock.timers.tick(1);
  assert.deepEqual(calls, [0]);
  assert.match(lines[0], /watchdog fired.*20s/);
});

test('the report carries the newest 100 log lines with secrets redacted', () => {
  const dir = tmp();
  const log = createLog(dir);
  for (let i = 0; i < 150; i++) log.write('event', String(i));
  log.write('vm agent', 'failed TELEGRAM_BOT_TOKEN=123456789:AAFakeTokenForRedactionTestsOnly_123 Authorization: Bearer abc.def');
  const report = buildReport({ app: { version: '0.4.0', platform: 'darwin', arch: 'arm64', osVersion: '15', signed: true }, serverAddress: '', computerAddress: '', errorLog: log.tail(100) });
  assert.match(report, /event: 149$/m);
  assert.doesNotMatch(report, /event: 50$/m);
  assert.match(report, /event: 51$/m);
  assert.doesNotMatch(report, /AAFakeToken|abc\.def/);
  assert.equal(redactReport(report), report);
});

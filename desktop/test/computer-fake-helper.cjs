// A stand-in for the platform helpers: speaks protocol v2 over stdio.
// Behaviour is steered by env FAKE_MODE: ok | crash-on-serve | hang | die-after-init | crash-mid-act.
const readline = require('node:readline');
const mode = process.env.FAKE_MODE || 'ok';
const command = process.argv[2];
let policy = null;
let misses = 0;
const reply = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const handle = (request) => {
  if (request.policy) policy = request.policy;
  if (request.cmd === 'init') return reply({ id: request.id, ok: true, protocol: 2, pid: process.pid });
  if (mode === 'hang') return;
  if (mode === 'always-not-found' || (mode === 'flaky-not-found' && misses++ < 1)) return reply({ id: request.id, ok: false, code: 'not_found', error: 'App not found.' });
  if (mode === 'bad-menu' && request.cmd === 'menu') return reply({ id: request.id, ok: false, code: 'not_found', error: 'No such menu item.' });
  if (mode === 'crash-mid-act' && request.cmd === 'act') process.exit(3);
  if (request.cmd === 'apps') return reply({ id: request.id, ok: true, apps: [{ name: 'X', bundleId: 'x', pid: process.pid, frontmost: false }], policy });
  if (request.cmd === 'snapshot') return reply({ id: request.id, ok: true, generation: 7, elements: [{ ref: 'c1', role: 'AXButton', name: 'Go' }], helper: process.pid, policy });
  if (request.cmd === 'act') {
    if (request.generation !== undefined && request.generation !== 7) return reply({ id: request.id, ok: false, code: 'stale_ref', error: 'The app changed since your snapshot. Take a fresh snapshot.' });
    const results = request.steps.map((step) => (step.action === 'scroll' ? { ok: false, code: 'unsupported_action', error: 'No scroll here.' } : { ok: true, cursorMoved: false }));
    return reply({ id: request.id, ok: true, results: results.slice(0, results.findIndex((r) => !r.ok) + 1 || results.length), generation: 8, elements: [{ ref: 'c1', role: 'AXButton', name: 'Done' }], steps: request.steps });
  }
  return reply({ id: request.id, ok: false, code: 'bad_request', error: `unknown command ${request.cmd}` });
};
if (command === 'serve') {
  if (mode === 'crash-on-serve') { process.stderr.write('cannot serve here\n'); process.exit(1); }
  readline.createInterface({ input: process.stdin }).on('line', (line) => { if (line.trim()) handle(JSON.parse(line)); }).on('close', () => process.exit(0));
} else if (command === 'once') {
  readline.createInterface({ input: process.stdin }).once('line', (line) => { handle(JSON.parse(line)); setTimeout(() => process.exit(0), 20); });
} else process.exit(2);

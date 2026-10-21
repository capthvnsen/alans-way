// No GUI: asynchronous form updates through the real service and snapshot cache.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; };

async function run() {
  const root = path.resolve(arg('--root', path.join(__dirname, '..')));
  const { createComputerService } = require(path.join(root, 'src/computer-helper.cjs'));
  const delta = process.argv.includes('--delta');
  const rows = [];
  for (let run = 0; run < Number(arg('--runs', 20)); run++) {
    for (const task of ['type + submit + read', 'read changing count', 'switch window']) {
      let generation = 1;
      let value = 'Result: none';
      let name = '';
      let count = 0;
      const driver = {
        snapshot: async (_pid, { windowId } = {}) => ({
          generation, windowId: windowId || 41, window: { x: 0, y: 0, width: 420, height: 520 },
          elements: [ { ref: 'c1', role: 'AXStaticText', name: windowId === 42 ? 'Copied: Ada' : value },
            { ref: 'c2', role: 'AXTextField', name: 'Name', value: name },
            { ref: 'c3', role: 'AXButton', name: 'Submit' }, { ref: 'c4', role: 'AXButton', name: 'Increment' },
            ...Array.from({ length: 30 }, (_, i) => ({ ref: `c${i + 5}`, role: 'AXRow', name: `Row ${i + 1}`, x: 10, y: 40 + i * 14, width: 300, height: 14 })) ],
        }),
        act: async (_pid, { steps }) => {
          for (const step of steps) {
            if (step.action === 'type' && step.ref === 'c2') name = step.text;
            else if (step.action === 'press' && step.ref === 'c3') value = `Result: ${name}`;
            else if (step.action === 'press' && step.ref === 'c4') value = `Count: ${++count}`;
            else throw new Error('Unknown fixture control');
            generation++;
          }
          // A receipt without current state requires a fresh observation.
          return { results: steps.map(() => ({ ok: true })) };
        },
      };
      const service = createComputerService(driver);
      let textChars = 0;
      let toolMs = 0;
      let calls = 0;
      const call = async (fn) => {
        const start = performance.now();
        const reply = await fn();
        toolMs += performance.now() - start;
        textChars += JSON.stringify(reply).length;
        calls++;
        return reply;
      };
      const start = performance.now();
      let held = await call(() => service.snapshot('bench', 7, { windowId: 41, delta }));
      if (task !== 'switch window') {
        const steps = task === 'type + submit + read'
          ? [{ action: 'type', ref: 'c2', text: 'Ada' }, { action: 'press', ref: 'c3' }]
          : Array.from({ length: 3 }, () => ({ action: 'press', ref: 'c4' }));
        await call(() => service.action('bench', 7, { action: 'batch', generation: held.generation, steps }));
      }
      const reply = await call(() => service.snapshot('bench', 7, { since: held.generation, delta, windowId: task === 'switch window' ? 42 : 41 }));
      if (reply.elements) held = reply;
      else {
        const elements = new Map(held.elements.map((element) => [element.ref, element]));
        for (const ref of reply.removed || []) elements.delete(ref);
        for (const element of reply.changed || []) elements.set(element.ref, element);
        held = { ...held, ...reply, elements: [...elements.values()] };
      }
      const expected = task === 'type + submit + read' ? 'Result: Ada' : task === 'read changing count' ? 'Count: 3' : 'Copied: Ada';
      const ok = held.elements[0].name === expected && held.windowId === (task === 'switch window' ? 42 : 41);
      rows.push({ run, mode: 'fixture', delta, task, ok, calls, textChars, textTokens: Math.round(textChars / 4), imageBytes: 0, toolMs, wallMs: performance.now() - start });
    }
  }
  const quantile = (key, q) => rows.map((row) => row[key]).sort((a, b) => a - b)[Math.ceil(rows.length * q) - 1];
  const sum = (key) => rows.reduce((total, row) => total + row[key], 0);
  console.log(JSON.stringify({ mode: 'fixture (mock driver, no native timing)', delta, success: `${rows.filter((row) => row.ok).length}/${rows.length}`, callsPerTask: sum('calls') / rows.length,
    charsPerTask: sum('textChars') / rows.length, tokensPerTask: sum('textTokens') / rows.length, imageBytes: sum('imageBytes'),
    toolMs: { p50: quantile('toolMs', .5), p95: quantile('toolMs', .95) }, wallMs: { p50: quantile('wallMs', .5), p95: quantile('wallMs', .95) } }, null, 2));
  if (arg('--json')) fs.writeFileSync(arg('--json'), JSON.stringify({ root, delta, rows }, null, 2));
  assert.ok(rows.every((row) => row.ok), 'every fixture task must succeed');
}
module.exports = { run };

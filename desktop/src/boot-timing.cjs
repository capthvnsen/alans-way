'use strict';

// Opt-in startup timing hook enabled only when HERMES_WORKSPACE_PROFILE_BOOT=1.
// Logs elapsed milliseconds from process start for each milestone to stderr so
// windowed boot timings can be measured without changing default output.
function createBootTimer({ enabled = process.env.HERMES_WORKSPACE_PROFILE_BOOT === '1', now = () => Number(process.hrtime.bigint()) / 1e6, write = (line) => process.stderr.write(line) } = {}) {
  const start = now();
  const seen = new Set();
  function mark(name) {
    if (!enabled || seen.has(name)) return 0;
    seen.add(name);
    const elapsed = Math.max(0, now() - start);
    write(`[boot-timing] ${name} +${elapsed.toFixed(1)}ms\n`);
    return elapsed;
  }
  return { enabled, mark };
}

module.exports = { createBootTimer };

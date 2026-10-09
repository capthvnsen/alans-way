'use strict';

// Squirrel.Mac waits for this process to exit before it swaps the bundle. If
// anything keeps the app alive after quitAndInstall, force the exit so the
// staged update can finish instead of hanging forever.
const WATCHDOG_MS = 20000;

function armQuitWatchdog({ exit, log, ms = WATCHDOG_MS, setTimer = setTimeout }) {
  const timer = setTimer(() => { log(`watchdog fired: still running ${ms / 1000}s after quitAndInstall, forcing exit`); exit(0); }, ms);
  timer.unref?.();
  return timer;
}

module.exports = { armQuitWatchdog, WATCHDOG_MS };

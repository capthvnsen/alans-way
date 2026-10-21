'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { performance } = require('node:perf_hooks');
const calls = new AsyncLocalStorage();
const READ_BUDGET_MS = 75000;

function remainingMs(cap = Infinity) {
  return Math.max(0, Math.min(cap, (calls.getStore()?.deadline ?? Infinity) - performance.now()));
}

function checkCall() {
  if (calls.getStore()?.signal?.aborted)
    throw Object.assign(new Error('Call cancelled; remaining steps did not run.'), { code: 'cancelled' });
  if (remainingMs() <= 0)
    throw Object.assign(new Error('Call timed out; remaining steps did not run.'), { code: 'timeout' });
}

function waitInCall(promise, onStop = () => {}) {
  const signal = calls.getStore()?.signal;
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', stop); };
    const stop = () => {
      cleanup();
      const code = signal?.aborted ? 'cancelled' : 'timeout';
      reject(Object.assign(new Error(`Call ${code === 'cancelled' ? 'cancelled' : 'timed out'}; remaining steps did not run.`), { code }));
      onStop();
    };
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    signal?.addEventListener('abort', stop, { once: true });
    if (Number.isFinite(remainingMs())) timer = setTimeout(stop, Math.ceil(remainingMs()));
    if (signal?.aborted || remainingMs() <= 0) stop();
  });
}

function context(remaining, signal, fallback = Infinity) {
  const budgeted = Number.isSafeInteger(remaining) && remaining >= 0;
  return { deadline: performance.now() + (budgeted ? remaining : fallback), signal, budgeted };
}

module.exports = { calls, context, remainingMs, checkCall, waitInCall, READ_BUDGET_MS };

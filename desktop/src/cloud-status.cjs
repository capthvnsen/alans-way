// Watching a claimed cloud computer come up: GET /api/computer until it is
// ready (pairing can start) or failed (support takes over). Transient network
// errors retry; a rejected session does not.
'use strict';

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  timer.unref?.();
  function onAbort() { clearTimeout(timer); reject(Object.assign(new Error('Polling stopped.'), { code: 'aborted' })); }
  signal?.addEventListener('abort', onAbort, { once: true });
});

async function fetchComputer(base, session, fetchImpl, signal) {
  const response = await fetchImpl(`${String(base).replace(/\/+$/, '')}/api/computer`, { headers: { Authorization: `Bearer ${session}` }, signal });
  if (response.status === 401) throw Object.assign(new Error('The saved session was rejected. Claim the computer again.'), { code: 'unauthorized' });
  if (!response.ok) throw Object.assign(new Error(`The computer status check failed (${response.status}).`), { code: 'http' });
  const data = await response.json().catch(() => null);
  if (!data || typeof data !== 'object') throw Object.assign(new Error('The computer status answer was not understood.'), { code: 'bad-response' });
  return data;
}

async function pollComputer(base, session, { fetchImpl = fetch, intervalMs = 3000, onUpdate, signal, maxFailures = 5 } = {}) {
  let failures = 0;
  for (;;) {
    if (signal?.aborted) return null;
    try {
      const data = await fetchComputer(base, session, fetchImpl, signal);
      failures = 0;
      onUpdate?.(data);
      if (data.state === 'ready' || data.state === 'failed') return data;
    } catch (error) {
      if (error?.code === 'aborted' || error?.code === 'unauthorized' || signal?.aborted) throw error;
      if (++failures >= maxFailures) throw error;
    }
    await sleep(intervalMs, signal);
  }
}

module.exports = { pollComputer };

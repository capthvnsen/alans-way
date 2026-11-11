'use strict';
// RFC 8252 callback receiver. Authorization codes/state stay in main-process
// memory; the listener is literal loopback, short-lived and single-use.
const http = require('node:http');
const crypto = require('node:crypto');

const MESSAGES = Object.freeze({
  aborted: 'Browser sign-in was cancelled.',
  auth_cancelled: 'Sign-in was declined in the browser.',
  browser_unavailable: 'The sign-in browser could not be opened.',
  timeout: 'Browser sign-in timed out. Try again.',
  callback_unavailable: 'The local sign-in callback could not be started.',
});
class NativeLoginError extends Error {
  constructor(code) { super(MESSAGES[code] || MESSAGES.callback_unavailable); this.code = code; }
}

async function createNativeLogin({ state, signal, timeoutMs = 600_000 }) {
  if (typeof state !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(state)) {
    throw new NativeLoginError('callback_unavailable');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) {
    throw new NativeLoginError('callback_unavailable');
  }
  if (signal?.aborted) throw new NativeLoginError('aborted');
  let resolveCode, rejectCode, rejectReady, timer, authority = '', settled = false;
  const code = new Promise((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  code.catch(() => {}); // cancellation may arrive before the browser opener settles
  const sockets = new Set();
  const callbackPath = '/hermes/callback/' + crypto.randomBytes(32).toString('base64url');
  const server = http.createServer({ maxHeaderSize: 8192, requestTimeout: 5000, headersTimeout: 5000 }, (req, res) => {
    const answer = (status, text) => {
      res.writeHead(status, {
        'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
        'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', Connection: 'close',
      });
      res.end(text);
    };
    const hosts = req.rawHeaders.filter((_, index) => index % 2 === 0 && req.rawHeaders[index].toLowerCase() === 'host');
    if (settled || req.method !== 'GET' || hosts.length !== 1 || req.headers.host !== authority ||
        req.headers['transfer-encoding'] || (req.headers['content-length'] && req.headers['content-length'] !== '0') ||
        typeof req.url !== 'string' || req.url.length > 8192 || !req.url.startsWith('/') || req.url.startsWith('//')) {
      answer(400, 'Sign-in response rejected.'); return;
    }
    let url;
    try { url = new URL(req.url, `http://${authority}`); } catch { answer(400, 'Sign-in response rejected.'); return; }
    if (url.origin !== `http://${authority}` || url.pathname !== callbackPath || url.hash) {
      answer(404, 'Sign-in response rejected.'); return;
    }
    const states = url.searchParams.getAll('state');
    const expected = Buffer.from(state), received = Buffer.from(states[0] || '');
    if (states.length !== 1 || expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
      answer(400, 'Sign-in response rejected.'); return;
    }
    if (url.searchParams.getAll('error').length === 1 && !url.searchParams.has('code')) {
      answer(400, 'Sign-in was declined. Return to Alan’s Workspace.');
      finish(new NativeLoginError('auth_cancelled'), undefined, req.socket); return;
    }
    const codes = url.searchParams.getAll('code');
    if (codes.length !== 1 || !/^[A-Za-z0-9_-]{1,4096}$/.test(codes[0]) ||
        [...url.searchParams.keys()].some(key => key !== 'code' && key !== 'state')) {
      answer(400, 'Sign-in response rejected.'); return;
    }
    answer(200, 'Sign-in complete. You can close this tab and return to Alan’s Workspace.');
    finish(null, codes[0], req.socket);
  });
  server.maxConnections = 8;
  server.on('connection', socket => {
    if (settled) { socket.destroy(); return; }
    sockets.add(socket); socket.once('close', () => sockets.delete(socket));
    socket.setTimeout(5000, () => socket.destroy());
  });
  server.on('clientError', (_error, socket) => { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
  function cleanup(keep) {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
    try { server.close(); } catch {}
    for (const socket of sockets) if (socket !== keep) socket.destroy();
  }
  function finish(error, value, keep) {
    if (settled) return;
    settled = true; cleanup(keep);
    if (error) { rejectReady?.(error); rejectCode(error); } else resolveCode(value);
  }
  const abort = () => finish(new NativeLoginError('aborted'));
  server.on('error', () => finish(new NativeLoginError('callback_unavailable')));
  await new Promise((resolve, reject) => {
    rejectReady = reject;
    signal?.addEventListener('abort', abort, { once: true });
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      if (settled) { cleanup(); return; }
      const address = server.address();
      if (!address || address.address !== '127.0.0.1') { finish(new NativeLoginError('callback_unavailable')); return; }
      authority = `127.0.0.1:${address.port}`;
      timer = setTimeout(() => finish(new NativeLoginError('timeout')), timeoutMs);
      timer.unref();
      resolve();
    });
    if (signal?.aborted) abort();
  });
  return {
    redirectUri: `http://${authority}${callbackPath}`, code,
    cancel: reason => finish(new NativeLoginError(Object.hasOwn(MESSAGES, reason) ? reason : 'aborted')),
  };
}
module.exports = { createNativeLogin, NativeLoginError };

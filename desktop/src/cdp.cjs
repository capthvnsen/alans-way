// A connection to an explicitly configured, loopback Chromium debugging endpoint.
class CDP {
  constructor(socket) {
    this.socket = socket;
    this.next = 0;
    this.pending = new Map();
    this.listeners = new Set();
    socket.addEventListener('message', (event) => {
      let m;
      try { m = JSON.parse(String(event.data)); } catch { return; }
      if (m.id) {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
      } else for (const fn of this.listeners) fn(m);
    });
    socket.addEventListener('close', () => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('VPS browser disconnected. Inspect the page before retrying input.'));
      }
      this.pending.clear();
    });
  }
  static async connect(endpoint) {
    const url = new URL(endpoint);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password)
      throw new Error('CDP must use a loopback http endpoint.');
    const data = await (await fetch(new URL('/json/version', url), { signal: AbortSignal.timeout(3000) })).json();
    const ws = new URL(data.webSocketDebuggerUrl);
    if (ws.hostname !== '127.0.0.1' || ws.protocol !== 'ws:') throw new Error('Invalid CDP socket.');
    const socket = new WebSocket(ws);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error('CDP connection timed out.'));
      }, 5000);
      socket.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new Error('CDP unavailable.'));
        },
        { once: true },
      );
    });
    return new CDP(socket);
  }
  send(method, params = {}, sessionId) {
    if (this.socket.readyState !== 1)
      return Promise.reject(new Error('VPS browser disconnected. Inspect state before retrying.'));
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Browser command timed out. Inspect state before retrying.'));
      }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  async page(targetId) {
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const command = (method, params) => this.send(method, params, sessionId);
    return {
      sessionId,
      command,
      executeJavaScript: async (expression) => {
        const r = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails) throw new Error('Unable to inspect browser page.');
        return r.result.value;
      },
      isDestroyed: () => this.socket.readyState !== 1,
      setIgnoreMenuShortcuts: () => {},
    };
  }
}
module.exports = { CDP };

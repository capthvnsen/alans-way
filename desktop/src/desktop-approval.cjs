'use strict';

const { remainingMs, waitInCall } = require('./call-budget.cjs');

const ASK_MS = 40000;
const GRANT_IDLE_MS = 30 * 60 * 1000;
// A denial holds this long, so an agent that retries cannot keep prompting.
const DENY_MS = 60000;

// Desktop input from an agent the user has not added to Alan's Workspace (a
// raw connector client such as Grok Bot) needs the user's OK on this computer
// first. Hermes bots the user added skip it: Hermes asks in its own chat
// before computer use. ask(name, botId, signal) resolves true (allow), false
// (deny) or null (no answer before signal fired). The wait also ends at the
// caller's own deadline (desktop_approval_timeout), and the prompt closes once
// no caller is waiting for it any more.
function createDesktopApproval({ ask, trusted, askMs = ASK_MS, grantMs = GRANT_IDLE_MS, denyMs = DENY_MS }) {
  const grants = new Map();
  const denials = new Map();
  const pending = new Map();
  return {
    async check(botId, name, { generation = '', valid = () => true } = {}) {
      if (!valid()) return { error: 'credential_revoked', name: name || botId };
      if (!botId || trusted(botId, generation)) return null;
      const key = JSON.stringify([botId, generation]);
      if (grants.get(key) > Date.now()) { grants.set(key, Date.now() + grantMs); return null; }
      if (denials.get(key) > Date.now()) return { error: 'desktop_approval_denied', name: name || botId };
      const timedOut = { error: 'desktop_approval_timeout', name: name || botId };
      if (remainingMs() <= 0) return timedOut;
      let prompt = pending.get(key);
      if (!prompt) {
        const stop = new AbortController();
        const timer = setTimeout(() => stop.abort(), askMs);
        prompt = { stop, waiters: 0, settled: false };
        prompt.done = Promise.resolve().then(() => ask(name || botId, botId, stop.signal, generation))
          .catch(() => null).finally(() => { prompt.settled = true; clearTimeout(timer); pending.delete(key); });
        pending.set(key, prompt);
      }
      prompt.waiters++;
      let answer;
      try { answer = await waitInCall(prompt.done); }
      catch { return timedOut; }
      finally { if (--prompt.waiters === 0 && !prompt.settled) prompt.stop.abort(); }
      if (!valid()) return { error: 'credential_revoked', name: name || botId };
      if (answer === true) { grants.set(key, Date.now() + grantMs); return null; }
      if (answer === false) denials.set(key, Date.now() + denyMs);
      return { error: answer === false ? 'desktop_approval_denied' : 'desktop_approval_required', name: name || botId };
    },
  };
}

module.exports = { createDesktopApproval };

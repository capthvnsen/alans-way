// Claiming a paid cloud computer: the alansway://claim deep link carries a
// single-use token, POST /api/claim trades it for a session, and the session
// stays encrypted in preferences so a restart resumes instead of re-claiming.
'use strict';
const crypto = require('node:crypto');

const API_BASE = 'https://openalan.com';
const apiBase = () => (process.env.ALANSWAY_API_BASE || API_BASE).replace(/\/+$/, '');

// Only alansway://claim?token=<base64url> is a claim link. The token charset
// keeps it inert wherever it is later interpolated.
const TOKEN_RE = /^[A-Za-z0-9_-]{8,512}$/;
function parseClaimUrl(value) {
  let url;
  try { url = new URL(String(value || '')); } catch { return null; }
  if (url.protocol !== 'alansway:') return null;
  const path = (url.hostname + url.pathname).replace(/\/+$/, '');
  if (path !== 'claim') return null;
  const token = url.searchParams.get('token');
  return token && TOKEN_RE.test(token) ? token : null;
}

// A pasted code may be the bare token or the whole link; accept either.
function claimToken(value) {
  const text = String(value || '').trim();
  return TOKEN_RE.test(text) ? text : parseClaimUrl(text);
}

class ClaimError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function claim(base, token, installId, fetchImpl = fetch) {
  const response = await fetchImpl(`${String(base || apiBase()).replace(/\/+$/, '')}/api/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, install_id: installId }),
  });
  if (response.status === 409) throw new ClaimError('claimed', 'This computer was already claimed by another installation.');
  if (response.status === 404) throw new ClaimError('unknown', 'This claim link is not valid. Ask for a new one.');
  if (!response.ok) throw new ClaimError('http', `The claim failed (${response.status}). Try again in a moment.`);
  const data = await response.json().catch(() => null);
  if (!data || typeof data.session !== 'string' || !data.session) throw new ClaimError('bad-response', 'The claim answer was not understood.');
  return { session: data.session, expiresAt: typeof data.expires_at === 'string' ? data.expires_at : '' };
}

// A deep link can land before the window exists (open-url on a cold start, or
// the second-instance argv on Windows). Hold the newest token until the
// renderer can act on it; only one is ever pending.
function createTokenQueue() {
  let pending = null, consumer = null;
  return {
    push(token) {
      if (!token) return;
      if (consumer) consumer(token);
      else pending = token;
    },
    setReady(fn) {
      consumer = fn;
      if (pending) { const token = pending; pending = null; fn(token); }
    },
    get pending() { return pending; },
  };
}

// The install id ties the claim to this copy of the app, so the backend can
// tell a retry apart from a second install claiming the same token.
function ensureInstallId(prefs) {
  if (typeof prefs.installId !== 'string' || !prefs.installId) prefs.installId = crypto.randomUUID();
  return prefs.installId;
}

module.exports = { API_BASE, apiBase, parseClaimUrl, claimToken, claim, ClaimError, createTokenQueue, ensureInstallId };

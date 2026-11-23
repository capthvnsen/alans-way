'use strict';
// A loopback Hermes Desktop without sign-in opens only through the one-use link `hermes webapp --no-open`
// prints on the server. When a server SSH login is saved, Workspace fetches that link itself, once per
// episode. The link is a credential: it goes from the command's output straight to `open` and nowhere else.
const { isSshTarget } = require('./core.cjs');

const COMMAND = 'hermes webapp --no-open --skip-build';
const LINK = /https?:\/\/[^\s'"<>#]+\/webapp\/launch#ticket=[\w-]{43}(?![\w-])/;
// Terminal copies carry stray lines, soft-wrap newlines and indents, so whitespace goes first and only the
// 43-character ticket (plus a following &… part) is kept.
const PASTED = /https?:\/\/[^#'"<>]+\/webapp\/launch(#ticket=[\w-]{43}(?:&[\w=%.~-]*)?)/;
const launchFragment = (text) => PASTED.exec(String(text ?? '').replace(/\s+/g, ''))?.[1] || '';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

const loopbackHttp = (target) => { try { const url = new URL(target); return url.protocol === 'http:' && LOOPBACK.has(url.hostname); } catch { return false; } };

// Only plain words ever leave here: stderr and stdout can carry the link, so neither is quoted.
function failureReason({ code, err }) {
  if (code === 255) return "ssh couldn't connect to the server";
  if (code === 127 || /not found/i.test(err)) return "hermes isn't on the server's path";
  if (code === -1) return String(err || '').trim() ? "ssh didn't start" : 'it took too long';
  if (code !== 0) return 'hermes reported an error';
  return 'hermes printed no link';
}

function createWebappLink({ run, open, log = () => {}, isHost = isSshTarget }) {
  let tried = false;
  return {
    reset() { tried = false; },
    wants({ target, host, needsLink }) { return !tried && needsLink === true && loopbackHttp(target) && !!host && isHost(host); },
    // Resolves to '' when the link was opened (or no longer wanted), else why it was not.
    async fetch({ host, canOpen = () => true }) {
      tried = true;
      const result = await run(host, COMMAND, { timeoutMs: 20000 });
      const link = LINK.exec(String(result?.out || ''))?.[0];
      let reason = link ? '' : failureReason({ code: result?.code, err: String(result?.err || '') });
      if (link && canOpen()) {
        try { open(link); } catch { reason = "Workspace couldn't use the link hermes printed"; }
      }
      log(reason ? `webapp link: not opened (${reason})` : 'webapp link: opened');
      return reason;
    },
  };
}

// A one-use link that is spent or expired leaves the launch page where it is. Once that page has loaded it gets
// `ms` to lead somewhere else; `onStale` fires if it does not.
function createLaunchWatch({ onStale, ms = 8000, timers = { set: setTimeout, clear: clearTimeout } }) {
  let timer = null;
  const disarm = () => { if (timer) { timers.clear(timer); timer = null; } };
  return {
    arm() { disarm(); timer = timers.set(() => { timer = null; onStale(); }, ms); timer?.unref?.(); },
    disarm,
  };
}

module.exports = { createWebappLink, createLaunchWatch, launchFragment, COMMAND };

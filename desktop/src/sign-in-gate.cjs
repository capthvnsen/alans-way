'use strict';

// Page loads that need the restored session-only sign-ins (browser tabs, Telegram, extensions, the connector API) wait on
// this gate; the window and the UI shell never do. It opens when the restore settles or the cap passes, whichever is first.
// A failed restore is reported and opens it too. The restore itself keeps going in the background after the cap.
//
// Only the point where a load STARTS waits. While the gate is open everything runs synchronously, exactly as before. While it
// is closed, `load` keeps at most one queued load per page view (a newer one replaces it, and so does any direct `loadURL`
// on that view), and a queued task or load is dropped if its target is gone or the app is quitting by the time it runs.
function createSignInGate({ settleWithin, capMs, onError, onTaskError = () => {}, isQuitting = () => false }) {
  let open = true, waiting = Promise.resolve();
  const queued = new WeakMap();

  const issue = (contents, url, alive) => {
    try {
      if (contents.isDestroyed() || !alive()) return Promise.resolve();
      return Promise.resolve(contents.loadURL(typeof url === 'function' ? url() : url)).catch(() => {});
    } catch (error) { onTaskError(error); return Promise.resolve(); }
  };

  return {
    start(restore) {
      open = false;
      // The async wrapper turns a synchronous throw into a rejection.
      const run = (async () => restore())().catch(onError);
      waiting = settleWithin(run, capMs).then(() => { open = true; });
      return run;
    },
    isOpen: () => open,
    // Runs now once the gate is open (so the common path stays synchronous); otherwise in arrival order when it opens.
    after: task => open ? task() : waiting.then(() => isQuitting() ? undefined : task()).catch(onTaskError),
    // Loads `url` (or `url()`, read when the load starts) into `contents`. Resolves once the load has settled or been dropped; never rejects.
    load(contents, url, { alive = () => true } = {}) {
      if (open) return issue(contents, url, alive);
      queued.get(contents)?.();
      const own = Object.hasOwn(contents, 'loadURL') ? contents.loadURL : undefined;
      let live = true;
      const cancel = () => {
        if (!live) return;
        live = false; queued.delete(contents);
        try { if (own) contents.loadURL = own; else delete contents.loadURL; } catch {}
      };
      // A direct navigation of this view, made while the first one waits, is the newer one and must win.
      contents.loadURL = (...args) => { cancel(); return contents.loadURL(...args); };
      queued.set(contents, cancel);
      return waiting.then(() => {
        if (!live) return undefined;
        cancel();
        return isQuitting() ? undefined : issue(contents, url, alive);
      });
    },
    ready: () => open ? Promise.resolve() : waiting,
  };
}

module.exports = { createSignInGate };

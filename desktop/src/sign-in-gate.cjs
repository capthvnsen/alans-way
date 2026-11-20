'use strict';

// Page loads that need the restored session-only sign-ins (browser tabs, Telegram, extensions, the connector API) wait on
// this gate; the window and the UI shell never do. It opens when the restore settles or the cap passes, whichever is first.
// A failed restore is reported and opens it too. The restore itself keeps going in the background after the cap.
function createSignInGate({ settleWithin, capMs, onError }) {
  let open = true, waiting = Promise.resolve();
  return {
    start(restore) {
      open = false;
      const run = Promise.resolve().then(restore).catch(onError);
      waiting = settleWithin(run, capMs).then(() => { open = true; });
      return run;
    },
    // Runs now once the gate is open (so the common path stays synchronous); otherwise in arrival order when it opens.
    after: task => open ? task() : waiting.then(task),
    ready: () => open ? Promise.resolve() : waiting,
  };
}

module.exports = { createSignInGate };

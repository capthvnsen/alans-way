'use strict';

// A quit has two bounded waits: browser sign-ins may flush, then pages may run
// their unload handlers. Windows are closed before the final app.quit() so a
// repeated quit still reaches before-quit while a close is stuck; either that
// or a terminating signal skips what is left. Teardown runs only when the
// process is really leaving.
function createQuitControl({ begin = () => {}, save, close, teardown = () => {}, quit, exit, onSaveError = () => {}, onTeardownError = () => {}, saveMs, closeMs, insistMs = 1500, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let state = 'idle', startedAt = 0, saveTimer, closeTimer, tornDown = false;
  const timer = (fn, ms) => {
    const result = setTimer(fn, ms);
    result?.unref?.();
    return result;
  };
  const clear = value => { if (value) clearTimer(value); };
  const runTeardown = () => {
    if (tornDown) return;
    tornDown = true;
    try { teardown(); } catch (error) { onTeardownError(error); }
  };
  const force = () => {
    if (state === 'exited') return;
    state = 'exited';
    clear(saveTimer); clear(closeTimer);
    runTeardown();
    exit(0);
  };
  const finishSave = error => {
    if (state !== 'saving') return;
    clear(saveTimer); saveTimer = undefined;
    if (error) onSaveError(error);
    state = 'closing';
    closeTimer = timer(force, closeMs);
    if (!close()) finishClose();
  };
  const finishClose = () => {
    if (state !== 'closing') return;
    state = 'ready';
    quit();
  };
  return {
    beforeQuit(event) {
      if (state === 'ready') {
        state = 'finishing';
        return;
      }
      event.preventDefault();
      // A held Cmd+Q repeats; only a later, deliberate second quit skips what is left.
      if (state !== 'idle') { if (now() - startedAt >= insistMs) force(); return; }
      state = 'saving'; startedAt = now();
      try { begin(); } catch (error) { onSaveError(error); }
      saveTimer = timer(() => finishSave(new Error('Saving browser sign-ins timed out.')), saveMs);
      let saving;
      try { saving = save(); } catch (error) { finishSave(error); return; }
      Promise.resolve(saving).then(() => finishSave(), finishSave);
    },
    windowAllClosed() {
      if (state === 'idle') return false;
      if (state !== 'closing') return true;
      finishClose();
      return true;
    },
    willQuit() {
      if (state === 'exited') return;
      clear(saveTimer); clear(closeTimer);
      state = 'done';
      runTeardown();
    },
    signal() {
      if (state === 'idle') quit();
      else force();
    },
    overrideUnload: () => state !== 'idle',
  };
}

module.exports = { createQuitControl };

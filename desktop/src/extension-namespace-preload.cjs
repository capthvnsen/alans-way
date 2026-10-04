const { contextBridge } = require('electron');

// Chromium 148+ exposes a separate native `browser` namespace. The extension
// library wraps `chrome`; extensions using webextension-polyfill otherwise pick
// the incomplete native `browser` object and skip those wrappers. Run after the
// library preload in both extension frames and workers. No extension code changes.
if (process.type === 'service-worker' || globalThis.location?.protocol === 'chrome-extension:') {
  contextBridge.executeInMainWorld({ func: () => {
    if (!globalThis.chrome?.runtime?.id) return;
    Object.defineProperty(globalThis, 'browser', {
      value: globalThis.chrome, configurable: true, writable: true, enumerable: true,
    });
  } });
}

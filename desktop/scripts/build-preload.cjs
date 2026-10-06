// Bundle preload helper modules so the workspace preloads can stay sandboxed.
const path = require('node:path');
const esbuild = require('esbuild');
esbuild.buildSync({
  entryPoints: [
    path.join(__dirname, '../src/preload.cjs'),
    path.join(__dirname, '../src/telegram-preload.cjs'),
    path.join(__dirname, '../src/voice-preload.cjs'),
  ],
  outdir: path.join(__dirname, '../src'),
  outExtension: { '.js': '.bundle.cjs' },
  bundle: true,
  platform: 'node',
  external: ['electron'],
});
// The voice view's page and inference worker run in a plain Chromium renderer —
// bundle them for the browser, not Node.
esbuild.buildSync({
  entryPoints: {
    'voice-page': path.join(__dirname, '../src/voice/voice-page.mjs'),
    'voice-worker': path.join(__dirname, '../src/voice/voice-worker.mjs'),
  },
  outdir: path.join(__dirname, '../src/voice'),
  outExtension: { '.js': '.bundle.js' },
  bundle: true,
  platform: 'browser',
  format: 'iife',
  mainFields: ['browser', 'module', 'main'],
  logLevel: 'warning',
});

// Bundle preload helper modules so the workspace preloads can stay sandboxed.
const path = require('node:path');
require('esbuild').buildSync({
  entryPoints: [
    path.join(__dirname, '../src/preload.cjs'),
    path.join(__dirname, '../src/telegram-preload.cjs'),
  ],
  outdir: path.join(__dirname, '../src'),
  outExtension: { '.js': '.bundle.cjs' },
  bundle: true,
  platform: 'node',
  external: ['electron'],
});

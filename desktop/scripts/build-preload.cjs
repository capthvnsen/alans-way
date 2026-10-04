// Bundle the extension UI bridge so the workspace preload can stay sandboxed.
const path = require('node:path');
require('esbuild').buildSync({
  entryPoints: [path.join(__dirname, '../src/preload.cjs')],
  outfile: path.join(__dirname, '../src/preload.bundle.cjs'),
  bundle: true,
  platform: 'node',
  external: ['electron'],
});

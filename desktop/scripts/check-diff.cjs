// Local pre-push check for the files you changed: node scripts/check-diff.cjs [base] [--deep]
// (npm run check:diff [-- base] [--deep]). Syntax-checks changed desktop JS, then runs only
// the unit tests whose own imports or text name a changed file (--deep: imports of
// imports too, several times slower); any change it cannot place
// (package files, a path outside desktop/, a shared test helper) runs all of them.
// It narrows local feedback only: CI and the release build run the full `npm run check`.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const desktop = path.resolve(__dirname, '..');
const text = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
const relatives = (source) => [...source.matchAll(/['"`](\.{1,2}\/[^'"`\s$]+)['"`]/g)].map((m) => m[1]);

// Files a test can reach: itself plus what it requires or names by relative path,
// `depth` levels down (1 = the test's own imports). A path built at run time is
// caught by the file-name match in `select`.
function closure(file, depth, seen = new Set()) {
  if (seen.has(file) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return seen;
  seen.add(file);
  if (depth < 1 || !/\.(c?js|mjs)$/.test(file)) return seen;
  for (const rel of relatives(text(file))) {
    for (const candidate of [rel, `${rel}.cjs`, `${rel}.js`]) closure(path.resolve(path.dirname(file), candidate), depth - 1, seen);
  }
  return seen;
}

// Selects the unit tests that can see a changed file; null means "run them all".
function select(root, changed, depth = 1) {
  const unit = path.join(root, 'test');
  const tests = fs.readdirSync(unit).filter((n) => n.endsWith('.test.cjs')).map((n) => path.join(unit, n));
  const abs = changed.map((f) => path.resolve(root, '..', f));
  const known = (f) => [path.join(root, 'src'), path.join(root, 'scripts'), unit].some((d) => f.startsWith(d + path.sep));
  const helperChanged = abs.some((f) => f.startsWith(unit + path.sep) && !f.endsWith('.test.cjs') && !/-electron\.cjs$/.test(f) && !/\/bench\//.test(f));
  if (abs.some((f) => !known(f)) || helperChanged) return null;
  return tests.filter((t) => {
    const reach = closure(t, depth);
    const own = text(t);
    return abs.some((f) => reach.has(f) || own.includes(path.basename(f)));
  });
}

module.exports = { select, closure };

if (require.main === module) {
  const git = (...args) => execFileSync('git', args, { cwd: desktop, encoding: 'utf8' }).split('\n').filter(Boolean);
  const top = git('rev-parse', '--show-toplevel')[0];
  const deep = process.argv.includes('--deep');
  const base = process.argv.slice(2).find((a) => !a.startsWith('--')) || 'HEAD';
  const changed = [...new Set([...git('diff', '--name-only', '--diff-filter=d', base), ...git('ls-files', '-o', '--exclude-standard', '--full-name')])]
    .map((f) => path.relative(path.dirname(desktop), path.join(top, f)));
  const started = Date.now();
  const inDesktop = changed.filter((f) => f.startsWith('desktop/'));
  for (const f of inDesktop.filter((n) => /\.(c?js)$/.test(n) && !n.includes('node_modules'))) {
    if (fs.existsSync(path.join(top, 'desktop', f.slice(8))) && spawnSync(process.execPath, ['--check', path.join(top, 'desktop', f.slice(8))], { stdio: 'inherit' }).status) process.exit(1);
  }
  const picked = select(desktop, changed, deep ? Infinity : 1);
  const files = picked || fs.readdirSync(path.join(desktop, 'test')).filter((n) => n.endsWith('.test.cjs')).map((n) => path.join(desktop, 'test', n));
  console.log(`${changed.length} changed file(s); ${picked ? `${files.length} unit test file(s) can reach them` : 'cannot place a change, running all unit tests'}`);
  const status = files.length ? spawnSync(process.execPath, ['--test', ...files], { cwd: desktop, stdio: 'inherit' }).status : 0;
  console.log(`check:diff finished in ${((Date.now() - started) / 1000).toFixed(1)} s (CI still runs everything)`);
  process.exit(status || 0);
}

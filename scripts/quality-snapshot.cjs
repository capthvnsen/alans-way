#!/usr/bin/env node
// Freeze a source candidate for a critic while builders continue in the checkout.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const label = process.argv[2];
if (!label || !/^[a-z0-9][a-z0-9-]{0,59}$/.test(label)) {
  console.error('Usage: node scripts/quality-snapshot.cjs <unique-lowercase-label>');
  process.exit(1);
}
const target = path.join(root, 'evidence/quality/snapshots', label);
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const files = [...new Set(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean))];
// Include generated runtime inputs when present; their source is also frozen.
for (const file of ['desktop/src/preload.bundle.cjs', 'desktop/src/telegram-preload.bundle.cjs',
  'desktop/build-info.json', 'desktop/scripts/mac-computer', 'desktop/scripts/mac-computer.src']) {
  if (fs.existsSync(path.join(root, file))) files.push(file);
}
const manifest = {};
for (const file of files) {
  const source = path.join(root, file);
  if (!fs.existsSync(source)) continue; // Tracked deletion is represented by absence.
  if (fs.lstatSync(source).isSymbolicLink()) throw new Error(`Source symlink needs explicit review: ${file}`);
  manifest[file] = digest(source);
}
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.mkdirSync(target); // Never replace an earlier candidate or its evidence.
try {
  for (const file of Object.keys(manifest)) {
    const source = path.join(root, file), output = path.join(target, file);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.copyFileSync(source, output);
    fs.chmodSync(output, fs.statSync(source).mode);
    if (digest(output) !== manifest[file] || digest(source) !== manifest[file]) throw new Error(`Source changed during capture: ${file}`);
  }
  for (const file of Object.keys(manifest)) {
    if (digest(path.join(root, file)) !== manifest[file]) throw new Error(`Source changed during capture: ${file}`);
  }
  const dependencies = path.join(root, 'desktop/node_modules');
  if (!fs.existsSync(dependencies)) throw new Error('Install desktop dependencies before freezing a runnable candidate.');
  fs.symlinkSync(dependencies, path.join(target, 'desktop/node_modules'), 'dir');
  const metadata = { label, capturedAt: new Date().toISOString(), baseCommit: git(['rev-parse', 'HEAD']).trim(),
    dependencyLock: manifest['desktop/package-lock.json'], sharedDependencies: 'desktop/node_modules is linked to the build checkout; do not mutate dependencies during review.', files: manifest };
  fs.writeFileSync(path.join(target, 'quality-manifest.json'), JSON.stringify(metadata, null, 2) + '\n');
  console.log(JSON.stringify({ candidate: target, manifest: path.join(target, 'quality-manifest.json'), files: Object.keys(manifest).length }));
} catch (error) {
  fs.rmSync(target, { recursive: true, force: true });
  throw error;
}

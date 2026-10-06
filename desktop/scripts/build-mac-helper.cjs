'use strict';
// Ship the Mac computer helper prebuilt: a downloaded app can't count on swiftc.
// A local build without swiftc still packages; the app compiles it on first use.
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const result = spawnSync('swiftc', ['-O', '-target', 'arm64-apple-macos13', '-o', path.join(__dirname, 'mac-computer'), path.join(__dirname, 'mac-computer.swift')], { stdio: 'inherit' });
if (result.status !== 0) {
  if (process.env.CI) process.exit(result.status ?? 1);
  console.warn('build-mac-helper: swiftc unavailable; the app will build the helper on first use.');
}

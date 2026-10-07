'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { createComputer, binaryCurrent, recordBuild } = require('./computer-helper.cjs');

const source = path.join(__dirname, '..', 'scripts', 'mac-computer.swift');
const binary = path.join(__dirname, '..', 'scripts', 'mac-computer');
let building = null;

// The deployment target is the oldest macOS the app supports, so the helper
// must keep its newer-API calls behind availability checks.
const target = `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos13`;

// The prebuilt helper ships in the app bundle; a connector copy pushed to the
// home directory runs under that app's Electron, so execPath finds it.
// In a signed release the helper is Developer ID signed like every other
// binary in the bundle. TCC grants stay with the app either way: the helper
// is its child process, so Accessibility and Screen Recording are credited to
// the app. A runtime rebuild only happens for a stale shipped helper on a Mac
// with the Command Line Tools, and it rewrites the sealed bundle in place.
const bundled = path.join(path.dirname(process.execPath), '..', 'Resources', 'app', 'scripts', 'mac-computer');

function build() {
  return new Promise((resolve, reject) => {
    let stderr = '';
    const compiler = spawn('swiftc', ['-O', '-target', target, '-o', binary, source], { stdio: ['ignore', 'ignore', 'pipe'] });
    compiler.stderr.on('data', (chunk) => { stderr += chunk; });
    compiler.on('error', (error) => reject(new Error(`Could not build the Mac computer helper: ${error.message}`)));
    compiler.on('close', (code) => {
      if (code !== 0) return reject(new Error(stderr.trim() || 'Could not build the Mac computer helper.'));
      recordBuild(source, binary);
      resolve(binary);
    });
  });
}

function hasDevTools() {
  return new Promise((resolve) => {
    spawn('xcode-select', ['-p'], { stdio: 'ignore' }).on('error', () => resolve(false)).on('close', (code) => resolve(code === 0));
  });
}

// Without the Command Line Tools, /usr/bin/swiftc is a stub that pops an
// install dialog, so check xcode-select first and try at most once per process.
function makeCompile({ hasDevTools, build }) {
  let failed = false;
  return async () => {
    if (failed) return false;
    if (await hasDevTools()) {
      try { await build(); return true; } catch { /* fall through to a prebuilt helper */ }
    }
    failed = true;
    return false;
  };
}

async function pickHelper({ binary, source, bundled, exists, current, compile }) {
  if (current(source, binary)) return binary;
  if (exists(source) && await compile()) return binary;
  if (exists(bundled)) return bundled;
  if (exists(binary)) return binary;
  throw new Error('Could not build the Mac computer helper, and no prebuilt one ships with this app.');
}

const compile = makeCompile({ hasDevTools, build });

// Packaging builds the helper ahead of time (scripts/build-computer.cjs); this
// is the fallback for a checkout that was never packaged or a Mac without the
// compiler, where an older or bundled build is better than nothing.
function ensureBinary() {
  if (process.platform !== 'darwin') throw new Error('Mac computer use only runs on the Mac.');
  if (!building) {
    building = pickHelper({ binary, source, bundled, compile, exists: (p) => fs.existsSync(p), current: binaryCurrent })
      .finally(() => { building = null; });
  }
  return building;
}

// A connector spawned over SSH lives outside the guest's Aqua session, where
// AX calls and screen capture are denied even when the console user granted
// them. HERMES_COMPUTER_ASUSER=1 re-enters that session through launchd; -n
// makes sudo fail fast instead of prompting when NOPASSWD is missing.
function driverCommand(helper, args) {
  if (process.env.HERMES_COMPUTER_ASUSER === '1')
    return ['sudo', '-n', 'launchctl', 'asuser', String(process.getuid()), helper, ...args];
  return [helper, ...args];
}

const { service, close } = createComputer({ command: async (mode) => driverCommand(await ensureBinary(), [mode]) });

module.exports = { service, close, ensureBinary, pickHelper, makeCompile, driverCommand, target };

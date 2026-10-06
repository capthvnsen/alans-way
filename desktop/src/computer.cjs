'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { computerDecision } = require('./computer-policy.cjs');

const source = path.join(__dirname, '..', 'scripts', 'mac-computer.swift');
const binary = path.join(__dirname, '..', 'scripts', 'mac-computer');

// The prebuilt helper ships in the app bundle; a connector copy pushed to the
// home directory runs under that app's Electron, so execPath finds it.
const bundled = path.join(path.dirname(process.execPath), '..', 'Resources', 'app', 'scripts', 'mac-computer');

function pickHelper({ binary, source, bundled, exists, mtime, compile }) {
  const fresh = exists(binary) && (!exists(source) || mtime(binary) >= mtime(source));
  if (fresh) return binary;
  if (exists(source) && compile()) return binary;
  if (exists(bundled)) return bundled;
  if (exists(binary)) return binary;
  throw new Error('Could not build the Mac computer helper, and no prebuilt one ships with this app.');
}

// Without the Command Line Tools, /usr/bin/swiftc is a stub that pops an
// install dialog, so check xcode-select first and try at most once per process.
function makeCompile({ hasDevTools, swiftc }) {
  let failed = false;
  return () => {
    if (failed) return false;
    if (hasDevTools() && swiftc()) return true;
    failed = true;
    return false;
  };
}

const compile = makeCompile({
  hasDevTools: () => spawnSync('xcode-select', ['-p'], { encoding: 'utf8' }).status === 0,
  swiftc: () => spawnSync('swiftc', ['-O', '-o', binary, source], { encoding: 'utf8' }).status === 0,
});

function ensureBinary() {
  if (process.platform !== 'darwin') throw new Error('Mac computer use only runs on the Mac.');
  return pickHelper({
    binary, source, bundled, compile,
    exists: (p) => fs.existsSync(p),
    mtime: (p) => fs.statSync(p).mtimeMs,
  });
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

function run(args) {
  const [command, ...rest] = driverCommand(ensureBinary(), args);
  const result = spawnSync(command, rest, { encoding: 'utf8', timeout: 20000 });
  let parsed;
  try { parsed = JSON.parse(result.stdout || '{}'); } catch { parsed = null; }
  if (!parsed) throw new Error((result.stderr || result.stdout || 'Computer helper failed.').trim().slice(0, 300));
  if (!parsed.ok) throw new Error(parsed.error || 'Computer action failed.');
  return parsed;
}

function apps() {
  return run(['apps']).apps || [];
}

function requireApp(pid) {
  const list = apps();
  const app = list.find((item) => item.pid === pid);
  const front = list.find((item) => item.frontmost);
  const decision = computerDecision(app, front ? front.pid : null);
  if (!decision.ok) throw new Error(decision.reason);
  return app;
}

function snapshot(pid) {
  requireApp(pid);
  return run(['snapshot', String(pid)]);
}

function press(pid, ref) {
  requireApp(pid);
  return run(['press', String(pid), ref]);
}

function click(pid, x, y) {
  requireApp(pid);
  return run(['click', String(pid), String(x), String(y)]);
}

function drag(pid, x, y, x2, y2) {
  requireApp(pid);
  return run(['drag', String(pid), String(x), String(y), String(x2), String(y2)]);
}

function type(pid, ref, text) {
  requireApp(pid);
  if (typeof text !== 'string' || text.length > 2000) throw new Error('Text must be a string of at most 2000 characters.');
  return run(['type', String(pid), ref, text]);
}

function screenshot(pid, maxWidth) {
  requireApp(pid);
  const cap = Number.isInteger(maxWidth) ? Math.min(Math.max(maxWidth, 320), 1280) : 960;
  const shot = run(['shot', String(pid), String(cap)]);
  return {
    image: shot.image,
    imageWidth: shot.imageWidth,
    imageHeight: shot.imageHeight,
    windowX: shot.windowX,
    windowY: shot.windowY,
    windowWidth: shot.windowWidth,
    windowHeight: shot.windowHeight,
  };
}

module.exports = { apps, snapshot, press, click, drag, type, screenshot, ensureBinary, pickHelper, makeCompile, driverCommand };

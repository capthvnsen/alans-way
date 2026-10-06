'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { computerDecision } = require('./computer-policy.cjs');

const source = path.join(__dirname, '..', 'scripts', 'win-computer.cs');
const binary = path.join(__dirname, '..', 'scripts', 'win-computer.exe');

const compilers = [
  'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
  'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
];
const assemblies = ['UIAutomationClient.dll', 'UIAutomationTypes.dll', 'WindowsBase.dll'];

// Bare '/r:name.dll' only resolves against the compiler's own directory, and
// Server SKUs keep the UIA assemblies out of it — search the framework and
// reference-assemblies roots and pass absolute paths instead.
function assemblyPaths(compiler) {
  const dirs = [path.dirname(compiler), path.join(path.dirname(compiler), 'WPF')];
  const programFiles = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const refRoot = path.join(programFiles, 'Reference Assemblies', 'Microsoft', 'Framework', '.NETFramework');
  try {
    for (const entry of fs.readdirSync(refRoot)) dirs.push(path.join(refRoot, entry));
  } catch { /* no SDK-style reference assemblies — the framework dir is the fallback */ }
  return assemblies.map((name) => {
    const dir = dirs.find((candidate) => fs.existsSync(path.join(candidate, name)));
    if (!dir) throw new Error(`Could not find the .NET Framework assembly ${name}.`);
    return path.join(dir, name);
  });
}

function ensureBinary() {
  if (process.platform !== 'win32') throw new Error('Windows computer use only runs on Windows.');
  const stale = !fs.existsSync(binary) || fs.statSync(source).mtimeMs > fs.statSync(binary).mtimeMs;
  if (!stale) return binary;
  const compiler = compilers.find((candidate) => fs.existsSync(candidate));
  if (!compiler) throw new Error('Could not find the .NET Framework compiler (csc.exe).');
  const built = spawnSync(compiler, [
    '/nologo', '/target:exe', '/out:' + binary,
    ...assemblyPaths(compiler).map((assembly) => '/r:' + assembly), source,
  ], { encoding: 'utf8' });
  if (built.status !== 0) throw new Error((built.stderr || built.stdout || 'Could not build the Windows computer helper.').trim());
  return binary;
}

function run(args) {
  const result = spawnSync(ensureBinary(), args, { encoding: 'utf8', timeout: 20000 });
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

module.exports = { apps, snapshot, press, click, drag, type, screenshot, ensureBinary };

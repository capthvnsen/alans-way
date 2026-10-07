'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { createComputer, binaryCurrent, recordBuild } = require('./computer-helper.cjs');

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

let building = null;

function build(compiler) {
  return new Promise((resolve, reject) => {
    let output = '';
    const csc = spawn(compiler, [
      '/nologo', '/target:exe', '/out:' + binary,
      ...assemblyPaths(compiler).map((assembly) => '/r:' + assembly), source,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    csc.stdout.on('data', (chunk) => { output += chunk; });
    csc.stderr.on('data', (chunk) => { output += chunk; });
    csc.on('error', (error) => reject(new Error(`Could not build the Windows computer helper: ${error.message}`)));
    csc.on('close', (code) => {
      if (code !== 0) return reject(new Error(output.trim() || 'Could not build the Windows computer helper.'));
      recordBuild(source, binary);
      resolve(binary);
    });
  });
}

// Packaging builds the helper ahead of time (scripts/build-computer.cjs); this
// is the fallback for a checkout that was never packaged.
async function ensureBinary() {
  if (process.platform !== 'win32') throw new Error('Windows computer use only runs on Windows.');
  if (binaryCurrent(source, binary)) return binary;
  const compiler = compilers.find((candidate) => fs.existsSync(candidate));
  if (!compiler) {
    if (fs.existsSync(binary)) return binary;
    throw new Error('Could not find the .NET Framework compiler (csc.exe).');
  }
  if (!building) {
    building = build(compiler).catch((error) => {
      if (fs.existsSync(binary)) return binary;
      throw error;
    }).finally(() => { building = null; });
  }
  return building;
}

const { service, close } = createComputer({ command: async (mode) => [await ensureBinary(), mode] });

module.exports = { service, close, ensureBinary };

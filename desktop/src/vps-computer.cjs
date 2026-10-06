'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const script = path.join(__dirname, '..', 'scripts', 'vps-computer.py');

function run(args) {
  const result = spawnSync('python3', [script, ...args], { encoding: 'utf8', timeout: 20000 });
  let parsed;
  try { parsed = JSON.parse(result.stdout || '{}'); } catch { parsed = null; }
  if (!parsed) throw new Error((result.stderr || result.stdout || 'Desktop helper failed.').trim().slice(0, 300));
  if (!parsed.ok) throw new Error(parsed.error || 'Desktop action failed.');
  return parsed;
}

function apps() {
  return run(['apps']).apps || [];
}

function snapshot(pid) {
  return run(['snapshot', String(pid)]);
}

function press(pid, ref) {
  return run(['press', String(pid), ref]);
}

function click(pid, x, y) {
  return run(['click', String(pid), String(x), String(y)]);
}

function drag(pid, x, y, x2, y2) {
  return run(['drag', String(pid), String(x), String(y), String(x2), String(y2)]);
}

function screenshot(pid, maxWidth) {
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

module.exports = { apps, snapshot, press, click, drag, screenshot };

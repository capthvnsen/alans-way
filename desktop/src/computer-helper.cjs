'use strict';

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { helperPolicy } = require('./computer-policy.cjs');
const { createComputerSnapshots } = require('./computer-snapshot.cjs');

const REQUEST_TIMEOUT_MS = 20000;
const ONCE_RETRY_MS = 60000;
const STEP_LIMIT = 25;
const READ_ONLY = new Set(['apps', 'snapshot', 'shot', 'menu']);

function helperError(response) {
  const code = response.code || 'failed';
  let message = response.error || 'Computer action failed.';
  if ((code === 'stale_ref' || code === 'unsupported_action') && !message.startsWith(code)) message = `${code}: ${message}`;
  return Object.assign(new Error(message), { code });
}

// One helper process per platform, speaking newline-delimited JSON on stdio.
// It starts on the first request, is replaced after a crash or a timeout, and
// if it cannot start at all every request runs the same JSON through
// `helper once` instead (the old one-shot mode) for a minute before retrying.
// `command(mode)` resolves to [executable, ...args] for mode 'serve' or 'once'.
function createHelper({ command, env, timeoutMs = REQUEST_TIMEOUT_MS }) {
  const policy = helperPolicy();
  let child = null;
  let chain = Promise.resolve();
  let onceUntil = 0;
  let nextId = 1;

  async function spawnHelper(mode) {
    const [file, ...args] = await command(mode);
    return spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], env: env || process.env });
  }

  async function persistent(request) {
    if (!child || child.dead) {
      const proc = await spawnHelper('serve');
      const state = { proc, dead: false, answered: false, buffer: '', stderr: '', waiter: null };
      const die = (reason) => {
        if (state.dead) return;
        state.dead = true;
        const waiter = state.waiter;
        state.waiter = null;
        if (waiter) clearTimeout(waiter.timer);
        if (waiter) waiter.reject(Object.assign(new Error(reason), { helperDied: true, neverAnswered: !state.answered }));
      };
      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (chunk) => {
        state.buffer += chunk;
        let at;
        while ((at = state.buffer.indexOf('\n')) >= 0) {
          const line = state.buffer.slice(0, at);
          state.buffer = state.buffer.slice(at + 1);
          let response;
          try { response = JSON.parse(line); } catch { continue; }
          if (response && response.id === 0) state.answered = true;
          if (!response || !state.waiter || response.id !== state.waiter.id) continue;
          const waiter = state.waiter;
          state.waiter = null;
          clearTimeout(waiter.timer);
          waiter.resolve(response);
        }
      });
      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', (chunk) => { state.stderr = (state.stderr + chunk).slice(-600); });
      proc.on('error', (error) => die(error.message));
      proc.on('close', (code) => die(state.stderr.trim() || `Computer helper exited (${code}).`));
      proc.stdin.on('error', () => {});
      // An idle helper must not keep the connector alive; it exits on stdin EOF.
      proc.unref();
      for (const stream of [proc.stdin, proc.stdout, proc.stderr]) if (stream.unref) stream.unref();
      state.die = die;
      child = state;
      // The policy rides on the first line; its answer (id 0) is ignored.
      proc.stdin.write(JSON.stringify({ id: 0, cmd: 'init', policy }) + '\n');
    }
    const state = child;
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        state.waiter = null;
        try { state.proc.kill('SIGKILL'); } catch { /* already gone */ }
        state.die('Computer helper timed out.');
        reject(Object.assign(new Error('Computer helper timed out.'), { timedOut: true }));
      }, request.timeoutMs || timeoutMs);
      state.waiter = { id, resolve, reject, timer };
      const { timeoutMs: _ignored, ...wire } = request;
      state.proc.stdin.write(JSON.stringify({ ...wire, id }) + '\n');
    });
  }

  async function once(request) {
    const proc = await spawnHelper('once');
    return new Promise((resolve, reject) => {
      let out = '', err = '';
      const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } reject(new Error('Computer helper timed out.')); }, request.timeoutMs || timeoutMs);
      proc.stdout.setEncoding('utf8');
      proc.stderr.setEncoding('utf8');
      proc.stdout.on('data', (chunk) => { out += chunk; });
      proc.stderr.on('data', (chunk) => { err += chunk; });
      proc.on('error', (error) => { clearTimeout(timer); reject(error); });
      proc.on('close', () => {
        clearTimeout(timer);
        try { resolve(JSON.parse(out.trim().split('\n').pop() || '')); }
        catch { reject(new Error((err || out || 'Computer helper failed.').trim().slice(0, 300))); }
      });
      proc.stdin.on('error', () => {});
      const { timeoutMs: _ignored, ...wire } = request;
      proc.stdin.end(JSON.stringify({ ...wire, id: 1, policy }) + '\n');
    });
  }

  async function run(request) {
    if (Date.now() >= onceUntil) {
      try { return await persistent(request); }
      catch (error) {
        if (!error.helperDied) throw error;
        if (error.neverAnswered) onceUntil = Date.now() + ONCE_RETRY_MS;
        else if (!READ_ONLY.has(request.cmd)) throw new Error(`Computer helper stopped mid-action; check the app before retrying. ${error.message}`.slice(0, 300));
        // A read, or a helper that never started: nothing was half-done, so run it again.
      }
      if (Date.now() >= onceUntil) return persistent(request);
    }
    return once(request);
  }

  // An app that was only just opened or activated can be missing from the
  // process list for a moment, so one retry before saying so.
  async function runWithRetry(body) {
    let response = await run(body);
    // The app-not-found text alone decides: a menu path or point that is missing says something else.
    const appMissing = (item) => item && item.ok === false && item.code === 'not_found' && /^App not found/.test(item.error || '');
    if (appMissing(response)) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      response = await run(body);
      if (appMissing(response))
        response = { ...response, error: 'App not found. If it was just opened or activated, wait a moment and retry.' };
    }
    return response;
  }

  async function request(body) {
    const next = chain.then(() => runWithRetry(body));
    chain = next.catch(() => {});
    const response = await next;
    if (!response || response.ok === false) throw helperError(response || {});
    return response;
  }

  function close() {
    const state = child;
    child = null;
    if (state && !state.dead) { try { state.proc.stdin.end(); state.proc.kill(); } catch { /* gone */ } }
  }

  return { request, close };
}

// A build is current when the source it was built from is byte-identical, not
// when mtimes happen to line up: checkouts and packaging reshuffle those.
const sourceHash = (source) => crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');

function binaryCurrent(source, binary) {
  try { return fs.existsSync(binary) && fs.readFileSync(`${binary}.src`, 'utf8') === sourceHash(source); }
  catch { return false; }
}

function recordBuild(source, binary) {
  fs.writeFileSync(`${binary}.src`, sourceHash(source));
}

const MODIFIERS = {
  shift: 'shift', control: 'control', ctrl: 'control', alt: 'alt', option: 'alt', opt: 'alt',
  meta: 'meta', cmd: 'meta', command: 'meta', super: 'meta', win: 'meta', windows: 'meta',
};
const MODIFIER_ORDER = ['shift', 'control', 'alt', 'meta'];
const KEY_NAMES = {
  return: 'return', enter: 'return', tab: 'tab', space: 'space', escape: 'escape', esc: 'escape',
  backspace: 'backspace', delete: 'backspace', del: 'forwarddelete', forwarddelete: 'forwarddelete',
  up: 'up', arrowup: 'up', down: 'down', arrowdown: 'down', left: 'left', arrowleft: 'left',
  right: 'right', arrowright: 'right', home: 'home', end: 'end', pageup: 'pageup', pagedown: 'pagedown',
};

function fail(code, message) {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

// "cmd+shift+n", {key:'Enter'}, {keys:'ctrl+a'} all become {key, modifiers}.
function normalizeKey(step) {
  const raw = String(step.key !== undefined ? step.key : step.keys !== undefined ? step.keys : '');
  const parts = raw.length > 1 ? raw.split('+') : [raw];
  const modifiers = new Set((Array.isArray(step.modifiers) ? step.modifiers : []).map((name) => MODIFIERS[String(name).toLowerCase()]));
  const key = parts.pop();
  for (const part of parts) modifiers.add(MODIFIERS[part.toLowerCase()]);
  if (modifiers.has(undefined)) throw fail('bad_request', 'Modifiers are shift, control, alt, and meta.');
  const lower = key.toLowerCase();
  if (key.length === 1 && key !== lower) modifiers.add('shift');
  const name = KEY_NAMES[lower] || (/^f([1-9]|1[0-2])$/.test(lower) ? lower : key.length === 1 ? (key === ' ' ? 'space' : lower) : null);
  if (!name) throw fail('bad_request', `Unknown key "${key}".`);
  return { action: 'key', key: name, modifiers: MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)) };
}

const REF_ACTIONS = new Set(['press', 'type']);
const POINT_OR_REF = new Set(['double_click', 'right_click', 'scroll']);

function normalizeStep(item) {
  const step = item && typeof item === 'object' ? item : {};
  const action = step.action;
  if (action === 'key' || action === 'hotkey') return normalizeKey(step);
  if (action === 'type' && (typeof step.text !== 'string' || step.text.length > 2000))
    throw fail('bad_request', 'Text must be a string of at most 2000 characters.');
  if (REF_ACTIONS.has(action) && typeof step.ref !== 'string') throw fail('bad_request', `${action} needs a ref.`);
  if (action === 'menu' && !(Array.isArray(step.path) && step.path.length && step.path.every((part) => typeof part === 'string')))
    throw fail('bad_request', 'menu needs a path such as ["File","Save"].');
  if (action === 'scroll' && !['up', 'down', 'left', 'right'].includes(step.direction))
    throw fail('bad_request', 'scroll needs a direction: up, down, left, or right.');
  if (!REF_ACTIONS.has(action) && !POINT_OR_REF.has(action) && !['click', 'drag', 'menu'].includes(action))
    throw fail('bad_request', 'Computer action must be press, type, click, double_click, right_click, drag, scroll, key, hotkey, menu, or batch.');
  return step;
}

const needsGeneration = (step) => typeof step.ref === 'string';

// The verbs shared by the MCP connector and the app's loopback API.
function createComputerService(driver) {
  const seen = createComputerSnapshots();

  async function snapshot(bot, pid, { since, menubar } = {}) {
    return seen.snapshot(bot, pid, await driver.snapshot(pid, { menubar: menubar === true }), since);
  }

  async function action(bot, pid, body) {
    const batch = body.action === 'batch';
    const raw = batch ? (Array.isArray(body.steps) ? body.steps.slice(0, STEP_LIMIT) : []) : [body];
    const steps = raw.map(normalizeStep);
    if (steps.some(needsGeneration) && !Number.isInteger(body.generation))
      throw fail('stale_ref', 'Pass the generation from your latest snapshot with every action that uses a ref.');
    const reply = await driver.act(pid, { steps, generation: body.generation, menubar: body.menubar === true });
    const { results = [], ...tree } = reply;
    let result;
    if (batch) result = { results: results.map(({ ok, ...rest }) => (ok === false ? { error: rest.error, code: rest.code } : { ok, ...rest })) };
    else {
      if (!results[0] || results[0].ok === false) throw helperError(results[0] || {});
      result = results[0];
    }
    return seen.action(bot, pid, { ...result, ...tree });
  }

  return {
    apps: () => driver.apps(),
    snapshot,
    action,
    menu: (pid, path) => driver.menu(pid, Array.isArray(path) ? path.filter((part) => typeof part === 'string') : []),
    screenshot: (pid, maxWidth) => driver.screenshot(pid, maxWidth),
    close: () => driver.close(),
  };
}

// platform.command(mode) -> [file, ...args]; shared by mac, Windows, and Linux.
function createComputer({ command, env }) {
  const helper = createHelper({ command, env });
  const driver = {
    apps: async () => (await helper.request({ cmd: 'apps' })).apps || [],
    snapshot: async (pid, { menubar } = {}) => {
      const { id, ...tree } = await helper.request({ cmd: 'snapshot', pid, ...(menubar ? { menubar: true } : {}) });
      return tree;
    },
    act: async (pid, { steps, generation, menubar }) => {
      const { ok, id, ...reply } = await helper.request({
        cmd: 'act', pid, steps, ...(Number.isInteger(generation) ? { generation } : {}), ...(menubar ? { menubar: true } : {}),
      });
      return reply;
    },
    menu: async (pid, path) => { const { ok, id, ...list } = await helper.request({ cmd: 'menu', pid, path }); return list; },
    screenshot: async (pid, maxWidth) => {
      const cap = Number.isInteger(maxWidth) ? Math.min(Math.max(maxWidth, 320), 1280) : 960;
      const shot = await helper.request({ cmd: 'shot', pid, maxWidth: cap });
      return {
        image: shot.image, imageWidth: shot.imageWidth, imageHeight: shot.imageHeight,
        windowX: shot.windowX, windowY: shot.windowY, windowWidth: shot.windowWidth, windowHeight: shot.windowHeight,
      };
    },
    close: () => helper.close(),
  };
  return { driver, service: createComputerService(driver), close: () => helper.close() };
}

module.exports = { createHelper, createComputer, createComputerService, normalizeStep, normalizeKey, binaryCurrent, recordBuild };

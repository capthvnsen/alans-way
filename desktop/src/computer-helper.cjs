'use strict';

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { calls, context, remainingMs, checkCall, waitInCall, READ_BUDGET_MS } = require('./call-budget.cjs');
const { helperPolicy, isBlocked } = require('./computer-policy.cjs');
const { createComputerSnapshots } = require('./computer-snapshot.cjs');

const REQUEST_TIMEOUT_MS = 20000;
const ONCE_RETRY_MS = 60000;
const STEP_LIMIT = 25;
const WAIT_POLL_MS = 150;
// Waits and act runs in one call start only within this budget. A run started
// just before it ends can still take REQUEST_TIMEOUT_MS (20 s), keeping the call
// well under the connector's 90 s abort.
const CALL_BUDGET_MS = 45000;
const READ_ONLY = new Set(['init', 'apps', 'snapshot', 'shot', 'menu', 'permissions']);

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
    checkCall();
    const [file, ...args] = await command(mode);
    checkCall();
    return spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], env: env || process.env });
  }

  async function persistent(request, tracking) {
    checkCall();
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
    tracking.proc = state.proc;
    checkCall();
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        state.waiter = null;
        try { state.proc.kill('SIGKILL'); } catch { /* already gone */ }
        state.die('Computer helper timed out.');
        reject(Object.assign(new Error('Computer helper timed out.'), { timedOut: true }));
      }, Math.ceil(remainingMs(request.timeoutMs || timeoutMs)));
      state.waiter = { id, resolve, reject, timer };
      const { timeoutMs: _ignored, ...wire } = request;
      tracking.dispatched = true;
      state.proc.stdin.write(JSON.stringify({ ...wire, id }) + '\n');
    });
  }

  async function once(request, tracking) {
    const proc = await spawnHelper('once');
    tracking.proc = proc;
    checkCall();
    return new Promise((resolve, reject) => {
      let out = '', err = '';
      const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } reject(new Error('Computer helper timed out.')); }, Math.ceil(remainingMs(request.timeoutMs || timeoutMs)));
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
      tracking.dispatched = true;
      proc.stdin.end(JSON.stringify({ ...wire, id: 1, policy }) + '\n');
    });
  }

  async function run(request, tracking) {
    checkCall();
    if (Date.now() >= onceUntil) {
      try { return await persistent(request, tracking); }
      catch (error) {
        if (!error.helperDied) throw error;
        if (error.neverAnswered) {
          onceUntil = Date.now() + ONCE_RETRY_MS;
          tracking.dispatched = false;
        }
        checkCall();
        if (!error.neverAnswered && !READ_ONLY.has(request.cmd)) throw new Error(`Computer helper stopped mid-action; the action may have executed. Check the app before retrying. ${error.message}`.slice(0, 300));
        // A failed init can use one-shot mode; an answered helper's lost action is never replayed.
      }
      if (Date.now() >= onceUntil) return persistent(request, tracking);
    }
    return once(request, tracking);
  }

  // An app that was only just opened or activated can be missing from the
  // process list for a moment, so one retry before saying so.
  async function runWithRetry(body, tracking) {
    let response = await run(body, tracking);
    // The app-not-found text alone decides: a menu path or point that is missing says something else.
    const appMissing = (item) => item && item.ok === false && item.code === 'not_found' && /^App not found/.test(item.error || '');
    if (appMissing(response)) {
      checkCall();
      await waitInCall(new Promise((resolve) => setTimeout(resolve, Math.ceil(remainingMs(150)))));
      response = await run(body, tracking);
      if (appMissing(response))
        response = { ...response, error: 'App not found. If it was just opened or activated, wait a moment and retry.' };
    }
    return response;
  }

  async function request(body) {
    const call = calls.getStore() || context(undefined, undefined, READ_ONLY.has(body.cmd) ? READ_BUDGET_MS : Infinity);
    return calls.run(call, async () => {
      checkCall();
      let active = false;
      const tracking = { dispatched: false };
      const next = chain.then(async () => {
        checkCall();
        active = true;
        try { return await runWithRetry(body, tracking); }
        finally { active = false; }
      });
      chain = next.catch(() => {});
      let response;
      try {
        response = await waitInCall(next, () => {
          if (!active || !tracking.proc) return;
          try { tracking.proc.kill('SIGKILL'); } catch { /* already gone */ }
          if (child?.proc === tracking.proc) { child.die('Computer call stopped.'); child = null; }
        });
      } catch (error) {
        if (!READ_ONLY.has(body.cmd) && tracking.dispatched)
          error.message += ' The action may have executed. Check the app before retrying.';
        throw error;
      }
      if (!response || response.ok === false) throw helperError(response || {});
      return response;
    });
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

const REF_ACTIONS = new Set(['press', 'type', 'select_text', 'secondary_action']);
const POINT_OR_REF = new Set(['double_click', 'right_click', 'scroll']);

function normalizeStep(item) {
  const step = item && typeof item === 'object' ? item : {};
  const action = step.action;
  if (action === 'key' || action === 'hotkey') return normalizeKey(step);
  if (action === 'wait') {
    if (typeof step.text !== 'string' || !step.text || step.text.length > 200)
      throw fail('bad_request', 'wait needs text: a few words of the element name or value to wait for.');
    const timeout = Number.isFinite(step.timeout) ? Math.min(Math.max(step.timeout, 100), 15000) : 5000;
    return { action: 'wait', text: step.text, gone: step.gone === true, timeout };
  }
  if (action === 'type' && (typeof step.text !== 'string' || step.text.length > 2000))
    throw fail('bad_request', 'Text must be a string of at most 2000 characters.');
  // A desktop the agent owns types at the focused window; so does a Mac, whose helper checks that window and field first.
  const focusType = action === 'type' && step.ref === undefined && (process.env.ALANS_WAY_AGENT_DESKTOP === '1' || process.platform === 'darwin');
  if (REF_ACTIONS.has(action) && !focusType && typeof step.ref !== 'string') throw fail('bad_request', `${action} needs a ref.`);
  if (action === 'select_text' && (typeof step.text !== 'string' || !step.text || step.text.length > 2000 ||
      ['prefix', 'suffix'].some((key) => step[key] !== undefined && (typeof step[key] !== 'string' || step[key].length > 2000)) ||
      (step.selection !== undefined && !['text', 'cursor_before', 'cursor_after'].includes(step.selection))))
    throw fail('bad_request', 'select_text needs text and optional prefix, suffix and selection (text, cursor_before or cursor_after).');
  if (action === 'secondary_action' && !['AXShowMenu', 'AXIncrement', 'AXDecrement', 'AXConfirm', 'AXPick'].includes(step.secondaryAction))
    throw fail('bad_request', 'secondary_action needs an advertised secondaryAction: AXShowMenu, AXIncrement, AXDecrement, AXConfirm or AXPick.');
  if (action === 'menu' && !(Array.isArray(step.path) && step.path.length && step.path.every((part) => typeof part === 'string')))
    throw fail('bad_request', 'menu needs a path such as ["File","Save"].');
  if (action === 'scroll' && !['up', 'down', 'left', 'right'].includes(step.direction))
    throw fail('bad_request', 'scroll needs a direction: up, down, left, or right.');
  if (!REF_ACTIONS.has(action) && !POINT_OR_REF.has(action) && !['click', 'drag', 'menu', 'activate'].includes(action))
    throw fail('bad_request', 'Computer action must be press, type, select_text, secondary_action, click, double_click, right_click, drag, scroll, key, hotkey, menu, activate, wait, or batch.');
  return step;
}

const needsGeneration = (step) => typeof step.ref === 'string';

function windowOptions(windowId) {
  if (windowId === undefined) return {};
  if (!Number.isInteger(windowId) || windowId < 1 || windowId > 0xffffffff)
    throw fail('bad_request', 'windowId must be a positive window number.');
  return { windowId };
}

// The verbs shared by the MCP connector and the app's loopback API.
function createComputerService(driver) {
  const seen = createComputerSnapshots();

  async function snapshot(bot, pid, { since, menubar, windowId, delta } = {}) {
    return seen.snapshot(bot, pid, await driver.snapshot(pid, { menubar: menubar === true, ...windowOptions(windowId) }), since, delta);
  }

  // Polls the tree until an element's name or value contains the text (or no
  // longer does), so one call can act and then confirm what the action caused.
  async function waitFor(pid, step, tree, menubar, pin, deadline, window) {
    const needle = step.text.toLowerCase();
    const present = (current) => current.elements.some((element) => `${element.name || ''}\n${element.value || ''}`.toLowerCase().includes(needle));
    const started = Date.now();
    const until = Math.min(started + step.timeout, deadline);
    for (;;) {
      if (tree && Array.isArray(tree.elements) && present(tree) !== step.gone) return { tree, result: { ok: true, waitedMs: Date.now() - started } };
      if (Date.now() >= until) {
        return { tree, result: { ok: false, code: 'timeout', error: `"${step.text}" did not ${step.gone ? 'go away' : 'appear'} within ${Date.now() - started}ms; the tree in this reply is the latest.` } };
      }
      try {
        checkCall();
        if (tree) await waitInCall(new Promise((resolve) => setTimeout(resolve, Math.ceil(remainingMs(WAIT_POLL_MS)))));
        checkCall();
        const { ok, ...latest } = await driver.snapshot(pid, { menubar, pin, ...window });
        tree = latest;
      } catch (error) {
        // The app quitting is what a wait for its text to go can be waiting for.
        if (step.gone && error.code === 'not_found') return { tree, result: { ok: true, waitedMs: Date.now() - started, note: 'The app is gone.' } };
        // The steps before this wait ran; report the wait failing rather than losing them.
        return { tree, result: { ok: false, code: error.code || 'failed', error: error.message } };
      }
    }
  }

  async function action(bot, pid, body) {
    const window = windowOptions(body.windowId === undefined ? seen.windowId(bot, pid) : body.windowId);
    // Raising a window acts on none of its content, so a lone activate may name one this bot has not read yet.
    const onlyActivate = body.action === 'activate';
    if (!onlyActivate && seen.windowId(bot, pid) !== undefined && window.windowId !== seen.windowId(bot, pid))
      throw fail('stale_window', 'Take a snapshot of the selected window before acting.');
    const batch = body.action === 'batch';
    const raw = batch ? (Array.isArray(body.steps) ? body.steps.slice(0, STEP_LIMIT) : []) : [body];
    const steps = raw.map(normalizeStep);
    if (steps.some(needsGeneration) && !Number.isInteger(body.generation))
      throw fail('stale_ref', 'Pass the generation from your latest snapshot with every action that uses a ref.');
    const menubar = body.menubar === true;
    const results = [];
    const deadline = Date.now() + CALL_BUDGET_MS;
    let tree = null;
    // Steps run in runs between waits. Every run carries the caller's own
    // generation, so a ref is always checked against the tree the caller saw.
    for (let at = 0; at < steps.length;) {
      try { checkCall(); }
      catch (error) { results.push({ ok: false, code: error.code, error: error.message }); break; }
      if (steps[at].action === 'wait') {
        const waited = await waitFor(pid, steps[at++], tree, menubar, body.generation, deadline, window);
        tree = waited.tree;
        results.push(waited.result);
        if (waited.result.ok === false) break;
        continue;
      }
      let end = at;
      while (end < steps.length && steps[end].action !== 'wait') end++;
      if (Date.now() >= deadline) {
        results.push({ ok: false, code: 'timeout', error: `Out of time: this call used its ${CALL_BUDGET_MS / 1000}s, so this step and the ones after it did not run. The tree in this reply is the latest; continue in a new call.` });
        break;
      }
      let reply;
      try { reply = await driver.act(pid, { steps: steps.slice(at, end), generation: body.generation, menubar, ...window }); }
      catch (error) {
        // Nothing ran yet: fail the call as before. Later, earlier steps did run and must be reported.
        if (!results.length) throw error;
        results.push({ ok: false, code: error.code || 'failed', error: error.message });
        break;
      }
      const { results: done = [], ...latest } = reply;
      results.push(...done);
      // A run whose first step failed brings no tree; the one before it still stands.
      tree = Array.isArray(latest.elements) || !tree ? latest : { ...tree, ...latest };
      at = end;
      if (done.some((item) => item.ok === false)) break;
    }
    let result;
    if (batch) result = { results: results.map(({ ok, ...rest }) => (ok === false ? { error: rest.error, code: rest.code } : { ok, ...rest })) };
    else {
      if (!results[0] || results[0].ok === false) throw helperError(results[0] || {});
      result = results[0];
    }
    return seen.action(bot, pid, { ...result, ...(tree || {}) }, body.generation);
  }

  return {
    ...(driver.launch ? { launch: (app, path) => driver.launch(app, path) } : {}),
    ...(driver.permissions ? { permissions: () => driver.permissions() } : {}),
    ...(driver.requestScreenAccess ? { requestScreenAccess: () => driver.requestScreenAccess() } : {}),
    // Off-limits apps would only be refused, so they are not offered.
    apps: async () => (await driver.apps())
      .filter((app) => !(app.pid < 0) && !isBlocked(app.bundleId))
      .map(({ frontmost, ...app }) => (frontmost ? { ...app, frontmost } : app)),
    snapshot,
    action,
    menu: (pid, path) => driver.menu(pid, Array.isArray(path) ? path.filter((part) => typeof part === 'string') : []),
    screenshot: async (pid, maxWidth, { windowId, bot } = {}) => driver.screenshot(pid, maxWidth, windowOptions(windowId === undefined ? seen.windowId(bot, pid) : windowId)),
    close: () => driver.close(),
  };
}

// platform.command(mode) -> [file, ...args]; shared by mac, Windows, and Linux.
function createComputer({ command, env, nativeMac = false }) {
  const helper = createHelper({ command, env });
  // A permission dialog must never occupy the app's AX request queue.
  const permissionHelper = nativeMac ? createHelper({ command, env }) : null;
  let windowSupport;
  async function requireWindowSupport(windowId) {
    if (windowId === undefined) return;
    windowSupport ||= helper.request({ cmd: 'init' }).then((reply) => reply.windowBinding === true).catch((error) => { windowSupport = null; throw error; });
    if (!await windowSupport) throw fail('unsupported_window', 'This helper cannot select a window. Update it before retrying.');
  }
  const driver = {
    ...(nativeMac ? {
      requestScreenAccess: async () => {
        try { return await permissionHelper.request({ cmd: 'request_screen' }); }
        finally { permissionHelper.close(); }
      },
      launch: async (app, path) => {
        if (path !== undefined && (typeof path !== 'string' || !path.startsWith('/') || path.length > 1024 || path.includes('\n')))
          throw fail('bad_request', "Give the file's absolute path.");
        if ((path === undefined || app !== undefined) && (typeof app !== 'string' || !app.trim() || app.length > 200 || /[/:\n]/.test(app)))
          throw fail('bad_request', 'Choose an app by its name or bundle identifier.');
        const { ok, id, ...reply } = await helper.request({ cmd: 'launch', ...(app !== undefined ? { app } : {}), ...(path !== undefined ? { path } : {}) });
        return reply;
      },
      permissions: async () => {
        const { ok, id, ...reply } = await helper.request({ cmd: 'permissions' });
        return reply;
      },
    } : {}),
    apps: async () => (await helper.request({ cmd: 'apps' })).apps || [],
    snapshot: async (pid, { menubar, pin, windowId } = {}) => {
      await requireWindowSupport(windowId);
      const { id, ...tree } = await helper.request({ cmd: 'snapshot', pid, ...windowOptions(windowId), ...(menubar ? { menubar: true } : {}), ...(Number.isInteger(pin) ? { pin } : {}) });
      return tree;
    },
    act: async (pid, { steps, generation, menubar, windowId }) => {
      await requireWindowSupport(windowId);
      const { ok, id, ...reply } = await helper.request({
        cmd: 'act', pid, steps, ...windowOptions(windowId), ...(Number.isInteger(generation) ? { generation } : {}), ...(menubar ? { menubar: true } : {}),
      });
      return reply;
    },
    menu: async (pid, path) => { const { ok, id, ...list } = await helper.request({ cmd: 'menu', pid, path }); return list; },
    screenshot: async (pid, maxWidth, { windowId } = {}) => {
      await requireWindowSupport(windowId);
      const cap = Number.isInteger(maxWidth) ? Math.min(Math.max(maxWidth, 320), 1280) : 960;
      const shot = await helper.request({ cmd: 'shot', pid, maxWidth: cap, ...windowOptions(windowId) });
      return {
        ...(shot.windowId === undefined ? {} : { windowId: shot.windowId }),
        image: shot.image, imageWidth: shot.imageWidth, imageHeight: shot.imageHeight,
        windowX: shot.windowX, windowY: shot.windowY, windowWidth: shot.windowWidth, windowHeight: shot.windowHeight,
        ...(shot.note ? { note: shot.note } : {}),
      };
    },
    close: () => { helper.close(); permissionHelper?.close(); },
  };
  return { driver, service: createComputerService(driver), close: () => driver.close() };
}

module.exports = { createHelper, createComputer, createComputerService, normalizeStep, normalizeKey, binaryCurrent, recordBuild };

'use strict';
// Declarative control flow for batch steps: `if`, `repeat`, and a wait for a
// control by name. A condition is a fixed read-only page probe built from
// data (selector, text, url, name); the model never supplies code, and every
// step inside a flow runs through the host's own per-step path, so the commit
// gate and origin checks apply to it exactly as to a single action.
const { refsSource } = require('./browser-page.cjs');

const FLOW_ACTIONS = new Set(['if', 'repeat']);
const MAX_INNER = 10, MAX_ROUNDS = 20, DEFAULT_ROUNDS = 10, MAX_LEAVES = 60, MAX_TEXT = 2000;
const bad = (message) => Object.assign(new Error(message), { status: 400 });

function checkCondition(c, label) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw bad(`${label} needs a condition object with selector, text, url or name.`);
  if (!['selector', 'text', 'url', 'name'].some((k) => typeof c[k] === 'string' && c[k])) throw bad(`${label} needs one of selector, text, url or name.`);
  for (const k of ['selector', 'text', 'url', 'name', 'role', 'row'])
    if (c[k] !== undefined && (typeof c[k] !== 'string' || c[k].length > MAX_TEXT)) throw bad(`${label}: ${k} must be a string of at most ${MAX_TEXT} characters (selector, text, url or name).`);
  return c;
}
function checkList(list, label, min) {
  if (!Array.isArray(list)) throw bad(`${label} must be an array of steps.`);
  if (list.length < min || list.length > MAX_INNER) throw bad(min ? `${label} needs 1 to ${MAX_INNER} steps.` : `${label} takes at most ${MAX_INNER} steps.`);
  for (const s of list) {
    if (!s || typeof s !== 'object' || typeof s.action !== 'string') throw bad(`${label}: each step needs an action.`);
    if (FLOW_ACTIONS.has(s.action) || s.action === 'batch') throw bad(`${label}: if, repeat and batch cannot nest.`);
  }
}
function validate(step) {
  if (step.action === 'if') {
    if (step.when === undefined) throw bad('if needs when: {selector|text|url|name}.');
    checkCondition(step.when, 'if when');
    if (!Array.isArray(step.then)) throw bad('if then must be an array of steps.');
    checkList(step.then, 'if then', 0);
    if (step.else !== undefined) checkList(step.else, 'if else', 0);
  } else if (step.action === 'repeat') {
    if (step.until === undefined) throw bad('repeat needs until: {selector|text|url|name}.');
    checkCondition(step.until, 'repeat until');
    checkList(step.steps, 'repeat steps', 1);
    if (step.max !== undefined && !(Number.isInteger(step.max) && step.max >= 1 && step.max <= MAX_ROUNDS)) throw bad(`repeat max must be 1 to ${MAX_ROUNDS}.`);
  }
  return step;
}
// Refuse a malformed flow step anywhere in the batch before the first step runs.
const validateBatch = (steps) => { for (const s of steps) if (s && FLOW_ACTIONS.has(s.action)) validate(s); };

// One batch shares a step budget and the host's wall-clock budget.
function context(budgetMs, now = Date.now) {
  const c = { leaves: 0, started: now(), expired: () => now() - c.started > budgetMs };
  return c;
}

// True when the condition holds now. Read only: querySelector, innerText, the
// url, and the same exact-name lookup an action by name uses. gone inverts it.
function conditionExpression(c, seed = 0) {
  const q = (v) => JSON.stringify(typeof v === 'string' ? v.slice(0, MAX_TEXT) : '');
  return `(() => {
    const sel = ${q(c.selector)}, txt = ${q(c.text)}, urlP = ${q(c.url)}, name = ${q(c.name)}, role = ${q(c.role)}, row = ${q(c.row)}, vis = ${c.visible === true}, gone = ${c.gone === true};
    const here = (() => {
      if (urlP && !location.href.includes(urlP)) return false;
      if (sel) {
        const el = document.querySelector(sel);
        if (!el) return false;
        if (vis) { const r = el.getBoundingClientRect(); if (!r.width || !r.height || (el.checkVisibility && !el.checkVisibility({ checkVisibilityCSS: true }))) return false; }
      }
      if (txt && !(document.body && document.body.innerText.includes(txt))) return false;
      if (name) { const n = ${refsSource(seed)}.byName(name, role, row); if (!n.el && !n.many) return false; }
      return true;
    })();
    return here !== gone;
  })()`;
}
const describe = (c) => [c.selector && `selector ${JSON.stringify(c.selector)}`, c.text && `text ${JSON.stringify(c.text.slice(0, 80))}`, c.url && `url containing ${JSON.stringify(c.url.slice(0, 80))}`,
  c.name && `a control named ${JSON.stringify(c.name)}${c.role ? ` with role ${c.role}` : ''}${c.row ? ` in a row with ${JSON.stringify(c.row)}` : ''}`].filter(Boolean).join(' and ');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function poll(cond, test, ms, pollMs, aborted) {
  const end = Date.now() + ms;
  for (;;) {
    if (await test(cond)) return true;
    if (Date.now() >= end || aborted()) return false;
    await sleep(Math.min(pollMs, Math.max(1, end - Date.now())));
  }
}
// wait with a name (and any other condition keys) in one polling loop.
async function waitFor(c, { test, timeoutMs, pollMs = 250, aborted = () => false }) {
  checkCondition(c, 'wait');
  const t0 = Date.now();
  if (await poll(c, test, timeoutMs, pollMs, aborted)) return { found: true, waited: Date.now() - t0 };
  if (aborted()) throw Object.assign(new Error('The request was closed before the wait finished.'), { status: 499 });
  throw Object.assign(new Error(`wait timed out after ${Date.now() - t0}ms for ${c.gone ? 'absence of ' : ''}${describe(c)}. Snapshot the page to see its current state.`), { status: 408 });
}

const hasInput = (step, input) => FLOW_ACTIONS.has(step.action) && [...(step.then || []), ...(step.else || []), ...(step.steps || [])].some((s) => input.has(s.action));

// leaf(step) runs one inner step through the host's normal per-step path;
// test(cond) answers the probe; before() is the host's cancel/budget check.
async function run(step, { ctx, leaf, test, before = () => {}, settleMs = 400, aborted = () => false }) {
  validate(step);
  const stop = (message, results) => Object.assign(new Error(message), { status: 408, flowResults: results });
  const exec = async (list) => {
    const out = [];
    let clicked;
    for (const inner of list) {
      before();
      if (ctx.expired()) throw stop('batch time budget used up; remaining steps were not run. Snapshot, then continue.', out);
      if (++ctx.leaves > MAX_LEAVES) throw stop(`batch ran more than ${MAX_LEAVES} steps counting repeats; remaining steps were not run.`, out);
      try {
        const { clicked: c, ...r } = await leaf(inner);
        out.push({ ok: true, ...r });
        if (c) clicked = c;
      } catch (error) {
        out.push({ ok: false, error: error && error.message || String(error) });
        throw Object.assign(error, { flowResults: out });
      }
    }
    return { out, clicked };
  };
  if (step.action === 'if') {
    const hit = await test(step.when);
    const { out, clicked } = await exec(hit ? step.then : step.else || []);
    return { branch: hit ? 'then' : step.else ? 'else' : 'none', results: out, ...(clicked ? { clicked } : {}) };
  }
  const max = step.max ?? DEFAULT_ROUNDS;
  let rounds = 0, last = [], clicked;
  while (!(await test(step.until))) {
    if (rounds >= max) throw stop(`repeat: ${describe(step.until)} not met after ${max} rounds. Snapshot the page to see its current state.`, last);
    const round = await exec(step.steps);
    last = round.out;
    clicked = round.clicked || clicked;
    rounds++;
    // Let a lazy load the round started land before judging it.
    if (settleMs > 0 && await poll(step.until, test, settleMs, 100, aborted)) break;
  }
  return { iterations: rounds, results: last, ...(clicked ? { clicked } : {}) };
}

module.exports = { FLOW_ACTIONS, validate, validateBatch, context, conditionExpression, waitFor, run, hasInput, MAX_LEAVES };

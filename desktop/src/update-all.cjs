'use strict';

// The bottom bar's versions and its one-click "Update everything": reading
// what the agent machine reports, deciding what is behind, and running the
// update steps in order (Hermes, its plugin, the browser host, then this app)
// with the first failure stopping the rest.
const { redactReport } = require('./setup-check.cjs');
const { vmPluginLines } = require('./vm-update.cjs');

const PLUGIN_REPO = 'capthvnsen/alans-way-agents';
const NAMES = { hermes: 'Hermes', plugin: 'Alan’s Way plugin', host: 'Browser host', app: 'Alan’s Workspace' };
// The Telegram report travels as plain text (vm-update.cjs plainText), so it
// uses names without the curly apostrophe.
const SHORT = { hermes: 'Hermes', plugin: 'plugin', host: 'browser host', app: 'app' };

const { normalizeVersion, compareVersions } = require('./update-version.cjs');
const isNewer = (a, b) => compareVersions(a, b) === 1;

// "Hermes Agent v0.21.6+763.g1fd1827 (2026.9.24) · stable" -> "0.21.6".
const parseHermesVersion = (text) => /Hermes Agent v(\d+\.\d+\.\d+)/.exec(String(text || ''))?.[1] || '';

// `hermes update --check` exits 0 whether or not an update exists; the verdict
// is the text. A release channel names its target ("Selected release
// available: stable v0.21.7 (…)"); a branch install only says it is behind.
// available is null when there was no verdict (offline, a docker install).
function parseHermesCheck(text) {
  const t = String(text || '');
  if (/up to date|no newer release|no update available/i.test(t)) return { available: false, latest: '' };
  if (/update available|release available/i.test(t)) return { available: true, latest: /release available:.*?\bv(\d+\.\d+\.\d+)/i.exec(t)?.[1] || '' };
  return { available: null, latest: '' };
}

// The newest plain vX.Y.Z among tag names; pre-releases never count.
function newestTag(names) {
  let best = '';
  for (const name of names || []) {
    const version = /^v(\d+\.\d+\.\d+)$/.exec(String(name || ''))?.[1];
    if (version && (!best || isNewer(version, best))) best = version;
  }
  return best;
}

// ponytail: first 100 tags only; page through when the plugin repo outgrows that.
async function latestPluginTag(fetchImpl = fetch) {
  const res = await fetchImpl(`https://api.github.com/repos/${PLUGIN_REPO}/tags?per_page=100`, { headers: { accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) return '';
  const tags = await res.json();
  return newestTag(Array.isArray(tags) ? tags.map((tag) => tag?.name) : []);
}

// The cache the bar renders from. An unreachable machine keeps the last known
// versions and only flips `offline`, so the tooltip can still say what ran
// there when it was last seen.
function versionRecord(previous, { target, check, pluginLatest = '', now }) {
  const where = target?.local ? 'local' : 'server';
  const base = previous?.where === where ? previous : {};
  const stamp = { where, checkedAt: now, pluginLatest: pluginLatest || base.pluginLatest || '' };
  if (!check?.ok) return { ...base, ...stamp, offline: true };
  const verdict = parseHermesCheck(check.hermesCheck);
  return { ...stamp, offline: false, hermes: parseHermesVersion(check.hermesVersion),
    hermesUpdate: verdict.available, hermesLatest: verdict.latest, plugin: String(check.pluginVersion || ''),
    host: String(check.hostVersion || check.version || ''), gatewayRunning: typeof check.gatewayRunning === 'boolean' ? check.gatewayRunning : null };
}

// The steps "Update everything" would run, in run order, each with the
// versions it moves between. Hermes joins unless its check said it is
// current: `hermes update` is a no-op then, so a check that gave no verdict
// never hides an update. The browser host follows the app version it will
// run with; it only exists on a server.
function planSteps({ app, appUpdate = '', cache } = {}) {
  const c = cache || {};
  const steps = [];
  if (c.hermes && !c.offline && c.hermesUpdate !== false) steps.push({ id: 'hermes', from: c.hermes, to: c.hermesLatest || 'latest' });
  if (c.plugin && !c.offline && c.pluginLatest && isNewer(c.pluginLatest, c.plugin)) steps.push({ id: 'plugin', from: c.plugin, to: c.pluginLatest });
  const appTarget = appUpdate && isNewer(appUpdate, app) ? appUpdate : app;
  if (c.where === 'server' && c.host && !c.offline && isNewer(appTarget, c.host)) steps.push({ id: 'host', from: c.host, to: appTarget });
  if (appTarget !== app) steps.push({ id: 'app', from: app, to: appTarget });
  return steps.map((step) => ({ ...step, name: NAMES[step.id] }));
}

// The bar text, its hover tooltip and the update plan, from one cache.
function describeVersions({ app, appUpdate = '', cache, formatTime = (ms) => new Date(ms).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) } = {}) {
  const c = cache || {};
  const where = c.where === 'local' ? 'this computer' : 'the server';
  const steps = planSteps({ app, appUpdate, cache: c });
  const behind = (id) => steps.find((step) => step.id === id);
  const parts = [`Alan’s Workspace ${app}`];
  if (c.offline) parts.push('Hermes: offline');
  else if (c.hermes) parts.push(`Hermes ${c.hermes} (${c.where === 'local' ? 'local' : 'server'})`);
  if (!c.offline && c.plugin) parts.push(`Plugin ${c.plugin}`);
  const lines = [`Alan’s Workspace ${app}${behind('app') ? ` · ${appUpdate} ready to install` : ''}`];
  if (c.offline) lines.push(`Hermes: offline, ${where} did not answer${c.hermes ? ` (last seen ${c.hermes})` : ''}`);
  else if (c.hermes) lines.push(`Hermes ${c.hermes} on ${where}${c.hermesUpdate ? ` · ${c.hermesLatest || 'an update'} available` : c.hermesUpdate === false ? ' · up to date' : ''}`);
  else if (c.where) lines.push(`Hermes: not found on ${where}`);
  if (c.plugin) lines.push(`Alan’s Way plugin ${c.plugin}${behind('plugin') ? ` · ${c.pluginLatest} on GitHub` : ''}`);
  if (c.where === 'server' && c.host) lines.push(`Browser host ${c.host} on the server${behind('host') ? ` · ${behind('host').to} goes with this app` : ''}`);
  lines.push(c.checkedAt ? `Checked ${formatTime(c.checkedAt)}` : 'Not checked yet');
  const hasUpdate = steps.some((step) => step.id !== 'hermes') || c.hermesUpdate === true;
  return { text: parts.join(' · '), tooltip: lines.join('\n'), steps, hasUpdate };
}

// Convert every profile's plugin result into evidence for the single step.
// A successful guest process is not proof that any plugin reached its target.
function pluginStepResult(result, step) {
  const plugins = Array.isArray(result?.plugins) ? result.plugins : [];
  const installed = plugins.filter((p) => ['alans-way', 'alans-way-computer'].includes(p.name));
  const missed = installed.find((p) => compareVersions(p.after, step.to) === null || compareVersions(p.after, step.to) < 0);
  const version = (missed || installed[0])?.after || '';
  const lines = vmPluginLines({ ...result, plugins: installed }, { target: step.to });
  const detail = lines.length ? lines.map((line) => line.text).join(' ') : 'No alans-way plugin was visited; check its profile, install path and Hermes CLI.';
  return { ok: result?.ok === true, error: result?.error ? `${result.error} ${detail}` : '', version,
    warning: !installed.length || Boolean(missed) || lines.some((line) => line.tone === 'warn'),
    detail };
}

function comparisonLatest(row, result) {
  const before = normalizeVersion(result?.before || row.from);
  const movement = compareVersions(row.version, before);
  return movement !== null && (movement > 0 || result?.current === true ||
    (result?.updated === true && result?.before && movement === 0 && row.version !== before));
}

// A failure stops the remaining steps. A version shortfall is a warning:
// the other components can still update, and only proven targets get a tick.
async function runSteps(steps, runStep, onChange = () => {}) {
  const rows = steps.map((step) => ({ ...step, state: 'pending', detail: '', error: '', version: '' }));
  const emit = () => onChange(rows.map((row) => ({ ...row })));
  let stopped = false;
  emit();
  for (const row of rows) {
    if (stopped) { row.state = 'skipped'; continue; }
    row.state = 'running'; emit();
    let result;
    try { result = await runStep(row); } catch (error) { result = { ok: false, error: error?.message || String(error) }; }
    row.version = redactReport(normalizeVersion(result?.version));
    row.detail = redactReport(String(result?.detail || ''));
    const comparison = compareVersions(row.version, row.to);
    const reached = row.id === 'app' || (row.to === 'latest'
      ? comparisonLatest(row, result)
      : comparison !== null && comparison >= 0);
    row.state = result?.ok !== true ? 'failed' : !reached || result?.warning ? 'warn' : 'done';
    row.error = row.state === 'failed' ? redactReport(String(result?.error || 'it failed without a reason'))
      : row.state === 'warn' ? redactReport(String(result?.error || row.detail || (compareVersions(row.version, row.version) !== null ? 'The installed version did not reach the target.' : 'The installed version could not be verified.'))) : '';
    row.warningText = row.state === 'warn' ? warningText(row) : '';
    if (row.version && row.state === 'done') row.to = row.version;
    stopped = row.state === 'failed';
    emit();
  }
  emit();
  return rows;
}

function warningText(row, subject = row.name) {
  const version = compareVersions(row.version, row.version) !== null ? `${compareVersions(row.version, row.from) === 0 ? 'unchanged' : 'on'} ${row.version}` : 'version unverified';
  return `${subject} ${version} (wanted ${row.to}): ${row.error}`;
}

// The same verdict and per-plugin reasons are visible in the log and UI.
function runLogText(rows) {
  return rows.map((row) => row.state === 'warn' ? warningText(row, row.id)
    : `${row.id} ${row.state}${row.error ? ` ${row.error}` : ''}${row.detail && row.detail !== row.error ? `: ${row.detail}` : ''}`).join(', ');
}

function summarizeRun(rows, { gatewayRunning = null, where = 'server' } = {}) {
  const failed = rows.find((row) => row.state === 'failed');
  const named = (state) => rows.filter((row) => row.state === state).map((row) => row.name);
  const warnings = rows.filter((row) => row.state === 'warn');
  const parts = [];
  if (failed) parts.push(`${failed.name} did not update: ${failed.error.replace(/[.!?]?\s*$/, '.')}`);
  else if (!warnings.length) parts.push('Everything is updated.');
  for (const row of warnings) parts.push(`${warningText(row).replace(/[.!?]?\s*$/, '.')}`);
  if ((failed || warnings.length) && named('done').length) parts.push(`Updated: ${named('done').join(', ')}.`);
  if (named('skipped').length) parts.push(`Not started, still on the old version: ${named('skipped').join(', ')}.`);
  if (!failed && rows.some((row) => row.id === 'app' && row.state === 'done')) parts.push('Restart to finish the app update.');
  if (gatewayRunning === false) parts.push(`Hermes says your bot’s gateway is not running on the ${where}. Start it there (hermes gateway start, or your service manager).`);
  return parts.join(' ');
}

function reportText(rows) {
  const failed = rows.find((row) => row.state === 'failed');
  const warnings = rows.filter((row) => row.state === 'warn');
  const done = rows.filter((row) => row.state === 'done' && row.id !== 'app' && row.to !== row.from).map((row) => `${SHORT[row.id]} ${row.to}`);
  const app = rows.find((row) => row.id === 'app' && row.state === 'done');
  const head = failed ? `Update everything stopped at the ${SHORT[failed.id]}: ${failed.error}.`
    : warnings.length ? 'Update everything finished with warnings.' : 'Update everything finished.';
  const skipped = rows.filter((row) => row.state === 'skipped').map((row) => SHORT[row.id]);
  return [head, ...warnings.map((row) => `${warningText(row, SHORT[row.id])}.`), done.length ? `Now on ${done.join(', ')}.` : '', skipped.length ? `Not started: ${skipped.join(', ')}.` : '',
    app ? `The app installs ${app.to} when you restart it.` : ''].filter(Boolean).join(' ');
}

// The question asked before "Restart to finish" when bots are mid-task in a
// tab here; null when nobody is working.
function restartWarning(names) {
  const list = [...new Set(names || [])];
  if (!list.length) return null;
  const who = list.length === 1 ? `${list[0]} is` : `${list.slice(0, -1).join(', ')} and ${list.at(-1)} are`;
  return { message: `${who} working in a tab right now.`, detail: 'Restarting interrupts that task. The update installs whenever you restart, so you can wait until they finish.' };
}

module.exports = { restartWarning, compareVersions, parseHermesVersion, parseHermesCheck, newestTag, latestPluginTag, versionRecord, planSteps, describeVersions, runSteps, summarizeRun, reportText, pluginStepResult, runLogText, warningText };

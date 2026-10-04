// Agent-mode visuals: a controlled tab shows an inset tint frame, a dispatched
// action glides a named cursor to a blue element highlight, and the workspace
// state marks the tab agent-busy. Runs the real app in a disposable profile.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const electron = require('electron');
if (typeof electron === 'string') {
  const { spawnSync } = require('node:child_process');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-agent-visual-'));
  fs.writeFileSync(path.join(profile, 'preferences.json'), JSON.stringify({ bots: [{ id: '123', name: 'Atlas fixture', isBot: true }], selectedBotId: '123', preview: false }));
  try {
    const result = spawnSync(electron, [__filename], { env: { ...process.env, HERMES_WORKSPACE_DATA: profile, HERMES_WORKSPACE_PORT: '0' }, stdio: 'inherit', timeout: 120000, killSignal: 'SIGKILL' });
    assert.equal(result.status, 0, result.error?.message || 'Agent visual test failed.');
  } finally { fs.rmSync(profile, { recursive: true, force: true }); }
} else {
  const { app, BrowserWindow, webContents, session } = electron;
  require('../src/main.cjs');
  const server = http.createServer((_req, res) => res.end('<!doctype html><title>Agent visual fixture</title><body style="padding:40px"><button id="target" style="padding:12px">Fixture target</button><script>target.onclick=()=>document.body.dataset.clicked="yes"</script>'));
  const waitFor = async (read, predicate, label, timeout = 25000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { const value = await read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
    throw new Error(`Timed out: ${label}`);
  };
  const step = label => console.log(`[step] ${label}`);
  app.whenReady().then(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const win = await waitFor(() => BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('index.html')), Boolean, 'workspace');
    const evaluate = code => win.webContents.executeJavaScript(code);
    await waitFor(() => evaluate('typeof window.workspace === "object"').catch(() => false), Boolean, 'preload');
    const invoke = (name, value = {}) => evaluate(`window.workspace.command(${JSON.stringify(name)}, ${JSON.stringify(value)})`);
    const state = () => evaluate('window.workspace.getState()');
    webContents.getAllWebContents().find(item => item.session === session.fromPartition('persist:telegram'))?.stop();
    const page = `http://127.0.0.1:${server.address().port}`;
    step('create-tab'); const created = await invoke('create-tab', { url: page });
    const tabWc = await waitFor(() => webContents.getAllWebContents().find(item => item.getURL().startsWith(page)), Boolean, 'fixture tab');
    await waitFor(() => tabWc.executeJavaScript('document.readyState').catch(() => ''), value => value === 'complete', 'fixture load');
    step('control agent'); await invoke('control', { id: created.id, controller: 'agent' });
    await waitFor(() => tabWc.executeJavaScript(`!!document.getElementById('hermes-workspace-agent-cursor-tint')`), Boolean, 'controlled-page tint');
    step('tint ok');
    const connection = JSON.parse(fs.readFileSync(path.join(process.env.HERMES_WORKSPACE_DATA, 'connection.json')));
    const headers = { Authorization: `Bearer ${connection.token}`, 'X-Hermes-Bot': '123' };
    step('snapshot'); const snap = await (await fetch(`${connection.url}/v1/tabs/${created.id}/snapshot`, { headers })).json();
    const ref = snap.elements.find(item => item.name === 'Fixture target')?.ref;
    assert.ok(ref, 'snapshot found the fixture button');
    step('click'); const action = await (await fetch(`${connection.url}/v1/tabs/${created.id}/actions`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'click', ref, epoch: snap.tab.epoch }) })).json();
    assert.equal(action.dispatched, true);
    assert.equal(await tabWc.executeJavaScript('document.body.dataset.clicked'), 'yes', 'real click landed');
    await waitFor(() => tabWc.executeJavaScript(`!!document.getElementById('hermes-workspace-agent-cursor') && !!document.getElementById('hermes-workspace-agent-cursor-hl')`), Boolean, 'cursor and element highlight');
    assert.equal(await tabWc.executeJavaScript(`document.getElementById('hermes-workspace-agent-cursor').dataset.action`), 'click');
    const described = (await state()).tabs.find(item => item.id === created.id);
    assert.equal(described.agentCursor.name, 'Atlas fixture', 'cursor carries the driving bot name');
    assert.equal(described.agentCursor.c.hue, require('../src/agent-input.cjs').botAccent('123').hue, 'cursor carries the bot accent');
    assert.equal(typeof described.agentBusy, 'boolean');
    step('share-page'); await assert.rejects(invoke('share-page'), /Telegram|chat|message box/i, 'no Telegram composer means a visible error, not silence');
    step('control human'); await invoke('control', { id: created.id, controller: 'human' });
    await waitFor(() => tabWc.executeJavaScript(`!document.getElementById('hermes-workspace-agent-cursor-tint')`), Boolean, 'tint removed on takeover');
    console.log('PASS: agent-controlled tint, named gliding cursor, blue element highlight, busy flag, visible share-page error, takeover cleanup.');
    app.quit();
  }).catch(error => { console.error(error.stack || error); app.exit(1); }).finally(() => server.close());
}

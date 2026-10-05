// Opt-in real Mac app + configured VPS browser. Uses disposable bots and a local fixture.
const assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { app, BrowserWindow, webContents, session } = require('electron');
const fixture = process.env.HERMES_CROSS_HOST_FIXTURE,
  sshHost = process.env.HERMES_CROSS_HOST_SSH,
  scriptPath = process.env.HERMES_CROSS_HOST_SCRIPT;
if (!fixture || !sshHost || !scriptPath)
  throw new Error(
    'Set HERMES_CROSS_HOST_FIXTURE, HERMES_CROSS_HOST_SSH and HERMES_CROSS_HOST_SCRIPT for this opt-in live test.',
  );
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-cross-host-'));
process.env.HERMES_WORKSPACE_DATA = profile;
process.env.HERMES_WORKSPACE_PORT = '0';
fs.writeFileSync(
  path.join(profile, 'preferences.json'),
  JSON.stringify({
    bots: [
      { id: '123', name: 'First test agent', isBot: true },
      { id: '456', name: 'Second test agent', isBot: true },
    ],
    selectedBotId: '123',
    preview: false,
    vpsBrowser: { sshHost, scriptPath, sudo: process.env.HERMES_CROSS_HOST_SUDO === '1' },
  }),
);
require('../src/main.cjs');
const until = async (read, predicate) => {
  for (let i = 0; i < 160; i++) {
    const v = await read();
    if (predicate(v)) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Timed out waiting for live handoff fixture.');
};
app
  .whenReady()
  .then(async () => {
    const win = await until(() => BrowserWindow.getAllWindows()[0], Boolean);
    const telegram = webContents
      .getAllWebContents()
      .find((w) => w.session === session.fromPartition('persist:telegram'));
    telegram.stop();
    await telegram.loadURL('about:blank');
    await telegram.executeJavaScript(
      `document.body.innerHTML='<div id="LeftColumn"><a href="#123">First</a><a href="#456">Second</a></div>'`,
    );
    const evaluate = (code) => win.webContents.executeJavaScript(code);
    await until(
      () => evaluate('typeof window.workspace').catch(() => ''),
      (v) => v === 'object',
    );
    const invoke = (command, value = {}) =>
      evaluate(`window.workspace.command(${JSON.stringify(command)},${JSON.stringify(value)})`);
    await until(
      () => evaluate('window.workspace.getState()'),
      (s) => s.vpsBrowserStatus === 'connected',
    );
    await until(() => fs.existsSync(path.join(profile, 'connection.json')), Boolean);
    const c = JSON.parse(fs.readFileSync(path.join(profile, 'connection.json')));
    async function api(route, method = 'GET', body, actor = '123', epoch) {
      const r = await fetch(c.url + route, {
        method,
        headers: {
          Authorization: 'Bearer ' + c.token,
          'X-Hermes-Bot': actor,
          'X-Control-Epoch': String(epoch || ''),
          'Content-Type': 'application/json',
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: r.status, data: await r.json() };
    }
    const own = [];
    try {
      const mac = await invoke('create-tab', { url: fixture });
      own.push(mac.id);
      const macWc = await until(
        () => webContents.getAllWebContents().find((w) => w.getURL() === fixture + '/'),
        Boolean,
      );
      await until(
        () => macWc.isLoading(),
        (v) => !v,
      );
      const memory = await macWc.executeJavaScript(
        `draft.value='MAC-DRAFT';password.value='DO-NOT-TRANSFER';window.fixtureMemory`,
      );
      const handoff = await invoke('handoff', {
        id: mac.id,
        destination: 'vps',
        includeDrafts: true,
        note: 'Continue the fixture; no submission yet.',
      });
      own.push(handoff.destinationTabId);
      assert.equal(handoff.verification, 'ready');
      assert.equal(handoff.restoredDrafts, 1);
      assert.equal((await api(`/v1/tabs/${handoff.destinationTabId}/snapshot`)).status, 409, 'the human holds the handed-off page');
      assert.equal(
        (await api(`/v1/tabs/${handoff.destinationTabId}/actions`, 'POST', { action: 'click', selector: 'button', epoch: 1 })).status,
        409,
      );
      assert.equal((await api(`/v1/tabs/${handoff.destinationTabId}/snapshot`, 'GET', undefined, '456')).status, 403);
      let remote = await invoke('control', { id: handoff.destinationTabId, controller: 'agent' });
      let snap = (await api(`/v1/tabs/${remote.id}/snapshot`)).data;
      assert.equal(snap.elements.find((e) => e.name === 'Task draft').value, 'MAC-DRAFT');
      assert.equal(snap.tab.host, 'vps');
      assert.equal(snap.tab.handoff.note, 'Continue the fixture; no submission yet.');
      const source = (await api(`/v1/tabs/${mac.id}/control`, 'POST', { controller: 'agent' })).data;
      assert.match(source.error, /^handoff_source:/, 'the Mac source refuses agent claims once the task moved');
      console.log(
        'PASS: actual Mac -> VPS URL/text-draft handoff, task context, destination review gate, source retirement, and cross-agent denial.',
      );
      assert.equal(
        (
          await api(`/v1/tabs/${remote.id}/actions`, 'POST', {
            action: 'type',
            ref: snap.elements.find((e) => e.name === 'Task draft').ref,
            text: 'VPS-CONTINUED',
            epoch: remote.epoch,
          })
        ).status,
        200,
      );
      const roundtrip = await invoke('handoff', {
        id: remote.id,
        destination: 'mac',
        includeDrafts: true,
        note: 'Continue back on Mac.',
      });
      own.push(roundtrip.destinationTabId);
      assert.equal(roundtrip.restoredDrafts, 1);
      const returned = webContents.getAllWebContents().find((w) => w.getURL() === fixture + '/' && w !== macWc);
      assert.ok(returned);
      assert.equal(await returned.executeJavaScript('draft.value'), 'VPS-CONTINUED');
      assert.equal(await returned.executeJavaScript('password.value'), '');
      assert.notEqual(await returned.executeJavaScript('window.fixtureMemory'), memory);
      assert.equal(
        (await api(`/v1/tabs/${remote.id}/actions`, 'POST', { action: 'reload', epoch: remote.epoch })).status,
        409,
      );
      console.log(
        'PASS: VPS -> Mac draft handoff, source takeover, password exclusion, and explicit new page execution state.',
      );
      const cookieTab = (await api('/v1/tabs', 'POST', { host: 'vps', url: fixture + '/set-cookie?value=live-shared' }))
        .data;
      own.push(cookieTab.id);
      const second = (await api('/v1/tabs', 'POST', { host: 'vps', url: fixture }, '456')).data;
      own.push(second.id);
      const secondSnap = (await api(`/v1/tabs/${second.id}/snapshot`, 'GET', undefined, '456')).data;
      assert.ok(secondSnap.text.includes('shared_fixture=live-shared'));
      assert.ok(!(await api('/v1/tabs', 'GET', undefined, '456')).data.tabs.some((t) => t.id === cookieTab.id));
      await invoke('open-bot', { id: '456' });
      const workspace = await evaluate('window.workspace.getState()');
      assert.equal(workspace.activeTabId, 'home');
      assert.ok(workspace.tabs.every(tab => tab.host === 'mac'));
      assert.ok(!workspace.tabs.some(tab => tab.id === second.id));
      await invoke('open-bot', { id: '123' });
      assert.equal((await evaluate('window.workspace.getState()')).activeTabId, roundtrip.destinationTabId);
      console.log('PASS: shared live VPS cookies, separate agent tool ownership, and local-only app workspaces.');
      await macWc.executeJavaScript(`document.cookie='mac_ready=1;path=/'`);
      await invoke('navigate', { id: mac.id, url: fixture + '/needs-login' });
      await until(
        () => macWc.isLoading(),
        (v) => !v,
      );
      await macWc.executeJavaScript(`draft.value='PRIVATE-REVIEW-DRAFT'`);
      const redirect = await invoke('handoff', { id: mac.id, destination: 'vps', includeDrafts: true });
      own.push(redirect.destinationTabId);
      assert.equal(redirect.verification, 'review_required');
      assert.equal(redirect.restoredDrafts, 0);
      const login = (await api('/v1/tabs')).data.tabs.find((t) => t.id === redirect.destinationTabId);
      assert.ok(login.url.endsWith('/login'));
      assert.equal(login.controller, 'human');
      assert.equal((await api(`/v1/tabs/${login.id}/snapshot`)).status, 409);
      const claim = (await api(`/v1/tabs/${login.id}/control`, 'POST', { controller: 'agent' })).data;
      assert.match(claim.error, /^handoff_review_required:/, 'an unverified page needs the human before an agent claims it');
      console.log('PASS: destination login redirect is not given drafts or agent control, even on an agent claim.');
    } finally {
      for (const id of own) await invoke('close-tab', { id }).catch(() => {});
    }
    app.quit();
  })
  .catch((error) => {
    console.error(error.stack);
    app.exit(1);
  });

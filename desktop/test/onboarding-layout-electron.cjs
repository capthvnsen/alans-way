// Isolated renderer fixture: real HTML/CSS and wizard, no main-process services.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, session } = require('electron');
const profile = process.env.HERMES_TEST_PROFILE;
assert.ok(profile, 'run with node test/run-electron.cjs test/onboarding-layout-electron.cjs');
app.setPath('userData', profile);
app.setPath('sessionData', profile);

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({
    cancel: !details.url.startsWith('file:') || /\/(renderer|avatars)\.js$/.test(details.url),
  }));
  const win = new BrowserWindow({ show: false, width: 1024, height: 640, useContentSize: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  await win.loadFile(path.join(__dirname, '../src/index.html'));
  const renderer = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8');
  await win.webContents.executeJavaScript(`
    window.workspace = { command: async () => 'Fixture prompt' };
    ${renderer.slice(0, renderer.indexOf('function orderedBots('))}
    ${renderer.slice(renderer.indexOf('let onboardingStep ='), renderer.indexOf('function rect('))}
    const copyReport = () => {};
    state = { platform: 'darwin', telegramStatus: 'offline', inApplications: true };
    document.getElementById('home').classList.add('hidden');
    renderOnboarding(true);
  `);
  for (const step of [1, 2, 3]) {
    const result = await win.webContents.executeJavaScript(`(() => {
      onboardingStep = ${step}; renderOnboarding(true);
      const panel = document.getElementById('onboarding');
      const buttons = [...panel.querySelectorAll('.onboarding-actions button')];
      return { width: innerWidth, buttons: buttons.map(button => {
        button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        const r = button.getBoundingClientRect();
        const p = panel.getBoundingClientRect();
        return { text: button.textContent, reachable: r.width > 0 && r.left >= 0 && r.right <= innerWidth
          && r.left >= p.left && r.right <= p.right && r.top >= p.top && r.bottom <= p.bottom
          && r.bottom <= innerHeight };
      }) };
    })()`);
    assert.equal(result.width, 1024);
    assert.ok(result.buttons.length > 0);
    for (const button of result.buttons) assert.ok(button.reachable, `Step ${step}: ${JSON.stringify(button)}`);
    console.log(`PASS: wizard step ${step} actions reachable at 1024×640`);
  }
  for (const platform of ['darwin', 'win32']) {
    const result = await win.webContents.executeJavaScript(`(async () => {
      const calls = [];
      window.workspace.command = async (name, value) => { calls.push({ name, value }); };
      renderOnboarding(false);
      state.platform = ${JSON.stringify(platform)};
      state.cloud = { claimed: true, step: 'migrate', migration: 'bring', migrateCommand: 'fixture-command' };
      renderOnboarding(true);
      const panel = document.getElementById('onboarding');
      const fresh = [...panel.querySelectorAll('button')].find(button => button.textContent === 'Start fresh instead');
      if (!fresh) return { found: false };
      fresh.scrollIntoView({ block: 'nearest' });
      const r = fresh.getBoundingClientRect(), p = panel.getBoundingClientRect();
      await fresh.onclick();
      return { found: true, reachable: r.width > 0 && r.left >= p.left && r.right <= p.right
        && r.top >= p.top && r.bottom <= p.bottom && r.bottom <= innerHeight, calls };
    })()`);
    assert.equal(result.found, true, `${platform}: Bring must offer Start fresh instead`);
    assert.equal(result.reachable, true, `${platform}: Start fresh instead must be reachable`);
    assert.deepEqual(result.calls, [{ name: 'cloud-migrate', value: { choice: 'fresh' } }]);
    console.log(`PASS: ${platform} Bring card offers a reachable Start fresh instead action`);
  }
  // System font metrics and zoom can put a scrolled action on a fractional edge.
  for (const zoom of [1, 1.1]) {
    win.webContents.setZoomFactor(zoom);
    for (const diy of [true, false]) {
      const result = await win.webContents.executeJavaScript(`(async () => {
        const calls = [];
        window.workspace.command = async (name, value) => { calls.push({ name, value }); return { done: false, detail: 'Could not detect a model.' }; };
        renderOnboarding(false);
        state.cloud = { claimed: true, step: 'model', diy: ${diy} };
        renderOnboarding(true);
        await Promise.resolve();
        const panel = document.getElementById('onboarding');
        const keep = [...panel.querySelectorAll('button')].find(button => button.textContent === 'Use the model already set on my server');
        if (!keep) return { found: false, calls };
        keep.scrollIntoView({ block: 'nearest' });
        const r = keep.getBoundingClientRect(), p = panel.getBoundingClientRect();
        await keep.onclick();
        return { found: true, metrics: { button: r.toJSON(), panel: p.toJSON(), viewport: [innerWidth, innerHeight], scroll: panel.scrollTop }, reachable: r.width > 0 && r.left >= p.left && r.right <= p.right
          && r.top >= p.top && r.bottom <= p.bottom && r.bottom <= innerHeight, calls };
      })()`);
      assert.equal(result.found, diy, 'only DIY offers the existing-server model escape');
      assert.deepEqual(result.calls.map(call => call.name), diy ? ['cloud-model-detect', 'cloud-model-existing'] : []);
      if (diy) assert.equal(result.reachable, true, `manual keep must be reachable at zoom ${zoom}: ${JSON.stringify(result.metrics)}`);
      console.log(`PASS: ${diy ? 'DIY' : 'hosted'} model card actions and detection`);
    }
    for (const provider of ['openrouter', '<img src=x onerror=alert(1)>']) {
      const result = await win.webContents.executeJavaScript(`(async () => {
        const calls = [];
        window.workspace.command = async name => { calls.push(name); };
        renderOnboarding(false);
        state.cloud = { claimed: true, diy: true, step: 'model', modelDetected: true,
          existingModel: { provider: ${JSON.stringify(provider)}, model: 'openai/gpt-4.1' } };
        renderOnboarding(true);
        await Promise.resolve();
        const panel = document.getElementById('onboarding');
        const text = panel.textContent;
        const buttons = [...panel.querySelectorAll('button')];
        const keep = buttons.find(button => button.textContent === 'Use the model already on my server');
        if (!keep) return { found: false, text };
        keep.scrollIntoView({ block: 'nearest' });
        const r = keep.getBoundingClientRect(), p = panel.getBoundingClientRect();
        const primary = buttons.filter(button => button.classList.contains('primary-button')).map(button => button.textContent);
        const callsBeforeClick = [...calls];
        await keep.onclick();
        return { found: true, text, calls, callsBeforeClick, primary, images: panel.querySelectorAll('img').length,
          reachable: r.width > 0 && r.top >= p.top && r.bottom <= p.bottom && r.bottom <= innerHeight };
      })()`);
      assert.equal(result.found, true, 'detected model must have an explicit confirmation button');
      assert.ok(result.text.includes(`Your server already uses ${provider} · openai/gpt-4.1`));
      assert.match(result.text, /first reply/i);
      assert.deepEqual(result.primary, ['Use the model already on my server']);
      assert.equal(result.images, 0, 'provider identifiers must be literal text');
      assert.equal(result.reachable, true);
      assert.deepEqual(result.callsBeforeClick, [], 'showing a detected model must wait for user confirmation');
      assert.deepEqual(result.calls, ['cloud-model-existing']);
      console.log('PASS: detected model has a reachable primary confirmation and escaped identifiers');
    }
    const summary = await win.webContents.executeJavaScript(`(async () => {
      const calls = [];
      window.workspace.command = async (name, value) => { calls.push({ name, value }); };
      renderOnboarding(false);
      state.cloud = { claimed: true, step: 'telegram', diy: true, model: 'existing',
        existingModel: { provider: 'openrouter', model: 'openai/gpt-4.1' } };
      renderOnboarding(true);
      const panel = document.getElementById('onboarding');
      const change = [...panel.querySelectorAll('button')].find(button => button.textContent === 'Change model');
      if (!change) return { found: false };
      change.scrollIntoView({ block: 'nearest' });
      const r = change.getBoundingClientRect(), p = panel.getBoundingClientRect();
      await change.onclick();
      return { found: true, text: panel.textContent, calls,
        reachable: r.width > 0 && r.top >= p.top && r.bottom <= p.bottom && r.bottom <= innerHeight };
    })()`);
    assert.equal(summary.found, true, 'DIY pairing must offer a return to model setup');
    assert.equal(summary.reachable, true);
    assert.match(summary.text, /openrouter.*openai\/gpt-4\.1/, 'confirmed model must remain visible on the next wizard card');
    assert.deepEqual(summary.calls, [{ name: 'cloud-goto', value: { step: 'model' } }]);
    console.log('PASS: DIY pairing offers a reachable return to model setup');
  }
  win.destroy();
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });

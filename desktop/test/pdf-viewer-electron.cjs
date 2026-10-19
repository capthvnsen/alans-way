// Loopback PDFs, isolated sessions/downloads, native-event/picker fixtures and
// two launches to exercise quit-time persistence. Never uses an installed app.
// Drops request 1024x700 by default, capped at the display work area.
// PDF_FIXTURE_BOUNDS=1550x980 covers a large window on a large display.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { pathToFileURL } = require('node:url');
const electron = require('electron');
const { selectPdfPage } = require('./pdf-viewer-controls.cjs');
const scratch = process.env.PDF_FIXTURE_SCRATCH || require('node:os').tmpdir();
function buildPdf() {
  const parts = ['%PDF-1.4\n'], offsets = [0];
  const obj = (id, body) => { offsets[id] = parts.join('').length; parts.push(`${id} 0 obj\n${body}\nendobj\n`); };
  const stream = 'BT /F1 24 Tf 100 700 Td (PDF fixture) Tj ET';
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>');
  for (const id of [3, 6]) obj(id, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>');
  obj(4, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  obj(5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const start = parts.join('').length;
  parts.push('xref\n0 7\n0000000000 65535 f \n');
  for (let i = 1; i <= 6; i++) parts.push(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
  parts.push(`trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`);
  return Buffer.from(parts.join(''));
}
const PDF = buildPdf();
if (typeof electron === 'string') {
  const { spawn } = require('node:child_process');
  // Caller can keep local fixture scratch under its designated cache.
  const root = fs.existsSync(scratch) ? scratch : require('node:os').tmpdir();
  // macOS temp paths may be symlinked; match the canonical paths opened by
  // the PDF validator rather than comparing two aliases of the same file.
  const profile = fs.realpathSync(fs.mkdtempSync(path.join(root, 'next-P-pdf-fixture-')));
  fs.mkdirSync(path.join(profile, 'downloads'));
  for (const name of ['cold start.pdf', 'finder.pdf', 'picker.pdf', 'drop.pdf', 'restore.pdf']) fs.writeFileSync(path.join(profile, name), PDF);
  fs.writeFileSync(path.join(profile, 'fake.pdf'), '<html>not a PDF</html>');
  fs.writeFileSync(path.join(profile, 'notes.txt'), 'non-PDF drop fixture');
  fs.writeFileSync(path.join(profile, 'preferences.json'), JSON.stringify({ onboarded: true, preview: false, macSshHost: '', bots: [{ id: '123', name: 'PDF fixture', isBot: true }], selectedBotId: '123' }));
  const launch = phase => new Promise((resolve, reject) => {
    const child = spawn(electron, [__filename, phase], { env: { ...process.env, PDF_FIXTURE_PROFILE: profile }, stdio: 'inherit' });
    const timer = setTimeout(() => child.kill('SIGKILL'), 145000);
    child.once('error', reject);
    child.once('exit', (code, signal) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`PDF ${phase} exited ${signal || code}`)); });
  });
  (async () => {
    try { await launch('exercise');
      const prefsPath = path.join(profile, 'preferences.json');
      const saved = JSON.parse(fs.readFileSync(prefsPath));
      assert.ok(saved.savedTabs.some(t => t.url.endsWith('/restore.pdf')), 'quit persisted a PDF tab');
      saved.savedTabs.push({ url: pathToFileURL(path.join(profile, 'fake.pdf')).href, botId: '123' });
      fs.writeFileSync(prefsPath, JSON.stringify(saved));
      await launch('restore'); }
    finally { fs.rmSync(profile, { recursive: true, force: true }); }
  })().catch(error => { console.error(error.stack); process.exitCode = 1; });
} else {
  const { app, BrowserWindow, webContents, session, dialog, Menu, screen } = electron;
  const { prepareFixture, quitFixture } = require('./electron-fixture.cjs');
  const profile = process.env.PDF_FIXTURE_PROFILE;
  const baseline = process.env.PDF_BASELINE === '1';
  const phase = process.argv[2];
  prepareFixture(profile);
  app.whenReady().then(() => session.fromPartition('persist:browser').protocol.handle('https', () => new Response('<!doctype html><title>Retained PDF provenance</title>')));
  process.env.HERMES_WORKSPACE_ALLOW_LOOPBACK = '1';
  app.setPath('downloads', path.join(profile, 'downloads'));
  if (phase === 'exercise') process.argv.push(path.join(profile, 'cold start.pdf'));
  require('../src/main.cjs');
  // Finder can deliver an event before ready, as well as while already running.
  if (phase === 'exercise') app.emit('open-file', { preventDefault() {} }, path.join(profile, 'finder.pdf'));
  const waitFor = async (read, predicate = Boolean, timeout = 12000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { const value = await read(); if (predicate(value)) return value; await new Promise(r => setTimeout(r, 50)); }
    throw new Error('Timed out waiting for PDF fixture state.');
  };
  const tabContents = url => webContents.getAllWebContents().filter(w => w.getURL() === url && !['webview', 'guestView'].includes(w.getType()));
  const viewerOf = target => waitFor(() => target.mainFrame.framesInSubtree.find(f => f.url.startsWith('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/')));
  const observations = {};
  const check = (name, actual, expected = true) => {
    observations[name] = actual;
    console.log(`${baseline ? 'BASELINE' : 'CHECK'}: ${name}: ${JSON.stringify(actual)}`);
    if (!baseline) assert.deepEqual(actual, expected, name);
  };
  let server;
  app.whenReady().then(async () => {
    const win = await waitFor(() => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html')));
    const evaluate = code => win.webContents.executeJavaScript(code);
    await waitFor(() => evaluate('typeof window.workspace === "object"').catch(() => false));
    const state = () => evaluate('window.workspace.getState()');
    const command = (name, value = {}) => evaluate(`window.workspace.command(${JSON.stringify(name)}, ${JSON.stringify(value)})`);
    const fileUrl = name => pathToFileURL(path.join(profile, name)).href;
    const hasFile = async name => (await state()).tabs.some(t => t.url === fileUrl(name));
    // Only this generated fixture connection is read, never the live connection.
    const connection = JSON.parse(fs.readFileSync(path.join(profile, 'connection.json')));
    const apiRaw = async (route, method = 'GET', body, actor = '123') => {
      const response = await fetch(new URL(route, connection.url), { method, headers: { Authorization: `Bearer ${connection.token}`, 'X-Hermes-Bot': actor, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, data: await response.json() };
    };
    if (phase === 'restore') {
      const restored = await waitFor(state, s => s.tabs.some(t => t.url.endsWith('/restore.pdf')));
      const pdfTab = restored.tabs.find(t => t.url.endsWith('/restore.pdf'));
      await viewerOf(tabContents(pdfTab.url)[0]);
      check('PDF restored after actual restart', pdfTab.controller, 'human');
      check('invalid restored PDF discarded', await hasFile('fake.pdf'), false);
      const retained = restored.tabs.find(t => t.url === 'https://pdf-provenance.invalid/');
      check('navigated local PDF restores human provenance', retained?.localPdf, true);
      check('restored local PDF cannot be granted', await command('grant-tab', { id: retained.id, botId: '123' }).then(() => true, () => false), false);
      check('restored local PDF cannot change controller', await command('control', { id: retained.id, controller: 'agent' }).then(() => true, () => false), false);
      check('restored local PDF cannot be claimed', (await apiRaw(`/v1/tabs/${retained.id}/control`, 'POST', { controller: 'agent' })).status, 404);
      check('restored local PDF hidden from list', (await apiRaw('/v1/tabs')).data.tabs.some(t => t.id === retained.id), false);
      for (const suffix of ['', '/snapshot', '/screenshot', '/actions']) {
        check(`restored local PDF API ${suffix || 'get'} refused`, (await apiRaw(`/v1/tabs/${retained.id}${suffix}`, suffix === '/actions' ? 'POST' : 'GET', suffix === '/actions' ? { action: 'eval', expression: 'document.title', epoch: retained.epoch } : undefined)).status, 404);
      }
      check('restored refusals preserve controller and epoch', { controller: (await state()).tabs.find(t => t.id === retained.id).controller, epoch: (await state()).tabs.find(t => t.id === retained.id).epoch }, { controller: 'human', epoch: retained.epoch });
      return quitFixture();
    }
    // Wait for the queued files themselves: ready-time tab creation can outlast
    // a fixed delay on a loaded CI runner.
    if (baseline) await new Promise(r => setTimeout(r, 300));
    else {
      await waitFor(() => hasFile('cold start.pdf'));
      await waitFor(() => hasFile('finder.pdf'));
    }
    check('startup argv PDF', await hasFile('cold start.pdf'));
    check('queued Finder open-file PDF', await hasFile('finder.pdf'));
    app.emit('second-instance', {}, ['app', path.join(profile, 'picker.pdf')]);
    if (baseline) await new Promise(r => setTimeout(r, 300));
    else await waitFor(() => hasFile('picker.pdf'));
    check('second-instance argv PDF', await hasFile('picker.pdf'));
    const menu = Menu.getApplicationMenu().items.find(i => i.label === 'File').submenu.items.find(i => i.label === 'Open File…');
    check('Open File menu accelerator', menu?.accelerator || null, 'CmdOrCtrl+O');
    if (menu) {
      let pickerOptions;
      const original = dialog.showOpenDialog;
      dialog.showOpenDialog = async (_win, options) => { pickerOptions = options; return { canceled: false, filePaths: [path.join(profile, 'drop.pdf')] }; };
      try { await menu.click(); await waitFor(() => hasFile('drop.pdf')); }
      finally { dialog.showOpenDialog = original; }
      check('native picker filters PDFs', pickerOptions.filters[0].extensions, ['pdf']);
      const keyTab = await command('create-tab');
      const keyWc = await waitFor(() => webContents.getAllWebContents().find(w => w.getURL().endsWith('/newtab.html')));
      const beforeKey = (await state()).tabs.length;
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path.join(profile, 'picker.pdf')] });
      try {
        win.focus(); keyWc.focus();
        keyWc.sendInputEvent({ type: 'keyDown', keyCode: 'O', modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] });
        keyWc.sendInputEvent({ type: 'keyUp', keyCode: 'O', modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] });
        await waitFor(state, s => s.tabs.length > beforeKey);
      } finally { dialog.showOpenDialog = original; }
      check('Open File keyboard shortcut opens PDF', true);
      await command('close-tab', { id: keyTab.id });
      const beforeCancel = (await state()).tabs.length;
      dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
      try { await menu.click(); } finally { dialog.showOpenDialog = original; }
      check('cancelled picker opens nothing', (await state()).tabs.length, beforeCancel);
    }
    const beforeSpoof = (await state()).tabs.length;
    app.emit('open-file', { preventDefault() {} }, path.join(profile, 'fake.pdf'));
    check('Finder spoofed local PDF refused', (await state()).tabs.length, beforeSpoof);
    app.emit('open-file', { preventDefault() {} }, path.join(profile, 'finder.pdf'));
    if (baseline) await new Promise(r => setTimeout(r, 100));
    else await waitFor(state, s => s.tabs.length > beforeSpoof);
    check('running Finder event opens PDF', (await state()).tabs.length > beforeSpoof);
    // A page-created File has no native backing path and an untrusted event.
    await evaluate(`(()=>{const data=new DataTransfer();data.items.add(new File(['%PDF-'], 'forged.pdf'));window.dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:data}));})()`);
    check('synthetic drop opens nothing', (await state()).tabs.some(t => t.url.endsWith('/forged.pdf')), false);
    // A forged MessageEvent can claim any origin. Use a genuinely disk-backed
    // fixture File so this checks event authentication, not just File backing.
    const beforeForgedMessage = (await state()).tabs.length;
    win.webContents.debugger.attach('1.3');
    try {
      await evaluate("(()=>{const input=document.createElement('input');input.type='file';input.id='fixture-pdf-file';input.hidden=true;document.body.append(input);})()");
      const { root } = await win.webContents.debugger.sendCommand('DOM.getDocument');
      const { nodeId } = await win.webContents.debugger.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: '#fixture-pdf-file' });
      await win.webContents.debugger.sendCommand('DOM.setFileInputFiles', { nodeId, files: [path.join(profile, 'finder.pdf')] });
      await evaluate(`(()=>{const input=document.querySelector('#fixture-pdf-file');const frame=document.createElement('iframe');frame.hidden=true;document.body.append(frame);window.dispatchEvent(new MessageEvent('message',{origin:'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai',source:frame.contentWindow,data:{workspacePdfDrop:true,files:[input.files[0]]}}));input.remove();frame.remove();})()`);
      await new Promise(r => setTimeout(r, 300));
    } finally { win.webContents.debugger.detach(); }
    check('forged viewer origin with native File cannot open tab', (await state()).tabs.length, beforeForgedMessage);

    server = http.createServer((req, res) => {
      if (req.url.endsWith('.pdf')) {
        res.setHeader('Content-Type', req.url.includes('octet') ? 'application/octet-stream' : 'application/pdf');
        if (req.url.includes('attachment') || req.url.includes('fake')) res.setHeader('Content-Disposition', `attachment; filename="${path.basename(req.url)}"`);
        return res.end(req.url.includes('fake') ? Buffer.from('not a pdf') : PDF);
      }
      res.setHeader('Content-Type', 'text/html');
      if (req.url.endsWith('/upload')) return res.end(`<!doctype html><title>Upload fixture</title>
        <style>html,body{margin:0}#zone{width:100vw;height:100vh}</style><div id="zone">Upload</div><script>
        window.received=[];window.dragoverWasPrevented=[];
        const zone=${req.url === '/window/upload' ? 'window' : "document.querySelector('#zone')"};
        zone.addEventListener('dragover',event=>{window.dragoverWasPrevented.push(event.defaultPrevented);event.preventDefault();});
        zone.addEventListener('drop',async event=>{event.preventDefault();for(const file of event.dataTransfer.files)window.received.push({name:file.name,contents:await file.text()});});
        </script>`);
      res.end('<!doctype html><title>PDF links</title><style>a{display:block;margin:20px}</style><a id="same" href="/doc.pdf">same</a><a id="blank" target="_blank" href="/blank.pdf">blank</a><a id="middle" href="/middle.pdf">middle</a><a id="meta" href="/meta.pdf">meta</a>');
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const agent = await apiRaw('/v1/tabs', 'POST', { url: `${base}/agent.pdf`, background: true });
    assert.equal(agent.status, 201);
    await viewerOf(tabContents(`${base}/agent.pdf`)[0]);
    check('agent URL renders viewer without download', (await state()).downloads.length, 0);
    await command('create-tab', { url: base });
    const human = await waitFor(() => tabContents(base + '/')[0]);
    const humanId = (await state()).activeTabId;
    for (const [name, target, action] of [
      ['same-tab link', '/doc.pdf', "document.querySelector('#same').click()"],
      ['target blank link', '/blank.pdf', "document.querySelector('#blank').click()"],
      ['window.open', '/popup.pdf', `window.open('${base}/popup.pdf'); void 0`],
    ]) {
      if (name !== 'same-tab link') await human.loadURL(base);
      await human.executeJavaScript(action);
      await viewerOf(await waitFor(() => tabContents(base + target)[0]));
      check(name, true);
      const linked = (await state()).tabs.find(t => t.url === base + target);
      check(`${name} tab disposition`, name === 'same-tab link' ? linked.id === humanId : linked.id !== humanId);
      check(`${name} stays human controlled`, linked.controller, 'human');
      if (name === 'same-tab link') {
        await waitFor(state, s => s.tabs.find(t => t.id === humanId)?.title === 'doc.pdf', 2000).catch(() => {});
        check('served PDF tab title is filename', (await state()).tabs.find(t => t.id === humanId).title, 'doc.pdf');
      }
    }
    await human.loadURL(base);
    for (const [id, button, modifiers] of [['middle', 'middle', []], ['meta', 'left', [process.platform === 'darwin' ? 'meta' : 'control']]]) {
      await command('activate', { id: humanId }); app.focus({ steal: true }); win.focus(); human.focus();
      await waitFor(() => human.executeJavaScript('document.hasFocus()'));
      await human.capturePage();
      const point = await human.executeJavaScript(`(()=>{const r=document.querySelector('#${id}').getBoundingClientRect();return {x:Math.round(r.x+20), y:Math.round(r.y+10)}})()`);
      human.sendInputEvent({ type: 'mouseMove', ...point });
      human.sendInputEvent({ type: 'mouseDown', ...point, button, clickCount: 1, modifiers });
      human.sendInputEvent({ type: 'mouseUp', ...point, button, clickCount: 1, modifiers });
      const clicked = await waitFor(() => tabContents(`${base}/${id}.pdf`)[0], Boolean, 3000).catch(() => null);
      if (clicked) await viewerOf(clicked);
      check(`${id} click opens viewer tab`, !!clicked);
      if (clicked) check(`${id} click keeps opener active`, (await state()).activeTabId, humanId);
    }
    // Exercise the small work area used by macOS CI even on a large display.
    // An explicit size also lets the same assertions cover a full-size window.
    const bounds = process.env.PDF_FIXTURE_BOUNDS || '1024x700';
    assert.match(bounds, /^\d+x\d+$/);
    const [requestedWidth, requestedHeight] = bounds.split('x').map(Number);
    const { resizeWindow } = require('./window-fixture.cjs');
    const effective = await resizeWindow(win, requestedWidth, requestedHeight, { mode: 'bounds' });
    const actualBounds = win.getBounds();
    check('drop window bounds', [actualBounds.width, actualBounds.height], effective.outer);
    check('drop window viewport', await evaluate('[innerWidth, innerHeight]'), [effective.width, effective.height]);
    const dropPoint = async (target, element = 'document.documentElement') => {
      const rect = await target.executeJavaScript(`(() => {
        const r = (${element}).getBoundingClientRect();
        const left = Math.max(0, r.left), right = Math.min(innerWidth, r.right);
        const top = Math.max(0, r.top), bottom = Math.min(innerHeight, r.bottom);
        return { left, right, top, bottom };
      })()`);
      assert.ok(rect.right > rect.left && rect.bottom > rect.top, 'Drop target has a visible rect');
      return { x: Math.floor((rect.left + rect.right) / 2), y: Math.floor((rect.top + rect.bottom) / 2) };
    };
    const nativeDrop = async (target, name, { element = 'document.documentElement', frame = target } = {}) => {
      // Activation reparents a view. Wait for its compositor frame before
      // Chromium hit-tests the drag, especially for the viewer's child frame.
      await target.capturePage();
      const point = await dropPoint(frame, element);
      const wasAttached = target.debugger.isAttached();
      if (!wasAttached) target.debugger.attach('1.3');
      try {
        const data = { items: [], files: [path.join(profile, name)], dragOperationsMask: 1 };
        for (const type of ['dragEnter', 'dragOver', 'drop']) await target.debugger.sendCommand('Input.dispatchDragEvent', { type, ...point, data });
      } finally { if (!wasAttached) target.debugger.detach(); }
    };
    // Page upload handlers run first in both browser and Telegram sessions.
    const telegramUpload = await waitFor(() => webContents.getAllWebContents().find(w => w.getURL().startsWith('https://web.telegram.org/')));
    const telegramUrl = telegramUpload.getURL();
    try {
      for (const [target, label, route] of [[human, 'web', '/upload'], [human, 'window-handler web', '/window/upload'], [telegramUpload, 'Telegram-session', '/upload']]) {
        await target.loadURL(`${base}${route}`);
        if (target === human) { await command('activate', { id: humanId }); target.focus(); }
        const before = (await state()).tabs.length;
        const zone = { element: 'document.getElementById("zone")' };
        await nativeDrop(target, 'finder.pdf', zone);
        await new Promise(r => setTimeout(r, 300));
        check(`${label} upload zone receives PDF File`, await target.executeJavaScript('window.received.map(file=>({name:file.name,pdf:file.contents.startsWith("%PDF-")}))'), [{ name: 'finder.pdf', pdf: true }]);
        check(`${label} handled PDF drop opens no tab`, (await state()).tabs.length, before);
        check(`${label} upload dragover reaches page uncancelled`, await target.executeJavaScript('window.dragoverWasPrevented.every(value=>value===false)'));
        await nativeDrop(target, 'notes.txt', zone);
        await new Promise(r => setTimeout(r, 100));
        check(`${label} non-PDF upload unchanged`, await target.executeJavaScript('window.received.at(-1)'), { name: 'notes.txt', contents: 'non-PDF drop fixture' });
        check(`${label} non-PDF drop opens no tab`, (await state()).tabs.length, before);
      }
    } finally { await telegramUpload.loadURL(telegramUrl); }
    // Handlers installed during the gesture must retain the native File even
    // when their drop listener runs after the isolated preload's listener.
    for (const gesture of ['dragenter', 'dragover']) for (const receiver of ['window', 'document', 'target']) for (const capture of [false, true]) {
      await human.loadURL(`${base}/dynamic`);
      await command('activate', { id: humanId }); human.focus();
      await human.executeJavaScript(`window.received=[]; const target=document.body; const receiver=${receiver === 'target' ? 'target' : receiver}; receiver.addEventListener('${gesture}', event => { event.preventDefault(); receiver.addEventListener('drop', async event => { event.preventDefault(); for(const file of event.dataTransfer.files) window.received.push({name:file.name,pdf:(await file.text()).startsWith('%PDF-')}); }, {capture:${capture},once:true}); }, {capture:${capture},once:true}); window.addEventListener('dragover',event=>event.preventDefault());`);
      const before = (await state()).tabs.length;
      await nativeDrop(human, 'finder.pdf', { element: 'document.body' });
      await waitFor(() => human.executeJavaScript('window.received.length'));
      await new Promise(r => setTimeout(r, 100));
      check(`dynamic ${gesture}/${receiver}/${capture ? 'capture' : 'bubble'} receives PDF`, await human.executeJavaScript('window.received'), [{ name: 'finder.pdf', pdf: true }]);
      check(`dynamic ${gesture}/${receiver}/${capture ? 'capture' : 'bubble'} opens no tab`, (await state()).tabs.length, before);
    }
    await human.loadURL(base);
    // Drag a real on-disk file using trusted Chromium input, not a synthetic
    // File.path or a renderer-supplied path. Cover both shell and web view.
    for (const [target, name] of [[win.webContents, 'restore.pdf'], [human, 'finder.pdf'], [tabContents(`${base}/blank.pdf`)[0], 'picker.pdf']]) {
      const before = (await state()).tabs.filter(t => t.url === fileUrl(name)).length;
      if (target !== win.webContents) {
        const dropTab = (await state()).tabs.find(t => t.url === target.getURL());
        await command('activate', { id: dropTab.id }); target.focus();
      }
      let dropTarget;
      if (target !== human && target !== win.webContents) {
        const frame = await viewerOf(target);
        if (!baseline) await waitFor(() => frame.executeJavaScript('window.workspacePdfDropInstalled === true').catch(() => false));
        // The child frame's hit-test surface follows its resize after activation.
        await frame.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
        dropTarget = { frame, element: 'document.querySelector("pdf-viewer").shadowRoot.querySelector("viewer-toolbar")' };
      }
      // Use the viewer toolbar: the native PDF plugin surface below it can
      // consume Chromium drag input without delivering DOM drag events.
      await nativeDrop(target, name, dropTarget);
      if (baseline) await new Promise(r => setTimeout(r, 300));
      else await waitFor(state, s => s.tabs.filter(t => t.url === fileUrl(name)).length > before);
      check(`PDF drop onto ${target === human ? 'web tab' : target === win.webContents ? 'window' : 'PDF viewer'}`, (await state()).tabs.filter(t => t.url === fileUrl(name)).length > before);
    }
    // Save dialogs are deterministic fixture saves, never native dialogs on
    // the user's desktop. Chromium still produces real DownloadItems.
    session.fromPartition('persist:browser').on('will-download', (_e, item) => item.setSavePath(path.join(profile, 'downloads', item.getFilename())));
    for (const endpoint of ['attachment.pdf', 'octet.pdf', 'fake.pdf']) {
      const before = (await state()).tabs.length;
      await human.loadURL(base);
      await human.executeJavaScript(`(()=>{const a=document.createElement('a');a.href='${base}/${endpoint}';document.body.append(a);a.click();})()`);
      await waitFor(state, s => s.downloads.some(d => d.name === endpoint && d.state === 'completed'));
      await new Promise(r => setTimeout(r, 300));
      check(`human download ${endpoint} auto-opens`, (await state()).tabs.length > before, endpoint !== 'fake.pdf');
      if (!baseline && endpoint !== 'fake.pdf') {
        const savedUrl = pathToFileURL(path.join(profile, 'downloads', endpoint)).href;
        await viewerOf(await waitFor(() => tabContents(savedUrl)[0]));
        check(`download ${endpoint} opens human viewer`, (await state()).tabs.find(t => t.url === savedUrl).controller, 'human');
      }
    }
    const agentPage = await apiRaw('/v1/tabs', 'POST', { url: base, background: true });
    const agentPageWc = await waitFor(() => tabContents(base + '/').find(w => w !== human));
    const beforeAgentDrop = (await state()).tabs.length;
    for (const agentDropWc of [agentPageWc, tabContents(`${base}/agent.pdf`)[0]]) {
      const point = agentDropWc === agentPageWc ? await dropPoint(agentDropWc, 'document.body')
        : await dropPoint(await viewerOf(agentDropWc), 'document.querySelector("pdf-viewer").shadowRoot.querySelector("viewer-toolbar")');
      const wasAttached = agentDropWc.debugger.isAttached();
      if (!wasAttached) agentDropWc.debugger.attach('1.3');
      try {
        const data = { items: [], files: [path.join(profile, 'finder.pdf')], dragOperationsMask: 1 };
        for (const type of ['dragEnter', 'drop']) await agentDropWc.debugger.sendCommand('Input.dispatchDragEvent', { type, ...point, data });
        await new Promise(r => setTimeout(r, 200));
      } finally { if (!wasAttached) agentDropWc.debugger.detach(); }
      check(`agent ${agentDropWc === agentPageWc ? 'web tab' : 'PDF viewer'} drop cannot open human tab`, (await state()).tabs.length, beforeAgentDrop);
    }
    await apiRaw(`/v1/tabs/${agentPage.data.id}`, 'DELETE');
    const beforeAgent = (await state()).tabs.length;
    tabContents(`${base}/agent.pdf`)[0].downloadURL(`${base}/agent-attachment.pdf`);
    await waitFor(state, s => s.downloads.some(d => d.name === 'agent-attachment.pdf' && d.state === 'completed'));
    check('agent download stays background', (await state()).tabs.length, beforeAgent);
    // Existing Telegram path, plus spoofed extension/MIME regression.
    for (const valid of [true, false]) {
      const saved = path.join(profile, 'downloads', valid ? 'telegram.pdf' : 'telegram-fake.pdf');
      fs.writeFileSync(saved, valid ? PDF : 'not a PDF');
      const listeners = {};
      const item = { getFilename: () => path.basename(saved), getURL: () => 'blob:https://web.telegram.org/doc', getMimeType: () => 'application/pdf', getState: () => 'progressing', getTotalBytes: () => PDF.length, getReceivedBytes: () => PDF.length, getSavePath: () => saved, isPaused: () => false, setSaveDialogOptions() {}, on(n, f) { (listeners[n] ||= []).push(f); }, once(n, f) { this.on(n, f); } };
      const before = (await state()).tabs.length;
      session.fromPartition('persist:telegram').emit('will-download', {}, item);
      listeners.done.forEach(f => f({}, 'completed'));
      if (valid && !baseline) await waitFor(state, s => s.tabs.some(t => t.url === pathToFileURL(saved).href));
      else await new Promise(r => setTimeout(r, 300));
      check(valid ? 'Telegram PDF opens' : 'spoofed Telegram PDF refused', (await state()).tabs.length > before, valid);
    }
    // The previously existing Telegram path supplies a file tab even on main.
    const local = (await state()).tabs.find(t => t.url === pathToFileURL(path.join(profile, 'downloads', 'telegram.pdf')).href);
    await viewerOf(tabContents(local.url)[0]);
    check('file title is filename', local.title, 'telegram.pdf');
    const telegramRecord = (await state()).downloads.find(d => d.name === 'telegram.pdf');
    check('Telegram download metadata persists', { source: telegramRecord.source, mime: telegramRecord.mime, state: telegramRecord.state }, { source: 'Telegram', mime: 'application/pdf', state: 'completed' });
    // Preserve the original regression: repeatedly opening the same downloads
    // row stays in-app and each new file tab remains human-controlled.
    for (const attempt of [1, 2]) {
      const beforeOpen = (await state()).tabs.filter(t => t.url === local.url).length;
      await command('open-download', { id: telegramRecord.id });
      const reopened = await waitFor(state, s => s.tabs.filter(t => t.url === local.url).length > beforeOpen);
      await viewerOf(tabContents(local.url).at(-1));
      check(`downloads-list Open attempt ${attempt} activates human viewer`, { url: reopened.tabs.find(t => t.id === reopened.activeTabId).url, controller: reopened.tabs.find(t => t.id === reopened.activeTabId).controller }, { url: local.url, controller: 'human' });
    }
    const nav = await apiRaw(`/v1/tabs/${agent.data.id}/actions`, 'POST', { action: 'navigate', url: local.url, epoch: agent.data.epoch });
    check('agent file navigation refused', nav.status, 400);
    check('agent cannot create file tab', (await apiRaw('/v1/tabs', 'POST', { url: local.url })).status, 400);
    check('local PDF cannot be granted to a bot', await command('grant-tab', { id: local.id, botId: '123' }).then(() => true, () => false), false);
    const handoff = await command('control', { id: local.id, controller: 'agent' }).then(() => true, () => false);
    check('human cannot hand file tab to agent', handoff, false);
    if (handoff) await command('control', { id: local.id, controller: 'human' });
    const claim = await apiRaw(`/v1/tabs/${local.id}/control`, 'POST', { controller: 'agent' });
    check('agent cannot claim file tab', claim.status, 404);
    if (!baseline) check('refused handoff preserves controller and epoch', { controller: (await state()).tabs.find(t => t.id === local.id).controller, epoch: (await state()).tabs.find(t => t.id === local.id).epoch }, { controller: 'human', epoch: local.epoch });
    if (claim.status < 300) await command('control', { id: local.id, controller: 'human' });
    check('agent list hides file tabs', (await apiRaw('/v1/tabs')).data.tabs.some(t => t.id === local.id), false);
    for (const suffix of ['', '/snapshot', '/screenshot', '/actions']) {
      const result = await apiRaw(`/v1/tabs/${local.id}${suffix}`, suffix === '/actions' ? 'POST' : 'GET', suffix === '/actions' ? { action: 'eval', expression: 'document.title', epoch: local.epoch } : undefined);
      check(`file tab API ${suffix || 'get'} refused`, result.status, 404);
    }
    // Downloads Open activated a new copy of this file: exercise that visible
    // view's toolbar rather than an older copy hosted in the background.
    const visiblePdf = win.contentView.children.find(view => view.webContents?.getURL() === local.url).webContents;
    const viewer = await viewerOf(visiblePdf);
    await waitFor(() => viewer.executeJavaScript("!!document.querySelector('pdf-viewer')?.shadowRoot?.querySelector('viewer-toolbar')?.shadowRoot"));
    const beforeForgedViewer = (await state()).tabs.length;
    await viewer.executeJavaScript("window.top.postMessage({workspacePdfDrop:true,files:[new File(['%PDF-'], 'forged.pdf')]}, '*')");
    await new Promise(r => setTimeout(r, 100));
    check('viewer relay rejects page-created File', (await state()).tabs.length, beforeForgedViewer);
    const zoomBefore = await viewer.executeJavaScript("document.querySelector('pdf-viewer').viewport_.getZoom()");
    await viewer.executeJavaScript("document.querySelector('pdf-viewer').shadowRoot.querySelector('viewer-toolbar').shadowRoot.querySelector('[title=\"Zoom in\"]').click()");
    await waitFor(() => viewer.executeJavaScript("document.querySelector('pdf-viewer').viewport_.getZoom()"), n => n > zoomBefore);
    check('viewer zoom changes scale', true);
    await selectPdfPage(viewer, 2, waitFor);
    await waitFor(() => viewer.executeJavaScript("document.querySelector('pdf-viewer').viewport_.getMostVisiblePage()"), n => n === 1);
    check('viewer page selector reaches page two', true);
    // Intercept only the plugin's native print command; CI must not send jobs
    // to a real printer or leave a system print dialog on the user's screen.
    await viewer.executeJavaScript(`(()=>{const v=document.querySelector('pdf-viewer');window.printRequests=[];const original=v.plugin_.postMessage.bind(v.plugin_);v.plugin_.postMessage=message=>{if(message.type==='print'){window.printRequests.push(message);return;}return original(message);};v.shadowRoot.querySelector('viewer-toolbar').shadowRoot.querySelector('#print').click();})()`);
    await waitFor(() => viewer.executeJavaScript('window.printRequests.length'), n => n === 1);
    check('viewer print toolbar sends plugin print command', true);
    const downloadsBefore = (await state()).downloads.length;
    await viewer.executeJavaScript("document.querySelector('pdf-viewer').shadowRoot.querySelector('viewer-toolbar').shadowRoot.querySelector('viewer-download-controls').shadowRoot.querySelector('#save').click()");
    const savedViewer = await waitFor(state, s => s.downloads.length > downloadsBefore && s.downloads[0].state === 'completed');
    check('viewer download saves PDF bytes', fs.readFileSync(savedViewer.downloads[0].path).subarray(0,5).toString(), '%PDF-');
    await command('navigate', { id: local.id, url: 'https://pdf-provenance.invalid/' });
    await waitFor(state, s => s.tabs.find(t => t.id === local.id)?.url === 'https://pdf-provenance.invalid/');
    check('local provenance retained after web navigation', (await state()).tabs.find(t => t.id === local.id).localPdf, true);
    // Seed restart through an already supported download Open path on main.
    const restorePath = path.join(profile, 'restore.pdf');
    if (!await hasFile('restore.pdf')) {
      app.emit('open-file', { preventDefault() {} }, restorePath);
      if (baseline) {
        const saved = path.join(profile, 'downloads', 'restore.pdf'); fs.writeFileSync(saved, PDF);
        human.downloadURL(`${base}/restore.pdf`);
        await waitFor(state, s => s.downloads.some(d => d.name === 'restore.pdf' && d.state === 'completed'));
        const record = (await state()).downloads.find(d => d.name === 'restore.pdf');
        await command('open-download', { id: record.id });

      }
    }
    // Keep the restart exercise within the app's existing 12-tab restore cap;
    // closing the unrelated URL fixtures also avoids dead loopback restores.
    const finalState = await waitFor(state, s => s.tabs.some(t => t.url.endsWith('/restore.pdf')));
    const keep = finalState.tabs.find(t => t.url.endsWith('/restore.pdf'));
    assert.ok(keep, 'a PDF remains to persist');
    for (const tab of finalState.tabs) if (tab.id !== keep.id && tab.id !== local.id) await command('close-tab', { id: tab.id });
    quitFixture(server);
  }).catch(error => { console.error(error.stack); server?.closeAllConnections(); server?.close(); app.exit(1); });
}

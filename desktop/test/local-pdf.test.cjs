const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pdfFile } = require('../src/local-pdf.cjs');

test('local PDFs require a regular .pdf file with PDF magic, including after resolving symlinks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'next-P-pdf-magic-'));
  try {
    const valid = path.join(dir, 'real.PDF'); fs.writeFileSync(valid, '%PDF-1.4\nfixture');
    const fake = path.join(dir, 'fake.pdf'); fs.writeFileSync(fake, '<html>fake PDF</html>');
    const markup = path.join(dir, 'markup.html'); fs.writeFileSync(markup, '%PDF-1.4');
    const link = path.join(dir, 'link.pdf'); fs.symlinkSync(markup, link);
    assert.equal(pdfFile(valid), fs.realpathSync(valid));
    for (const file of [fake, markup, link, dir, path.join(dir, 'missing.pdf'), 'relative.pdf', '', null]) assert.equal(pdfFile(file), '');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('PDF file associations validate against the installed electron-builder schema', async () => {
  const { createConfig } = require('../electron-builder.cjs');
  const { validateConfiguration } = require('app-builder-lib/out/util/config/config');
  const config = createConfig({});
  await validateConfiguration(config, { isEnabled: false });
  assert.equal(config.fileAssociations, undefined, 'no global default association');
  assert.equal(config.win.fileAssociations, undefined, 'Windows association intentionally omitted');
  assert.equal(config.mac.fileAssociations[0].ext, 'pdf');
  assert.equal(config.mac.fileAssociations[0].role, 'Viewer');
  assert.deepEqual(config.mac.extendInfo.CFBundleDocumentTypes[0].LSItemContentTypes, ['com.adobe.pdf']);
});

test('generated NSIS install and uninstall scripts leave the Windows PDF default untouched', async () => {
  const { createConfig } = require('../electron-builder.cjs');
  require('app-builder-lib');
  const { PlatformPackager } = require('app-builder-lib/out/platformPackager');
  const { NsisTarget } = require('app-builder-lib/out/targets/nsis/NsisTarget');
  const { CancellationToken } = require('builder-util-runtime');
  const config = createConfig({});
  // Use the builder's own platform resolver and script generator without
  // compiling an installer or modifying this machine's registry.
  const packager = {
    config, platformSpecificBuildOptions: config.win,
    info: { cancellationToken: new CancellationToken() },
    appInfo: { productName: config.productName }, resourceList: [],
    async getResource() { return null; },
  };
  Object.defineProperty(packager, 'fileAssociations', Object.getOwnPropertyDescriptor(PlatformPackager.prototype, 'fileAssociations'));
  const target = Object.create(NsisTarget.prototype);
  Object.assign(target, { packager, options: config.nsis, name: 'nsis' });
  for (const install of [true, false]) {
    const script = await target.computeFinalScript('', install, new Map());
    assert.doesNotMatch(script, /APP_(?:UN)?ASSOCIATE|FileAssociation\.nsh|Software\\Classes\\\.pdf/);
  }
  const type = config.mac.extendInfo.CFBundleDocumentTypes[0];
  assert.equal(type.CFBundleTypeRole, 'Viewer');
  assert.equal(type.LSHandlerRank, 'Alternate');
});

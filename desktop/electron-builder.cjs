'use strict';

// electron-builder only reads electron-builder.* when package.json has no
// "build" key, so the config lives here: a function export lets macOS
// signing stay conditional. With the maintainer's GitHub secrets present the
// build is Developer ID signed, notarized and stapled; without them (forks,
// contributors, local runs) it is the same ad-hoc build as before.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const PUBLISH = [{ provider: 'github', owner: 'capthvnsen', repo: 'alans-way', releaseType: 'draft' }];
const ENTITLEMENTS = 'assets/entitlements.mac.plist';

// Runs after notarization inside electron-builder's sign step, so the ticket
// is already attached; stapling lets Gatekeeper verify the app while offline.
async function stapleApp(context) {
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('xcrun', ['stapler', 'staple', appPath], { stdio: 'inherit' });
}

function createConfig(env) {
  const e = env || process.env;
  // electron-builder imports CSC_LINK into a temp keychain and discovers the
  // "Developer ID Application" identity itself, so a signed build leaves
  // mac.identity unset. Empty strings (unset fork secrets) mean ad-hoc.
  const signed = Boolean(e.CSC_LINK && e.CSC_KEY_PASSWORD);
  const notarize = signed && Boolean(e.APPLE_ID && e.APPLE_APP_SPECIFIC_PASSWORD && e.APPLE_TEAM_ID);
  return {
    appId: 'app.alans-way.localapp',
    productName: 'alans-way-localapp',
    asar: false,
    directories: { output: 'dist' },
    files: [
      '**/*',
      '!test{,/**}',
      '!dist{,/**}',
      '!screenshots{,/**}',
      '!scripts/setup-signing-secrets.sh',
    ],
    publish: PUBLISH,
    // The paid-computer link is alansway://claim?token=…; without a declared
    // scheme the packaged macOS app is never a valid handler, so the runtime
    // setAsDefaultProtocolClient call alone cannot deliver cold-start links.
    protocols: [{ name: 'alansway', schemes: ['alansway'] }],
    mac: {
      target: [
        { target: 'dmg', arch: ['arm64'] },
        // electron-updater on macOS only consumes the zip; the dmg stays for
        // downloads and for unsigned installs that still self-update.
        { target: 'zip', arch: ['arm64'] },
      ],
      icon: 'assets/icon.icns',
      category: 'public.app-category.productivity',
      artifactName: 'OpenAlan-mac.${ext}',
      // Without a usage string macOS kills the app when a page takes a granted
      // camera or microphone permission.
      extendInfo: {
        NSCameraUsageDescription: 'A web page in this workspace can use the camera after you allow it.',
        NSMicrophoneUsageDescription: 'A web page in this workspace can use the microphone after you allow it.',
      },
      ...(signed
        ? { hardenedRuntime: true, entitlements: ENTITLEMENTS, entitlementsInherit: ENTITLEMENTS, notarize }
        : { identity: '-', hardenedRuntime: false, notarize: false }),
    },
    dmg: { artifactName: 'OpenAlan-mac.${ext}' },
    win: {
      target: [{ target: 'nsis', arch: ['x64'] }],
      icon: 'assets/icon.ico',
    },
    nsis: {
      oneClick: true,
      perMachine: false,
      artifactName: 'OpenAlan-windows-setup.${ext}',
    },
    linux: {
      target: [{ target: 'AppImage', arch: ['x64'] }],
      icon: 'assets/icon.png',
      category: 'Network',
      artifactName: 'OpenAlan-linux.${ext}',
    },
    ...(notarize ? { afterSign: stapleApp } : {}),
  };
}

module.exports = () => createConfig(process.env);
module.exports.createConfig = createConfig;
module.exports.PUBLISH = PUBLISH;

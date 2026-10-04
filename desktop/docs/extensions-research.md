# Chrome extension integration research

Investigated 2026-10-03 for the desktop application using Electron 44.5.1 on macOS arm64. Package versions were checked against the npm registry, and API details against the package authors' published source and type declarations. This note describes integration options; it does not certify extension compatibility.

## Why the store offers Chrome

The application already uses Chromium through Electron. Chromium page rendering does not supply the complete Chrome browser extension host. Electron documents a limited extension API, loads only unpacked extensions into persistent sessions, and does not automatically restore them after restart. Our original extension loader provides loading, pinned icons and popup windows; it does not implement the Web Store installation API. Changing the user agent alone would not fill those gaps. [Electron extension support](https://www.electronjs.org/docs/latest/api/extensions)

## Practical integration components

### Store installation: MIT

`electron-chrome-web-store` **0.13.0** supplies actual store installation, CRX download/unpacking, extension loading and updates. It can enable the install flow inside our existing local browser session. Its preload must be packaged. Its README describes startup loading and automatic update checks; these are separate from implementing the extension's browser APIs. [Package metadata](https://registry.npmjs.org/electron-chrome-web-store/0.13.0), [author's store README](https://github.com/samuelmaddock/electron-browser-shell/blob/master/packages/electron-chrome-web-store/README.md)

```js
await installChromeWebStore({
  session: browserSession,
  extensionsPath,
  autoUpdate: true,
  loadExtensions: true,
  minimumManifestVersion: 3,
  beforeInstall: async details => ({ action: 'allow' }),
});
await installExtension(extensionId, { session: browserSession, extensionsPath });
await uninstallExtension(extensionId, { session: browserSession, extensionsPath });
await updateExtensions(browserSession);
```

`beforeInstall(details)` receives the ID, localized name, manifest, icon, originating frame and optional browser window, and must return `{ action: 'allow' | 'deny' }`. The application should use that hook for its ordinary extension permissions confirmation. `installExtension` resolves to `Electron.Extension`. `downloadExtension(id, extensionsDir)` resolves to an unpacked path. [Store types](https://github.com/samuelmaddock/electron-browser-shell/blob/master/packages/electron-chrome-web-store/src/browser/types.ts), [installer implementation](https://github.com/samuelmaddock/electron-browser-shell/blob/master/packages/electron-chrome-web-store/src/browser/installer.ts)

The downloader restores the CRX public key into the unpacked manifest to retain the store extension ID. A hand-extracted ZIP without that key can acquire a different runtime ID. Its store preload registers the browser installation APIs; this is functional integration beyond presenting a different user agent. [Store installer source](https://github.com/samuelmaddock/electron-browser-shell/blob/master/packages/electron-chrome-web-store/src/browser/installer.ts), [store API source](https://github.com/samuelmaddock/electron-browser-shell/blob/master/packages/electron-chrome-web-store/src/browser/api.ts)

### Browser API host: GPL or paid alternate license

`electron-chrome-extensions` **4.9.0** adds tabs, windows, actions, popups, cookies, context menus, permissions and other browser API implementations. Electron 35 or newer and sandboxed extension service workers are required; the current local `persist:browser` session and sandbox settings fit. The project documents remaining gaps including commands, tab capture, tab groups/movement and some context menu methods. It is not complete Chrome parity. [Package metadata](https://registry.npmjs.org/electron-chrome-extensions/4.9.0), [author's API coverage and limitations](https://github.com/samuelmaddock/electron-browser-shell/blob/master/packages/electron-chrome-extensions/README.md)

The constructor requires an explicit distribution license. Valid values are **`GPL-3.0`** and **`Patron-License-2020-11-19`**. The published package contains both license texts; the Patron option requires qualifying recurring sponsorship. The user selected the free GPL desktop route, so the integration will use `GPL-3.0` and include the required license notices and source distribution terms. This is a deliberate change from the previous MIT desktop package declaration; the independently licensed Hermes add-on components do not require changing stock Hermes itself. [License declaration](https://github.com/samuelmaddock/electron-browser-shell/blob/master/packages/electron-chrome-extensions/LICENSE.md), [GPL text](https://github.com/samuelmaddock/electron-browser-shell/blob/master/packages/electron-chrome-extensions/LICENSE-GPL), [Patron terms](https://github.com/samuelmaddock/electron-browser-shell/blob/master/LICENSE-PATRON.md), [license validation source](https://github.com/samuelmaddock/electron-browser-shell/blob/master/packages/electron-chrome-extensions/src/browser/license.ts)

Its typed integration surface fits WebContentsView tabs owned by the workspace BaseWindow:

```ts
new ElectronChromeExtensions({
  license, session,
  createTab(details): Promise<[Electron.WebContents, Electron.BaseWindow]>,
  selectTab(tab, window): void,
  removeTab(tab, window): void,
  createWindow(details): Promise<Electron.BaseWindow>,
  removeWindow(window): void,
  requestPermissions(extension, permissions): Promise<boolean>,
  assignTabDetails(details, tab): void,
});
extensions.addTab(tabWebContents, workspaceWindow);
extensions.selectTab(tabWebContents);
extensions.removeTab(tabWebContents);
```

Callbacks are optional but needed for the corresponding browser behavior. Existing tab creation, selection and closing must notify this host; extension pages should not be confused with Telegram or the VPS viewer. [Main class source](https://github.com/samuelmaddock/electron-browser-shell/blob/master/packages/electron-chrome-extensions/src/browser/index.ts), [integration interface](https://github.com/samuelmaddock/electron-browser-shell/blob/master/packages/electron-chrome-extensions/src/browser/impl.ts)

For toolbar UI, its preload exports `injectBrowserAction()`, and `<browser-action-list partition="persist:browser" tab="WEB_CONTENTS_ID">` renders extension actions. `ElectronChromeExtensions.handleCRXProtocol(uiSession)` enables icons in the UI session. The class emits `browser-action-popup-created` when it creates a popup. A custom toolbar can instead implement equivalent action activation, badge, popup and click-event behavior. [Browser action integration](https://github.com/samuelmaddock/electron-browser-shell/blob/master/packages/electron-chrome-extensions/README.md)

The runtime source implements `connectNative` and `sendNativeMessage`, although the README coverage list omits them. On macOS its native host locator checks system Chrome, user Chrome and app user-data manifest directories, then validates the extension origin before launching the host. The renderer also supplies compatibility settings for `chrome.privacy`; their presence is not proof that they enforce Chrome's settings semantics. [Runtime source](https://github.com/samuelmaddock/electron-browser-shell/blob/master/packages/electron-chrome-extensions/src/browser/api/runtime.ts), [native host source](https://github.com/samuelmaddock/electron-browser-shell/blob/master/packages/electron-chrome-extensions/src/browser/api/lib/native-messaging-host.ts), [renderer compatibility source](https://github.com/samuelmaddock/electron-browser-shell/blob/master/packages/electron-chrome-extensions/src/renderer/index.ts)

Permission handling remains basic: the library's `permissions.remove` returns success without revoking permissions; requested grants are kept in a memory map initialized from the manifest; origin requests use exact string membership, not Chrome's complete host-pattern policy. Its router checks handler permission requirements against manifest declarations. Without an application `requestPermissions` callback, requests are allowed by default. The application must supply that callback and its installation prompt, avoid advertising Chrome-equivalent per-site revocation, and keep host/browser control rules in its own adapter. [Permissions implementation](https://github.com/samuelmaddock/electron-browser-shell/blob/master/packages/electron-chrome-extensions/src/browser/api/permissions.ts), [router checks](https://github.com/samuelmaddock/electron-browser-shell/blob/master/packages/electron-chrome-extensions/src/browser/router.ts), [default request behavior](https://github.com/samuelmaddock/electron-browser-shell/blob/master/packages/electron-chrome-extensions/src/browser/store.ts)

## 1Password compatibility

The public Google-distributed 1Password package inspected was **8.12.38.34**, ID **`aeblfdkhhhdcdjpifhhbdiojplfjncoa`**, Manifest V3. Its manifest uses a module background service worker, a toolbar popup and all-frame content scripts. Permissions include alarms, idle, downloads, privacy, native messaging, scripting, storage, tabs, navigation, request authentication and declarative network requests. Static inspection also finds calls to commands, `storage.session`, `action.getUserSettings` and external messaging. Calls may be guarded or feature-specific: presence alone does not prove a fatal incompatibility. This makes an isolated background-worker and popup test necessary before claiming autofill. [Official Web Store entry](https://chromewebstore.google.com/detail/1password-password-manage/aeblfdkhhhdcdjpifhhbdiojplfjncoa), [Google package endpoint](https://clients2.google.com/service/update2/crx?response=redirect&prodversion=148.0.0.0&acceptformat=crx3&x=id%3Daeblfdkhhhdcdjpifhhbdiojplfjncoa%26installsource%3Dondemand%26uc)

Standalone browser sign-in is supported by 1Password independently of the desktop application; that is the first compatibility target. Native app unlock/Touch ID is a second target requiring native messaging and browser trust. 1Password's Mac instructions require the additional browser in Applications to be code signed by Apple. A locally packaged/ad-hoc app must not be assumed eligible or made to impersonate Chrome. [1Password browser unlock](https://support.1password.com/getting-started-browser/), [first-party standalone explanation](https://www.1password.community/discussions/1password/using-in-browser-without-desktop-app/99074), [additional browser connection requirements](https://support.1password.com/additional-browsers/)

## Alternatives and recommendation

CEF provides a native Chromium embedding framework, including Chrome-style and Alloy-style browsers, macOS packaging, native views and offscreen rendering. Migrating would require a native browser host, lifecycle/IPC integration and rebuilding the current browser backend. Its existence is not evidence that our current Electron WebContents can acquire complete Chrome extension support by changing an engine flag. Treat it as a separate engineering project if extension parity remains unacceptable after a proven API host. [CEF tutorial](https://chromiumembedded.github.io/cef/tutorial), [CEF native architecture](https://chromiumembedded.github.io/cef/general_usage)

With the user's GPL choice, the practical path is the store component plus `electron-chrome-extensions` in the existing persistent local session. Integrate actions into the existing toolbar; verify real extension worker startup, 1Password standalone setup and a disposable login form; then tackle desktop unlock only with supported signing and explicit user pairing. Do not infer successful autofill from an installed icon or a popup merely rendering.

## Verified 1Password startup fix

The genuine 8.12.38.34 package initially installed successfully but its worker failed on `browser.windows.WINDOW_ID_NONE`. Isolated probes confirmed the extension host preload ran: `chrome.windows` existed after its API shim, while the native `browser.windows` remained absent. Chromium 148 introduced `browser` alongside `chrome`; extensions using webextension-polyfill skip its wrappers when native `browser` already exists. The 4.9.0 host augments `chrome` but does not synchronize the native `browser` namespace, so 1Password selected the incomplete namespace. This was a namespace integration fault, not a CRX installation or sandbox failure. [Chrome namespace behavior](https://developer.chrome.com/docs/extensions/develop/concepts/browser-namespace), [host renderer shim](https://github.com/samuelmaddock/electron-browser-shell/blob/master/packages/electron-chrome-extensions/src/renderer/index.ts)

The application now registers its own frame and service-worker compatibility preload after the host preload, aliasing `browser` to the augmented `chrome` only in extension contexts with a runtime ID. The public 1Password package is unchanged, sandboxing stays enabled, and no browser-signing or native-app trust check is bypassed. The independent probe reached the genuine worker's completed initialization; the application's isolated store test then passed installation, restart loading and welcome-page startup on Electron 44.5.1. See [application preload](../src/extension-namespace-preload.cjs) and [store integration test](../test/web-store-electron.cjs). Those results do not establish signed-in autofill or native desktop unlock.

## Electron 44 inline-frame compatibility

Electron 44 no longer runs window/session preloads in an ordinary page's embedded `chrome-extension://` iframe unless subframe integration is enabled. Top-level extension pages and extensions hosted by DevTools still receive them. Therefore an inline extension menu can lack the host's added APIs even when its toolbar popup and worker work. This change does not disable Chromium's native content-script injection: the renderer initializes its extension frame helper and executes extension scripts separately from the preload eligibility check. [Electron 44 behavior change](https://www.electronjs.org/docs/latest/breaking-changes#behavior-changed-preload-scripts-only-run-in-devtools-extension-frames-hosted-by-devtools), [44.5.1 renderer source](https://github.com/electron/electron/blob/v44.5.1/shell/renderer/renderer_client_base.cc)

Static inspection of this 1Password package's inline modules finds primarily runtime URL lookup, messaging and connection APIs, which Electron supports natively. Its `action.getUserSettings` / `browserAction.getUserSettings` lookup is guarded and returns false when absent. This suggests that ordinary inline menus may work without enabling subframe Node integration; it remains an inference until a disposable local form exercises actual injection and the menu. Test native messaging and menu startup first; keep sandboxing and the existing subframe integration setting while that test determines whether any compatibility change is necessary. [Electron native runtime support](https://www.electronjs.org/docs/latest/api/extensions#chromeruntime), [inspected public package](https://clients2.google.com/service/update2/crx?response=redirect&prodversion=148.0.0.0&acceptformat=crx3&x=id%3Daeblfdkhhhdcdjpifhhbdiojplfjncoa%26installsource%3Dondemand%26uc)

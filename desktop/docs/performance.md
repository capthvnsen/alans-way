# Alan's Workspace — Performance Baseline and Optimizations

Measured on macOS arm64 (Electron `44.5.1`, Node `26.7.0` host / embedded Node `24` in Electron, `electron-builder` `26.17.0`). All measurements were collected without launching a visible window (directory packaging, zip packaging, static analysis, and plain-`node` timing).

---

## 1. Baseline

### 1.1 Download and installed size

Built with `npm run package:mac -- --dir` and `npx electron-builder --mac zip --publish never` from `desktop/`:

| Artifact / Component | Size | Files | Notes |
| --- | ---: | ---: | --- |
| `OpenAlan-mac.zip` (download, default compression) | **142.00 MB** (`148,899,011 B`) | 1 | `electron-updater` and direct download archive |
| `alans-way-localapp.app` (apparent / `du -sh`) | **347.86 MB** (`364,758,985 B`) / **361 MB** on disk | 3,709 | `asar: false` |
| `Contents/Frameworks/` (Electron + Chromium + helpers) | **285.66 MB** (`299,531,879 B`) | 273 | Includes 220 `.lproj` locales (**48.03 MB**; `en` + `en_GB` = **1.11 MB**) |
| `Contents/Resources/LICENSES.chromium.html` | **19.18 MB** | 1 | Chromium third-party license notice (must stay) |
| `Contents/Resources/icon.icns` | **1.01 MB** | 1 | App icon |
| `Contents/Resources/app/node_modules/` | **23.98 MB** (`25,140,595 B`) | 3,259 | 124 packages; includes `.map`, `.ts`, `.d.ts`, ESM/UMD duplicates |
| `Contents/Resources/app/assets/` | **11.50 MB** (`12,056,962 B`) | 19 | 10 marble avatars at 1254×1254 PNG (**9.70 MB**), `icon.icns` (1.06 MB), `icon.ico` (605 KB), `icon.png` (605 KB) |
| `Contents/Resources/app/src/` | **4.14 MB** (`4,335,907 B`) | 95 | `newtab-backdrop.png` alone is **2.81 MB** (1672×941 RGB PNG) |
| `Contents/Resources/app/scripts/` | **1.05 MB** (`1,099,576 B`) | 25 | Includes `mac-computer` (446 KB) plus build-only/dev scripts (`*.swift`, `*.cs`, `*.py`, bench scripts) |
| `Contents/Resources/app/docs/` + `eval/` + top-level `.md` | **0.26 MB** | 26 | Dev docs and eval harness shipped inside the app bundle |
| `Contents/_CodeSignature/` | **1.03 MB** | 1 | Code signature directory (scales with file count) |

Top packages inside `Contents/Resources/app/node_modules/`:

| Package | Size | Files | Notes |
| --- | ---: | ---: | --- |
| `@xterm/xterm` | 5.56 MB | 155 | `xterm.js.map` (1.92 MB) + `xterm.mjs.map` (1.69 MB) + unused `xterm.mjs` (345 KB) |
| `zod` | 5.50 MB | 715 | Pulled by `@modelcontextprotocol/sdk`; includes `src/` `.ts`, `.d.ts`, `.d.cts`, `.d.mts`, ESM/CJS duplicates |
| `@modelcontextprotocol/sdk` | 2.93 MB | 530 | Used by `scripts/browser-mcp.cjs`; includes `dist/esm/` alongside `dist/cjs/` and `.map`/`.d.ts` |
| `markdown-it` | 2.12 MB | 20 | `.map` files total 1.52 MB; renderer loads only `dist/browser/markdown-it.umd.min.js` (98 KB) |
| `js-yaml` | 0.91 MB | 35 | Pulled by `electron-updater`; `.map` files total 0.55 MB |
| `ajv` | 0.90 MB | 359 | Pulled by `@modelcontextprotocol/sdk`; includes `.d.ts` and `.map` |
| `hono` | 0.86 MB | 382 | Pulled by `@modelcontextprotocol/sdk` |
| `@novnc/novnc` | 0.60 MB | 65 | Used by `src/remote.js` |
| `electron-updater` | 0.50 MB | 66 | Used by `src/main.cjs` for signed updates |

All 8 entries in `desktop/package.json` `dependencies` are genuinely used at runtime (none are test/build-only).

**`asar` analysis:** External MCP clients (Hermes on Mac, Hermes on VPS over SSH, Grok Bot, `scripts/install-mac.sh`, `README.md`, `docs/products.md`) execute `/Applications/alans-way-localapp.app/Contents/Resources/app/scripts/browser-mcp.cjs` directly with **system `node`** (not Electron). Plain Node cannot read inside `app.asar`, and enabling `asar: true` removes `Contents/Resources/app/` in favor of `app.asar` + `app.asar.unpacked/`. Moreover, `asar` is an uncompressed archive, so it does not shrink compressed `.zip`/`.dmg` downloads. Therefore `asar: false` is kept intentionally to preserve the external connector path contract without duplicating `node_modules` and `src/` twice.

### 1.2 Main-process startup (`desktop/src/main.cjs`)

Plain-Node cold `require()` timing across `main.cjs` dependencies (58 non-Electron modules measured sequentially with `process.hrtime.bigint()`):

| Module | Cold load | Loaded at boot? | Needed for first paint? |
| --- | ---: | --- | --- |
| `electron-updater` | 123.88 ms | Deferred to `startUpdates()` (runs immediately after `createWindow()`) | No |
| `./extension-store.cjs` (pulls `electron-chrome-web-store`, `adm-zip`) | 41.55 ms | Eager at line 51 | No |
| `./bot-auth.cjs` | 12.35 ms | Eager at line 3 | Only when local API receives a request |
| `./tailnet.cjs` | 11.23 ms | Eager at line 1 | Needed by config/SSH |
| `./gateway-link.cjs` | 10.45 ms | Eager at line 35 | Needed if native chat active |
| `./native-chat.cjs` | 10.20 ms | Eager at line 32 | Needed if native chat active |
| `./agent-input.cjs` | 8.82 ms | Eager at line 43 | Only on agent browser input |
| `./shell-support.cjs` | 5.94 ms | Eager at line 15 | Yes |
| 50 other `./*.cjs` modules | ~57.88 ms | Eager at top of `main.cjs` | Many only needed on demand (cloud onboarding, setup check, updates, recorder, computer-use, key import) |
| **Total (58 non-Electron modules)** | **282.30 ms** | | |
| `electron-chrome-extensions` | *(requires Electron runtime)* | Eager at line 56 | Only needed for extension host |

Synchronous / blocking work in `app.whenReady()` before `win.loadFile('index.html')` can paint:

1. `readPreferences()` (`main.cjs:209`): synchronous `fs.readFileSync` + `JSON.parse` of `preferences.json` (which currently embeds full base64 data URLs for all imported custom avatars and Telegram bot avatars, rewriting the whole blob on every preference save).
2. `seedMacSshHost()` (`main.cjs:3938`): calls `tailscaleSshHost()` (`shell-support.cjs:172`), which runs **`execFileSync` on the Tailscale CLI with a 3,000 ms timeout** synchronously before `createWindow()` whenever `prefs.macSshHost` is unset.
3. `createHermesHub()` (`main.cjs:3939`): synchronous `fs.readFileSync` + `safeStorage.decryptString` on `hermes-gateway.json`.
4. `staleConnector()` (`main.cjs:3957`): synchronous `fs.statSync` / `fs.readFileSync` / `fs.rmSync`.
5. `await settleWithin(browserSessionStore.restore(), 5000)` (`main.cjs:3961`): awaits OS keychain decryption and hidden Chromium cookie-restore views (up to 5,000 ms) **before creating the window**.
6. `new ElectronChromeExtensions(...)` + `await extensionStore.installStore()` (`main.cjs:3983-4008`): initializes extension subsystem and awaits Chrome Web Store hook installation **before creating the window**.
7. `gatewayLink.start()` + `createNativeChat(...)` (`main.cjs:4022-4042`): opens WebSocket / reads disk before `createWindow()`.
8. Inside `createWindow()` (`main.cjs:3787-3860`):
   - Eagerly creates both `telegramView` and `remoteView`, and calls `remoteView.webContents.loadFile('remote.html')` (loads `@novnc/novnc`) even when `canvasTab !== 'screen'`.
   - Calls `restoreBrowserTabs()` synchronously, immediately instantiating up to **40 `WebContentsView`s** and calling `loadURL()` on all of them concurrently, placing inactive tabs in `backgroundWindow` with `backgroundThrottling: false` and `view.setVisible(true)`.
   - Immediately calls `startUpdates()` (which triggers `require('electron-updater')` ~124 ms + network checks) and `checkWebapp()` before first paint settles.
9. No V8 compile cache (`node:module` `enableCompileCache()`) enabled.

### 1.3 Renderer load (`desktop/src/index.html`)

| Resource | Size | Needed for first paint? |
| --- | ---: | --- |
| `style.css` | 73.0 KB | Yes |
| `avatars.css` | 10.2 KB | Yes |
| `../node_modules/@xterm/xterm/css/xterm.css` | 6.9 KB | **No** (Terminal tab only) |
| **Total CSS (3 files)** | **90.1 KB** | |
| `../node_modules/@xterm/xterm/lib/xterm.js` | **477.2 KB** | **No** (Terminal tab only — 53.8% of boot JS) |
| `../node_modules/@xterm/addon-fit/lib/addon-fit.js` | 1.5 KB | **No** (Terminal tab only) |
| `renderer.js` | 195.4 KB | Yes |
| `../node_modules/markdown-it/dist/browser/markdown-it.umd.min.js` | 98.4 KB | Only when native chat is shown |
| `native-chat.js` | 35.9 KB | Only when native chat is shown |
| `hermes-view.js` | 34.4 KB | Only when Hermes view is shown |
| `avatars.js` | 28.9 KB | Yes |
| `workspace-shortcuts.cjs` | 9.1 KB | Yes |
| `gateway-list.js` | 2.6 KB | Yes |
| `compact-policy.cjs` | 1.5 KB | Only when native chat is shown |
| `onboarding-copy.cjs` | 1.1 KB | Only during onboarding |
| `browser-control.cjs` | 0.8 KB | Yes |
| **Total JS (12 files)** | **886.7 KB** | |

Always-on renderer costs:
- `avatars.js:172-187`: permanent 60 Hz `requestAnimationFrame` loop whenever a presence avatar with eyes is mounted, even when idle and pointer is still; calls `record.face.getBoundingClientRect()` on **every single frame** (forced layout query at 60 Hz).
- CSS infinite animations (`avatars.css`, `style.css`, `telegram-preload.cjs`): `hermes-orbit`, `hermes-bust-glow`, `tab-spin`, `agent-cursor-glow`, `agent-busy`, `hwWingBeat`, `recording-pulse`, `nc-pulse`, `hwOrbit`.
- `renderer.js:2520`: `window.terminal.onData((id, data) => terminalView(id).term.write(data))` writes every raw stdout chunk directly to xterm with zero batching.

### 1.4 Steady-state idle compute (timers, pollers, watchers, streams)

| Location | Mechanism | Period | Runs when window hidden/minimized? | Notes |
| --- | --- | ---: | --- | --- |
| `main.cjs:3838` | `pointerTimer` (`setInterval`) | **50 ms (20 Hz)** | Wakes 20×/s, returns early if hidden; **sends IPC 20×/s even when pointer is completely still** | Reads cursor + bounds + zoom and sends `workspace:pointer` unconditionally |
| `main.cjs:3845` | `activityTimer` (`setInterval`) | **500 ms (2 Hz)** | **Yes** | Runs `activity.expire()` + `JSON.stringify(computeBotWork())` twice per second forever |
| `main.cjs:3855` | `captchaTimer` (`setInterval`) | **1,000 ms (1 Hz)** | **Yes** | Iterates all tabs every second even with zero CAPTCHAs |
| `main.cjs:4028` | Gateway online poll (`setInterval`) | **1,000 ms (1 Hz)** | **Yes** | Polls `net.isOnline()` every 1s even when already online |
| `main.cjs:3742` | Telegram online poll (`setInterval`) | **3,000 ms** | **Yes** | Duplicate `net.isOnline()` poller alongside line 4028 |
| `main.cjs:3857` | `vpsTick` (`setTimeout` loop) | **5,000 ms** (backoff to 60s) | **Yes** | Spawns multiplexed SSH poll every 5s when VPS configured |
| `main.cjs:3859` | `vpsMirrorTimer` (`setInterval`) | **10,000 ms** | **Yes** | Evaluates `checkpointExpression` on up to 20 agent tabs every 10s |
| `main.cjs:3681` | `hiddenPoll` (`setInterval`) | **15,000 ms** | Only when hidden | Drives `telegram:poll` while window hidden |
| `main.cjs:3847` | `idleTimer` (`setInterval`) | **30,000 ms** | **Yes** | Releases idle agent tabs after 15 min |
| `main.cjs:4046` | Webapp retry (`setInterval`) | **30,000 ms** | **Yes** | Retries `checkWebapp()` only when `webappStatus === 'unreachable'` |
| `main.cjs:1644` | `checkVersionsWhenIdle` (`setInterval`) | **30 min** | **Yes** | Periodic version check |
| `main.cjs:1693` | App update check (`setInterval`) | **6 hours** | **Yes** | Periodic release check |
| `main.cjs:427` | Terminal stdout -> IPC | Per chunk (unbatched) | **Yes** | Unbatched IPC per `child.stdout` chunk |
| `main.cjs:623,1001` | Background browser tabs | Continuous | **Yes** | All human + agent background tabs run with `backgroundThrottling: false` and `setVisible(true)` in `backgroundWindow` |
| `avatars.js:172` | `requestAnimationFrame` | **16.7 ms (60 Hz)** | Pauses on `document.hidden` | Runs continuously while visible; calls `getBoundingClientRect()` every frame |
| `native-chat.js:525` | `compactTimer` (`setInterval`) | **30,000 ms** | **Yes** | Refreshes compact-chip countdown while native chat mounted |
| `telegram-preload.cjs:311` | `schedulePoll` (`setTimeout` loop) | **2.5 s** active / **5 s** idle | Pauses on `'hidden'` (main drives 15s) | Reads IndexedDB `tt-data` + DOM fingerprint |
| `telegram-preload.cjs:319` | `heartbeat` (`setInterval`) | **2,500 ms** | Throttled by Chromium when hidden | Sends `telegram:activity` heartbeat |

### 1.5 Linux VM host (`vps-chromium-host.cjs`, `vps-browser-host.cjs`, `vps-computer.py`, `cdp.cjs`)

| Component | Baseline behavior | Cost on VM |
| --- | --- | --- |
| `vps-chromium-host.cjs:45` | `setInterval` polling `fetch('/json/version')` every **3,000 ms** forever; does not react to `child.on('exit')` | Constant 0.33 Hz HTTP requests + timer wakeups |
| `vps-browser-host.cjs:334` | `setInterval` every **1,000 ms** iterating all tabs for CAPTCHA probes even when no tab has a CAPTCHA | 1 Hz wakeups forever while idle |
| `vps-browser-host.cjs:1245` | `reloadTimer` calling `fs.statSync(__filename)` every **5,000 ms** forever | 0.2 Hz sync stat forever |
| `vps-browser-host.cjs:282, 409` | Idle timer releases agent control after 15 min, **never** reaps idle tabs — `reapAgentTabs` only runs on the next `open()` | Idle Chromium renderer processes stay in VM RAM indefinitely between runs |
| `src/cdp.cjs:130` | `AGENT_BROWSER_FLAGS` only passes the 3 background-throttling disable flags; omits low-overhead headless-ish flags (`--disable-background-networking`, `--disable-component-update`, `--disable-default-apps`, `--disable-sync`, `--no-default-browser-check`, `--metrics-recording-only`, `--disable-dev-shm-usage`, `--disable-features=Translate,BackForwardCache,MediaRouter,OptimizationHints`) | Chromium runs background updates, SafeBrowsing/network chatter, BFcache memory retention, and default `/dev/shm` pressure |
| `vps-computer.py:286-289` | `Bus.many()` busy-polls `context.iteration(False)` + `time.sleep(0.0005)` (**2,000 wakeups/sec**) while waiting for AT-SPI D-Bus replies | Spikes VM CPU during every desktop snapshot/walk |
| `vps-computer.py:1999` | Already runs as a persistent `serve` daemon (via `computer-helper.cjs`), avoiding Python startup per call; screenshot capture uses Pillow `ImageGrab` first, then falls back to `import`/`xwd`/`scrot`/`ffmpeg` | Subprocess spawns only on fallback or `xdotool` calls |

---

## 2. Opt-in Startup Timing Hook

*(Added during optimization — see usage below.)*

---

## 3. After Measurements

*(Filled in after all optimizations are implemented and re-measured.)*

---

## 4. Not Done and Why

*(Populated at the end with ranked follow-up opportunities.)*

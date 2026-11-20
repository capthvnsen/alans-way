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

**`asar` analysis:** External MCP clients (Hermes on Mac, Hermes on VPS over SSH, Grok Bot, `README.md`, `docs/products.md`) execute `/Applications/alans-way-localapp.app/Contents/Resources/app/scripts/browser-mcp.cjs` directly with **system `node`** (not Electron). Plain Node cannot read inside `app.asar`, and enabling `asar: true` removes `Contents/Resources/app/` in favor of `app.asar` + `app.asar.unpacked/`. Moreover, `asar` is an uncompressed archive, so it does not shrink compressed `.zip`/`.dmg` downloads. Therefore `asar: false` is kept intentionally to preserve the external connector path contract without duplicating `node_modules` and `src/` twice. See §3.6 for the decision record.

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

## 2. Opt-in startup timing hook

Run the packaged app (or `npm start`) from a terminal with `HERMES_WORKSPACE_PROFILE_BOOT=1`; each milestone prints once to stderr as `[boot-timing] <name> +<ms>ms`, measured from the first line of `main.cjs`:

`process-start` → `app-ready` → `prefs-loaded` → `window-created` (the window object exists and `index.html` is loading) → `first-paint` (`did-finish-load` of `index.html`, so scripts have run; it is not a compositor paint) → `ui-interactive` (the renderer has rendered the first state). Without the variable nothing is logged and the IPC handler returns at once. Code: `src/boot-timing.cjs`, test `test/boot-timing.test.cjs`. These numbers need a window, so they are **not** in the tables below.

---

## 3. After (branch `agent/p1-performance`)

Built with `npx electron-builder --mac zip --publish never` in `desktop/` (arm64, ad-hoc signed, no window opened). Sizes are bytes, 1 MB = 10^6 B.

### 3.1 Size

| | Before | After | Change |
| --- | ---: | ---: | ---: |
| Download (`OpenAlan-mac.zip`) | 148,899,011 B (148.9 MB) | 122,860,711 B (122.9 MB) | **-26.0 MB (-17.5%)** |
| Installed `.app`, apparent bytes | 364,758,985 B (364.8 MB) | 289,231,445 B (289.2 MB) | **-75.5 MB (-20.7%)** |
| Installed, `du` on disk | 361 MiB | 283 MiB (289,520 KiB) | -78 MiB |
| Files in the bundle | 3,709 | 1,991 | -1,718 |
| Electron locale folders | 220 `.lproj` (48 MB) | `en`, `en_GB` | -47 MB |
| Built-in avatar PNGs | 9.70 MB (1254×1254) | 1.17 MB (384×384) | -8.5 MB |
| `node_modules` shipped | 25.1 MB | 15.1 MB | `.map`, `.d.ts`, ESM/duplicate builds, READMEs removed |

Where it came from: locales (`electronLanguages: ['en']`), avatar resize + PNG optimise, `.map` / `.d.ts` / unused ESM builds / dev docs / bench and build scripts left out of the package (`electron-builder.cjs`). Verified on the built app: every relative `require`, `path.join(__dirname, …)` and `index.html` script/link target resolves, except two that are expected (`docs/setup-prompt.md`, which ships as `Resources/setup-prompt.md`, and `win-computer.exe`, which exists only in Windows builds), and `node …/Resources/app/scripts/browser-mcp.cjs --bot-id x` loads the MCP SDK from the packaged tree and exits cleanly on stdin EOF.

Visible effect of the locale trim: only English Chromium UI strings ship, so Chromium-drawn text (a few native dialogs) is English on a non-English macOS. The app's own UI was already English only. Spell-check language comes from the OS, not from these files.

### 3.2 Boot path (main process)

| Work | Before | After |
| --- | --- | --- |
| V8 bytecode | recompiled every launch | compile cache on (`module.enableCompileCache`; on Linux under `~/.cache/alans-way`, not shared `/tmp`) |
| Tailscale probe | `execFileSync`, up to 3 s, before the window | async, after the window; result applied when it lands |
| `electron-chrome-extensions` + `extension-store` (+ `adm-zip`, web-store hook) | required and `await installStore()` before the window | required after `createWindow()`; store awaits last, failures are logged and no longer stop the rest of the boot tail |
| `computer`/`win-computer`/`vps-computer`, `mac-permissions`, `server-setup`, `batch-flow` | required at load | required on first use (proxies; `hostComputer.launch` stays absent off macOS as before) |
| `remote.html` view (noVNC) | created and loaded before the window | created when `index.html` finishes loading, or at once if the Screen tab is shown |
| `electron-updater` (~124 ms cold) + update network check | right after `createWindow()` | 1 s after load (2.5 s at the latest) |
| Stale-connector cleanup, webapp probe, cloud polling | before the window | after it |
| Still before the window, on purpose | `readPreferences`, hermes hub | unchanged. `browserSessionStore.restore()` no longer belongs here; see §3.7 |

Plain-node cold `require` of the main-process modules, measured by the first pass: median 34.9 ms → 27.1 ms with lazy loading, and 42.7 → 34.9 ms warm with the compile cache.

### 3.3 Renderer first load

| | Before | After |
| --- | ---: | ---: |
| Boot JS (parsed before the UI renders) | 886.7 KB, 12 files | 419.8 KB, 10 files (xterm 477 KB + addon-fit load on the first Terminal use) |
| Boot CSS | 90.1 KB, 3 files | 85.2 KB, 2 files (xterm.css loads with xterm; the terminal waits for it) |

Left as is: `markdown-it` (101 KB), `native-chat.js` (37 KB), `hermes-view.js` (35 KB). `renderer.js` constructs the native chat and Hermes views at start-up whenever their bridges exist, so loading them later needs a renderer restructure that cannot be verified without a window. `defer` on the existing tags would gain nothing: they already sit after the markup at the end of `<body>` and must keep their order. The presence avatar's `requestAnimationFrame` loop already stops when `document.hidden`, rests when the node is not laid out or the user prefers reduced motion, and only runs for an avatar painted with `animate: true`.

### 3.4 Idle work (window open, nothing happening, VPS configured)

Counts are derived from the code, not profiled.

| Timer | Before | After |
| --- | --- | --- |
| Pointer feed | 20 wakeups/s **and 20 IPC/s** | up to 20/s only while the pointer moves; 10/s after 2.5 s still; **0 IPC/s** when still; **0 wakeups when hidden/minimised** |
| Activity / bot-work check | 2/s always (stringifies the work map each time) | 2/s visible; 0.2/s hidden with nothing active; work map only recomputed when an agent tab exists |
| CAPTCHA watch | 1/s always | 0/s; starts only while a tab awaits a CAPTCHA and stops after |
| Online checks (gateway + Telegram) | 1/s + 0.33/s, two pollers | one poller: 0.2/s online, 1/s offline |
| VPS tab poll | 0.2/s (backs off on failure) | 0.2/s visible; 0.1/s hidden with nothing waiting; 0.03/s when no VM is configured. Showing or restoring the window refreshes at once |
| VPS mirror push | 0.1/s | 0.1/s, skipped unless connected |
| Terminal output | one IPC per stdout chunk | at most one IPC per 16 ms (first chunk goes out at once; flush at 64 KB) |
| **Total wakeups/s, visible, pointer still** | ~24.7 | ~12.5 |
| **Total wakeups/s, hidden** | ~24.7 | ~0.6 |

### 3.5 VM side

| Change | Effect |
| --- | --- |
| `vps-computer.py` `Bus.many()` blocks in the GLib main loop (`iteration(True)` with a deadline wake-up) instead of `iteration(False)` + `sleep(0.5 ms)` | No 2,000 wakeups/s spin during every desktop snapshot or tree walk. Results, errors and timeout handling unchanged |
| Chromium flags `--disable-sync`, `--no-default-browser-check` added to `AGENT_BROWSER_FLAGS` | Removes work that does nothing on an agent VM. No `--disable-features` on purpose (Chromium keeps only the last one and would replace the user's own) |
| Looked at and left | `vps-chromium-host` 3 s health check is the crash-restart supervisor (the launcher can exit while Chromium lives, so `exit` events are not enough); host 1 s CAPTCHA tick and 5 s script-mtime check are a few microseconds each. The host does not capture or stream anything while idle, and the Python helper is already a persistent `serve` process |

### 3.6 asar decision: stay off

- `/Applications/alans-way-localapp.app/Contents/Resources/app/scripts/browser-mcp.cjs` is the documented, hard-coded launch path (`README.md:59`, `desktop/README.md:78-104`, `docs/products.md:30`), run by the user's own system `node`, which cannot read inside `app.asar`.
- asar turns `Resources/app/` into `Resources/app.asar` (+ `app.asar.unpacked/`), so that path would break for every existing Hermes/MCP configuration. A compatibility symlink `Resources/app → app.asar.unpacked` is possible in an `afterPack` hook, but I could not show without launching the packaged app that Electron then still loads `app.asar` rather than the symlinked folder, and a code-signed, auto-updated bundle with a symlink in `Resources` is a release risk of its own.
- Gain is small: asar is not compressed, so the zip would shrink by roughly 0.2 MB (one zip header per removed file, ~1,700 files). The real gain would be fewer small-file `stat`/`open` calls at start-up, which cannot be measured here without a window (estimate: tens of ms on a cold disk cache, mostly on slow disks).
- To revisit: `asar: true` + `asarUnpack: ['scripts/**', 'src/**', 'node_modules/@modelcontextprotocol/**', 'node_modules/zod/**', …everything browser-mcp requires]`, the `afterPack` symlink above, and a manual launch of a signed build to confirm both the app and `node …/Resources/app/scripts/browser-mcp.cjs` still work.

### 3.7 Window before sign-in restore (branch `agent/p4-window-before-restore`)

**Measured on the owner's real profile** (installed app, `HERMES_WORKSPACE_PROFILE_BOOT=1`), before this change:

```
app-ready +49.3ms   prefs-loaded +50.0ms   window-created +5125.7ms   first-paint +5262.5ms   ui-interactive +5272.5ms
```

`window-created` sits 5,075 ms after `prefs-loaded`, which is the 5 s cap on `browserSessionStore.restore()` plus window setup. So on that machine the restore does not finish in 5 s on a normal launch; the cap fires every time, and the user stares at nothing for it.

**Why the restore is slow (evidence, not proof).** On a throwaway profile in hidden mode (`test/probe-session-restore.cjs`) the whole restore, including the throwaway views, debugger attach and `Network.setCookies` for both partitions, takes about 40 ms, and each `setCookies` answers in 3 to 15 ms on a view that was never loaded. So the "debugger on an unloaded view never answers" theory is ruled out. The only step left that can take seconds is the macOS Keychain call (`isAsyncEncryptionAvailable` or `decryptStringAsync`): a locked or slow Keychain, or a Keychain access prompt that nobody sees. The probe uses Chromium's mock keychain, so it **cannot** reproduce or rule out a slow real Keychain; `keychainDelayMs` only imitates one. The marks below will name the slow step on the next real launch.

**Change.** The restore now starts, and the window is created in the same tick without waiting for it. `src/sign-in-gate.cjs` is the one gate: it opens when the restore settles, fails, or the same 5 s cap passes. Waiting on it (`main.cjs`): every tab load in `createTab` (restored tabs, tabs from the local API, extension tabs, Telegram links, handoffs), the Telegram view's first load, `openTelegramHash`, a typed navigation, the local API server's start (so agent tab creation and navigation cannot run first), and the extension store's restore. Not waiting: the window, `index.html`, the UI shell and everything else. The Hermes Desktop webapp uses `persist:hermes-webapp`, which the restore never touches, so it is not gated. A restore failure is still logged as `browser-restore` (no detail) and opens the gate. After the cap the restore keeps running; pages already loaded do not see its cookies until they reload (same as before the cap was added, but the window is no longer held for it).

Also: `restore()` now joins the store's save queue, so a save triggered by the restore's own cookie changes (or by quitting) waits for it instead of overwriting the saved sign-ins with a half-restored set.

**New boot marks** (print only with `HERMES_WORKSPACE_PROFILE_BOOT=1`), in order: `restore-start`, `restore-keychain-available` (the `isAsyncEncryptionAvailable` Keychain check returned), `restore-decrypted` (`decryptStringAsync` returned), then per partition `restore-browser-attached` / `restore-browser-set` and `restore-telegram-attached` / `restore-telegram-set` (debugger attached; `Network.setCookies` answered), and `restore-done`. Read the gaps: start to keychain-available is the availability check, keychain-available to decrypted is the decrypt (the Keychain), decrypted to the first `attached` is view creation and first partition use (the cookie database load), `attached` to `set` is the CDP command.

**What a re-measure should show** on the owner's profile: `window-created` back to roughly 100 to 200 ms after `prefs-loaded` (about +250 ms, not +5,126 ms) and `first-paint` about 5 s earlier. The `restore-*` marks then appear after `window-created`, and the restored tabs begin loading when `restore-done` prints, or at about +5 s if it is slower than that. Hidden-mode simulation (throwaway profile, Keychain decrypt delayed 8 s, `node test/probe-session-restore.cjs 20 8000`): before, `window-created` +5171.7 ms and `first-paint` +5268.7 ms; after, `window-created` +117 ms and `first-paint` +196 ms, with the saved tab's first request arriving about 5.1 s in (the cap) while the restore finished at +8.1 s. With no delay: `window-created` +118 ms, restore done +186 ms, tab request after it.

---

## 4. Not done, and why (ranked by likely payoff)

1. **Restore browser tabs lazily** (`restoreBrowserTabs()` creates up to 40 `WebContentsView`s and loads them all, with throttling off). Likely the biggest remaining boot and memory cost for heavy users. It changes what agents can see of "open" tabs, so it needs a design decision and a windowed test.
2. **Load `native-chat.js`, `markdown-it`, `hermes-view.js` on first use** (~170 KB of parse). Needs the renderer's start-up wiring reshaped; untestable without a window.
3. **Put avatar data URLs out of `preferences.json`** (it is read synchronously at boot and rewritten whole on every save). Needs a migration.
4. **Defer Telegram web view load** until the Telegram surface is shown. It is a heavy third-party page loaded at every start; changes when unread badges first appear.
5. **Stop background-throttling-off for inactive human tabs** (agent tabs need it; human ones may not). Behaviour-affecting.
6. **Reap idle agent tabs on the VM on a timer**, not only on the next `open()` (frees renderer RAM). Could close a tab an agent expects to resume.
7. **asar** — see §3.6.
8. **Windowed measurements**: first paint, time to interactive, memory and CPU at idle, before/after. Needs the timing hook (§2) run on a real window; none of it was run here.
9. **Electron-driven tests** (`npm run test:*`) cover the lazy Terminal tab, the delayed remote view and the extension host start-up; not run here. They should be run in CI or by hand.

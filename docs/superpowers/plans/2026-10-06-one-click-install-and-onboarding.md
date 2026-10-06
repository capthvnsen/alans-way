# One-click install, onboarding and updates: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship prebuilt Mac and Windows installers from CI, a first-run wizard
that hands the user one evergreen prompt for their Hermes agent, self-updating
apps, an evergreen agent-update prompt, and a cleaned-up openalan.com that
downloads the newest build.

**Architecture:**
- `electron-builder` replaces `@electron/packager`.
- A tag-triggered GitHub Actions workflow builds into a draft release, then
  publishes it, so `releases/latest/download/<fixed name>` always resolves.
- The app builds both agent prompts with a pure module that states facts and
  points at domain-owned URLs. The URLs redirect to docs on `main`.
- Windows updates with `electron-updater`. Mac uses a small
  download-verify-swap module until code signing exists.

**Tech stack:** Electron 44, plain CommonJS, `node:test`, electron-builder,
electron-updater, GitHub Actions, Cloudflare Pages `_redirects`, static HTML.

**Spec:** `docs/superpowers/specs/2026-10-06-one-click-install-and-onboarding-design.md`

## Global Constraints

- `productName` stays `alans-way-localapp`; bundle id `app.alans-way.localapp`.
- Mac app path `/Applications/alans-way-localapp.app`. Windows path
  `%LOCALAPPDATA%\Programs\alans-way-localapp\alans-way-localapp.exe`.
- The app's code must stay at `Contents/Resources/app/scripts/browser-mcp.cjs`,
  which needs `asar: false`. `workspace-router.cjs` probes that path.
- Artifact names: `OpenAlan-mac.dmg`, `OpenAlan-mac.dmg.sha512`,
  `OpenAlan-windows-setup.exe`, `latest.yml`.
- Prompt URLs: `https://openalan.com/agent-prompt` and
  `https://openalan.com/agent-update`. Prompts contain facts only: no step
  numbers, no `--flags`, no file paths.
- Platforms: Mac arm64 and Windows x64. No Linux.
- Redirects are 302.
- No em-dashes in website or user-facing copy that I write (Alex's rule).
  Existing copy is left alone unless the task rewrites it.
- Confirm with Alex before: pushing `v0.3.0` (a public release), pushing the
  website to `main` (live deploy), and merging `release.yml` to `main`.
- Release-candidate tags containing `-` stay drafts. They are never public,
  so they are safe for CI testing.

## Review Focus

1. **Existing users upgrading** (prefs file exists, `macSshHost` already set)
   must not see the wizard. Covered by the `shouldOnboard` test in Task 5.
2. **Mac app run from the mounted dmg or ~/Downloads.** The wizard offers to
   move it, and the Mac updater refuses to swap a bundle on a read-only
   volume, falling back to the download page. Covered by the
   `canSelfUpdate` test in Task 6.
3. **Malformed version strings** (`v0.3.0`, `0.3.0-rc.1`, empty) must
   compare safely in `isNewer`. Covered by Task 6 tests.
4. **Connector copy on a computer with no Node and no swiftc** must still
   find the helper. Covered by the `pickHelper` test in Task 1, plus the
   setup.sh change in Task 7.
5. **Download hitting a release mid-build.** Draft-first publishing in
   Task 4. Verified by checking that the rc release stays a draft in Task 10.

---

### Task 1: Mac helper falls back to a prebuilt binary

**Files:**
- Modify: `desktop/src/computer.cjs:8-18`
- Test: `desktop/test/computer-helper.test.cjs`

**Interfaces:**
- Produces: `pickHelper({ binary, source, bundled, exists, mtime, compile }) -> string`
  (throws when there's no usable helper). `ensureBinary()` keeps its name.

- [ ] **Step 1: Write the failing test.**

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pickHelper } = require('../src/computer.cjs');

const base = { binary: '/c/mac-computer', source: '/c/mac-computer.swift', bundled: '/app/mac-computer' };
const fs = (files) => ({ exists: (p) => p in files, mtime: (p) => files[p] });

test('a fresh local helper is used as is', () => {
  const f = fs({ '/c/mac-computer': 2, '/c/mac-computer.swift': 1 });
  assert.equal(pickHelper({ ...base, ...f, compile: () => assert.fail('no compile') }), '/c/mac-computer');
});
test('a stale helper is rebuilt when swiftc works', () => {
  const f = fs({ '/c/mac-computer': 1, '/c/mac-computer.swift': 2 });
  assert.equal(pickHelper({ ...base, ...f, compile: () => true }), '/c/mac-computer');
});
test('without swiftc the app bundle helper is used', () => {
  const f = fs({ '/c/mac-computer.swift': 2, '/app/mac-computer': 1 });
  assert.equal(pickHelper({ ...base, ...f, compile: () => false }), '/app/mac-computer');
});
test('without swiftc a stale local helper beats nothing', () => {
  const f = fs({ '/c/mac-computer': 1, '/c/mac-computer.swift': 2 });
  assert.equal(pickHelper({ ...base, ...f, compile: () => false }), '/c/mac-computer');
});
test('no helper and no compiler is an error', () => {
  assert.throws(() => pickHelper({ ...base, ...fs({ '/c/mac-computer.swift': 1 }), compile: () => false }), /Mac computer helper/);
});
```

- [ ] **Step 2: Run it.** `cd desktop && node --test test/computer-helper.test.cjs`.
  Expected: FAIL, because `pickHelper` is not a function.

- [ ] **Step 3: Implement.** In `computer.cjs`, replace `ensureBinary` with:

```js
// The prebuilt helper ships in the app bundle; a connector copy pushed to the
// home directory runs under that app's Electron, so execPath finds it.
const bundled = path.join(path.dirname(process.execPath), '..', 'Resources', 'app', 'scripts', 'mac-computer');

function pickHelper({ binary, source, bundled, exists, mtime, compile }) {
  const fresh = exists(binary) && (!exists(source) || mtime(binary) >= mtime(source));
  if (fresh) return binary;
  if (exists(source) && compile()) return binary;
  if (exists(bundled)) return bundled;
  if (exists(binary)) return binary;
  throw new Error('Could not build the Mac computer helper, and no prebuilt one ships with this app.');
}

function ensureBinary() {
  if (process.platform !== 'darwin') throw new Error('Mac computer use only runs on the Mac.');
  return pickHelper({
    binary, source, bundled,
    exists: (p) => fs.existsSync(p),
    mtime: (p) => fs.statSync(p).mtimeMs,
    compile: () => spawnSync('swiftc', ['-O', '-o', binary, source], { encoding: 'utf8' }).status === 0,
  });
}
```

  Export `pickHelper` alongside the existing exports.

- [ ] **Step 4: Run the test and `npm run check`.** Expected: PASS.
- [ ] **Step 5: Commit.** Message: "Fall back to the app's prebuilt Mac helper when swiftc is missing."

### Task 2: Evergreen agent prompts and the docs they point at

**Files:**
- Create: `desktop/src/agent-prompt.cjs`, `desktop/test/agent-prompt.test.cjs`, `docs/update-for-agents.md`
- Modify: `desktop/src/main.cjs` (`agent-prompt` case near line 638), `desktop/package.json` (`check` script), `docs/setup-prompt.md` (step 4), `docs/setup-for-agents.md` (install wording)

**Interfaces:**
- Produces: `buildAgentPrompt({ kind = 'setup' | 'update', hostLabel: 'mac'|'windows', version, timezone, botId?, sshHost? }) -> string`.
- Command `agent-prompt` takes `{ botId, kind }`.

- [ ] **Step 1: Write the failing test.**

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildAgentPrompt } = require('../src/agent-prompt.cjs');

const base = { hostLabel: 'mac', version: '0.3.0', timezone: 'America/Chicago' };

test('setup prompt points at the evergreen URL and states facts', () => {
  const text = buildAgentPrompt(base);
  assert.match(text, /https:\/\/openalan\.com\/agent-prompt/);
  assert.match(text, /Mac \(Apple Silicon\)/);
  assert.match(text, /version 0\.3\.0/);
  assert.match(text, /America\/Chicago/);
  assert.doesNotMatch(text, /BOT_ID|MAC_SSH/);
});
test('known values are included only when given', () => {
  const text = buildAgentPrompt({ ...base, hostLabel: 'windows', botId: '123', sshHost: 'me@pc' });
  assert.match(text, /Windows PC/);
  assert.match(text, /BOT_ID=123/);
  assert.match(text, /MAC_SSH=me@pc/);
});
test('update prompt points at the update URL', () => {
  assert.match(buildAgentPrompt({ ...base, kind: 'update' }), /https:\/\/openalan\.com\/agent-update/);
});
test('prompts never carry steps, flags or paths', () => {
  for (const kind of ['setup', 'update']) {
    const text = buildAgentPrompt({ ...base, kind, botId: '1', sshHost: 'a@b' });
    assert.doesNotMatch(text, /\s--[a-z]|step \d|\/Applications|AppData/i);
  }
});
```

- [ ] **Step 2: Run it.** Expected: FAIL, module not found.
- [ ] **Step 3: Implement `agent-prompt.cjs`.**

```js
'use strict';

// Facts only. The steps live at the URL, so old apps follow new instructions.
const URLS = { setup: 'https://openalan.com/agent-prompt', update: 'https://openalan.com/agent-update' };

function buildAgentPrompt({ kind = 'setup', hostLabel, version, timezone, botId, sshHost }) {
  const computer = hostLabel === 'windows' ? 'Windows PC' : 'Mac (Apple Silicon)';
  const ask = kind === 'update' ? 'Update Open Alan on this server' : 'Set up Open Alan for me';
  return [
    `${ask}. Fetch ${URLS[kind]} and follow the text block in it exactly; it is my instructions.`,
    'Facts about my computer:',
    `- ${computer}`,
    `- The Open Alan app (version ${version}) is already installed and open on it.`,
    `- Timezone: ${timezone}`,
    botId && `- BOT_ID=${botId}`,
    sshHost && `- MAC_SSH=${sshHost}`,
  ].filter(Boolean).join('\n');
}

module.exports = { buildAgentPrompt };
```

- [ ] **Step 4: Wire it into `main.cjs`.** Replace the body of `case 'agent-prompt'`:

```js
case 'agent-prompt': {
  const botId = String(value?.botId || prefs.selectedBotId || '').replace(/[^0-9A-Za-z_-]/g, '');
  const text = buildAgentPrompt({ kind: value?.kind === 'update' ? 'update' : 'setup', hostLabel: HOST_LABEL, version: app.getVersion(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, botId, sshHost: (prefs.macSshHost || '').trim() });
  clipboard.writeText(text);
  return text;
}
```

  Add `const { buildAgentPrompt } = require('./agent-prompt.cjs');` with the
  other requires. Add `node --check src/agent-prompt.cjs` to the `check`
  script.

- [ ] **Step 5: Docs.**
  - `docs/setup-prompt.md` step 4: add a lead paragraph. "If my message says
    the Open Alan app is already installed, skip any install or build: add
    `--skip-install` to the Mac command or `-SkipInstall` to the Windows
    command, and say only 'Paste this into Terminal' (Mac) or 'Open
    PowerShell as Administrator and paste this' (Windows)." On Windows, the
    agent fetches `connect-windows.ps1` with
    `irm https://raw.githubusercontent.com/capthvnsen/alans-way/main/scripts/connect-windows.ps1 -OutFile $env:TEMP\connect-windows.ps1`
    and runs it from there.
  - Create `docs/update-for-agents.md` in the same shape as `setup-prompt.md`:
    a `text` block that says to:
    1. `git -C ~/alans-way-agents pull --ff-only` and note the old and new
       `git rev-parse --short HEAD`;
    2. re-run `~/alans-way-agents/setup.sh --non-interactive` with
       `--bot-id`, `--mac-ssh`, `--host-os`, `--timezone`, and
       `--profile` unless default. Take each value from the message, from
       `/etc/hermes-alans-way/mac-watch.env`
       (`HERMES_WORKSPACE_MAC_SSH`), and from the plugin's
       `workspace_browser` MCP args in the profile's `config.yaml`
       (`--bot-id`, `--mac-ssh`, `--host-os`). Never ask for secrets;
    3. `setup.sh --verify` must pass;
    4. restart the gateway, with the same self-restart wording as setup;
    5. report the old and new versions plus warnings.
  - `docs/setup-for-agents.md`: where it says the connect script installs
    the app, add "(skipped with --skip-install when the app was downloaded
    from openalan.com)".
- [ ] **Step 6: Before writing step 2 of the update doc,** confirm in
  `~/alans-way-agents/setup.sh` around lines 724-740 and 905-930 which
  config keys hold bot id, mac ssh and host os. Use those exact names in the
  doc.
- [ ] **Step 7: Run `npm run check`, then commit.** Message: "Build agent prompts from facts and point them at openalan.com."

### Task 3: electron-builder packaging with the prebuilt helper

**Files:**
- Modify: `desktop/package.json` (scripts, devDependencies, `build` key), `scripts/install-mac.sh:72`, `scripts/install-windows.ps1:90`
- Create: `desktop/scripts/build-mac-helper.cjs`

- [ ] **Step 1:** `cd desktop && npm rm @electron/packager && npm i -D electron-builder && npm i electron-updater`.
- [ ] **Step 2: The `build` key in `package.json`:**

```json
"build": {
  "appId": "app.alans-way.localapp",
  "productName": "alans-way-localapp",
  "asar": false,
  "directories": { "output": "dist", "buildResources": "assets" },
  "files": ["**/*", "!test{,/**}", "!dist{,/**}", "!screenshots{,/**}"],
  "publish": [{ "provider": "github", "owner": "capthvnsen", "repo": "alans-way", "releaseType": "draft" }],
  "mac": { "target": [{ "target": "dmg", "arch": ["arm64"] }], "icon": "assets/icon.icns", "identity": "-", "category": "public.app-category.productivity", "artifactName": "OpenAlan-mac.${ext}" },
  "dmg": { "artifactName": "OpenAlan-mac.${ext}" },
  "win": { "target": [{ "target": "nsis", "arch": ["x64"] }], "icon": "assets/icon.ico" },
  "nsis": { "oneClick": true, "perMachine": false, "artifactName": "OpenAlan-windows-setup.${ext}" }
}
```

  If `identity: "-"` is rejected by the installed electron-builder version,
  set `"identity": null` and add `"afterPack": "scripts/adhoc-sign.cjs"`,
  which runs `codesign --force --deep -s - <appOutDir>/<product>.app`.

- [ ] **Step 3: Scripts.**
  - `"build:mac-helper": "node scripts/build-mac-helper.cjs"`. It runs
    `swiftc -O -target arm64-apple-macos13 -o scripts/mac-computer scripts/mac-computer.swift`
    and exits non-zero on failure.
  - `"package:mac": "npm run build:preload && npm run build:mac-helper && electron-builder --mac --publish never"`
  - `"package:win": "npm run build:preload && electron-builder --win --publish never"`
  - Delete the now-redundant `prepackage:*` hooks.
  - Add `node --check scripts/build-mac-helper.cjs` to `check`.
- [ ] **Step 4: Install scripts.** electron-builder's unpacked app lands at
  `dist/mac-arm64/alans-way-localapp.app` and `dist/win-unpacked`. Update
  `BUILT=` in `install-mac.sh` and `$Built` in `install-windows.ps1`, then
  read both scripts end to end for any other `dist` path assumptions.
- [ ] **Step 5: Build locally.** `npm run package:mac`. Expected:
  `dist/OpenAlan-mac.dmg` exists, and
  `codesign --verify --deep --strict dist/mac-arm64/alans-way-localapp.app`
  exits 0. `Contents/Resources/app/scripts/mac-computer` and
  `Contents/Resources/app/scripts/browser-mcp.cjs` exist.
  `Contents/Resources/app-update.yml` exists.
- [ ] **Step 6: Smoke test.** Launch
  `dist/mac-arm64/alans-way-localapp.app` with
  `HERMES_WORKSPACE_DATA=$(mktemp -d)`. The window shows Telegram. Quit.
- [ ] **Step 7: Commit.** Message: "Package with electron-builder: a dmg and a one-click Windows installer with a prebuilt Mac helper."

### Task 4: Release workflow

**Files:**
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: Write the workflow.**

```yaml
name: release

on:
  push:
    tags: ['v*']
  workflow_dispatch:

permissions:
  contents: read

jobs:
  draft:
    if: github.event_name == 'push'
    runs-on: ubuntu-latest
    permissions: { contents: write }
    steps:
      - run: gh release view "$TAG" -R "$GITHUB_REPOSITORY" >/dev/null 2>&1 || gh release create "$TAG" -R "$GITHUB_REPOSITORY" --draft --title "$TAG" --generate-notes
        env: { GH_TOKEN: '${{ github.token }}', TAG: '${{ github.ref_name }}' }

  build:
    needs: [draft]
    if: always() && (needs.draft.result == 'success' || github.event_name == 'workflow_dispatch')
    strategy:
      fail-fast: true
      matrix:
        include:
          - { os: macos-latest, script: 'package:mac', files: 'dist/OpenAlan-mac.dmg dist/OpenAlan-mac.dmg.sha512' }
          - { os: windows-latest, script: 'package:win', files: 'dist/OpenAlan-windows-setup.exe dist/latest.yml' }
    runs-on: ${{ matrix.os }}
    permissions: { contents: write }
    defaults: { run: { working-directory: desktop, shell: bash } }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22', cache: npm, cache-dependency-path: desktop/package-lock.json }
      - run: npm ci
      - run: npm run check
      - if: github.event_name == 'push'
        run: npm version "${GITHUB_REF_NAME#v}" --no-git-tag-version --allow-same-version
      - run: npm run ${{ matrix.script }}
      - if: runner.os == 'macOS'
        run: shasum -a 512 dist/OpenAlan-mac.dmg | cut -d' ' -f1 > dist/OpenAlan-mac.dmg.sha512
      - uses: actions/upload-artifact@v4
        with: { name: '${{ matrix.os }}', path: 'desktop/dist/OpenAlan-*' }
      - if: github.event_name == 'push'
        run: gh release upload "$GITHUB_REF_NAME" ${{ matrix.files }} --clobber -R "$GITHUB_REPOSITORY"
        env: { GH_TOKEN: '${{ github.token }}' }

  publish:
    needs: [build]
    # Release candidates (tags with '-') stay drafts: never public, safe for testing.
    if: github.event_name == 'push' && !contains(github.ref_name, '-')
    runs-on: ubuntu-latest
    permissions: { contents: write }
    steps:
      - run: gh release edit "$GITHUB_REF_NAME" -R "$GITHUB_REPOSITORY" --draft=false --latest
        env: { GH_TOKEN: '${{ github.token }}' }
```

- [ ] **Step 2: Lint.** Run `npx --yes action-validator .github/workflows/release.yml`,
  or `actionlint` if it's installed. Expected: no errors.
- [ ] **Step 3: Commit.** Message: "Build installers on a tag into a draft release and publish once both exist."

### Task 5: First-run wizard

**Files:**
- Create: `desktop/src/onboarding.cjs`, `desktop/test/onboarding.test.cjs`
- Modify: `desktop/src/main.cjs` (`getState`, `settings` case, new commands `onboarding-done`, `move-to-applications`), `desktop/src/index.html` (`#onboarding` inside `#browser-slot`), `desktop/src/renderer.js` (`renderOnboarding`, a Settings button), `desktop/src/style.css`

**Interfaces:**
- Produces: `shouldOnboard(prefs) -> boolean`.
- State fields: `onboarding: boolean`, `inApplications: boolean|null`, `version`.
- Commands: `onboarding-done`, `onboarding-open`, `move-to-applications`, `agent-prompt` (returns text).

Placement: the existing modal hides Telegram (`obscured: modalOpen`). So the
wizard renders inside `#browser-slot` in place of `#home`. Telegram stays
visible for the QR code and for pasting the prompt to the bot.

- [ ] **Step 1: Write the failing test.**

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { shouldOnboard } = require('../src/onboarding.cjs');

test('fresh install onboards', () => assert.equal(shouldOnboard({}), true));
test('finished or skipped does not', () => assert.equal(shouldOnboard({ onboarded: true }), false));
test('an existing setup from before the wizard does not', () => assert.equal(shouldOnboard({ macSshHost: 'me@mac' }), false));
test('reopened from settings onboards again', () => assert.equal(shouldOnboard({ onboarded: false, macSshHost: 'me@mac' }), true));
```

- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement.**

```js
'use strict';
// Upgraders who already wired a computer never see the wizard unless they reopen it.
function shouldOnboard(prefs) {
  if (prefs.onboarded === false) return true;
  return !prefs.onboarded && !prefs.macSshHost;
}
module.exports = { shouldOnboard };
```

- [ ] **Step 4: Main process.**
  - `getState` adds `onboarding: shouldOnboard(prefs)` and
    `inApplications: process.platform === 'darwin' ? app.isInApplicationsFolder() : null`.
  - Commands:
    - `case 'onboarding-done': prefs.onboarded = true; break;`
    - `case 'onboarding-open': prefs.onboarded = false; activeTabId = 'home'; applyLayout(); break;`
      (check `applyLayout` exists; otherwise use whatever `close-tab`
      calls).
    - `case 'move-to-applications': return app.moveToApplicationsFolder();`
  - Make sure each command path saves and broadcasts like neighbouring
    cases.
- [ ] **Step 5: Renderer.** Add `<div id="onboarding" class="onboarding hidden"></div>`
  inside `#browser-slot` after `#home`. In `render()`:
  - when `state.onboarding` and no tab is active, hide `#home` and show
    `#onboarding`;
  - call `renderOnboarding()`, which keeps `let onboardingStep = 1` and
    rebuilds only when the step or the relevant state changes (signature
    string, the same pattern as `renderBots`).

  The content of each step:
  1. Heading "Welcome to Open Alan".
     - Telegram check line, ✓ when `state.telegramStatus === 'connected'`,
       otherwise "Scan the QR code on the left with your phone: Telegram →
       Settings → Devices → Link Desktop Device."
     - If `state.inApplications === false`, a line "Move Open Alan to your
       Applications folder so your agent can find it" with a button that
       calls `command('move-to-applications')`.
     - Buttons: Next, Skip setup.
  2. "Give your agent this prompt."
     - A `<textarea readonly>` filled from
       `await command('agent-prompt', { botId: state.selectedBotId })`.
     - A Copy button (primary).
     - Note: "Paste it into the chat with your Hermes bot on the left. It
       works for every version of Open Alan."
     - Link line "No Hermes agent yet?" that calls
       `command('open-url', ...)` for
       `https://github.com/NousResearch/hermes-agent`. Use the existing
       open-in-tab path; check which command opens a URL in a tab.
     - Buttons: Back, Next.
  3. "Finish the connection."
     - Text: "Your agent will send you one command. Paste it into Terminal
       (Mac) or PowerShell as Administrator (Windows), then send back what
       it prints."
     - The two SSH fields (same labels and IDs prefixed `ob-`), saved with
       `command('settings', { macSshHost, vpsBrowser: { ...state.vpsBrowser, sshHost } })`.
     - Test connection runs `command('test-agent-path')` and shows ✓/✗ with
       `result.detail`.
     - Buttons: Back, Done. Done calls `command('onboarding-done')`.
  - "Skip setup" also calls `onboarding-done`.
- [ ] **Step 6: Settings.**
  - In the Agent setup section, add a "Run setup wizard" button that calls
    `command('onboarding-open')` and `closeModal()`.
  - Add a "Copy agent update prompt" button that calls
    `command('agent-prompt', { botId: state.selectedBotId, kind: 'update' })`
    and toasts.
  - The existing "Copy setup prompt" now uses the new module through the
    same command.
- [ ] **Step 7: CSS.** `.onboarding` is absolutely positioned at `inset:0`
  with the same backdrop as `.home`. Contents: a centred card, max-width
  520px, using the existing `.primary-button`, `.secondary-button`, `.field`
  and `.settings-note` classes. The textarea uses `.field input` colours
  with a monospace font.
- [ ] **Step 8: Verify in the real app.** `npm start` with
  `HERMES_WORKSPACE_DATA=$(mktemp -d)`, then screenshot each step. Then
  restart with a data dir whose `preferences.json` has `macSshHost` set and
  confirm the wizard is absent.
- [ ] **Step 9: Run `npm run check`, then commit.** Message: "Add a first-run wizard that hands the user one evergreen prompt for their agent."

### Task 6: App updates

**Files:**
- Create: `desktop/src/mac-update.cjs`, `desktop/test/mac-update.test.cjs`
- Modify: `desktop/src/main.cjs` (start the update check, `update-now` command, state `update`, post-update note), `desktop/src/renderer.js` (header/footer notice), `desktop/package.json` (`check`)

**Interfaces:**
- Produces: `isNewer(latest, current) -> boolean`,
  `canSelfUpdate(bundlePath) -> boolean`,
  `checkLatest() -> Promise<{ version, tag } | null>`,
  `installMacUpdate({ tag, bundlePath, onProgress }) -> Promise<void>`
  (throws with a human message).
- State field: `update: { available: version|null, ready: bool, error: string|'' , justUpdatedFrom: version|'' }`.

- [ ] **Step 1: Write the failing tests.**

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isNewer, canSelfUpdate } = require('../src/mac-update.cjs');

test('version compare', () => {
  assert.equal(isNewer('v0.3.1', '0.3.0'), true);
  assert.equal(isNewer('0.3.0', '0.3.0'), false);
  assert.equal(isNewer('0.10.0', '0.9.9'), true);
  assert.equal(isNewer('0.2.9', '0.3.0'), false);
  assert.equal(isNewer('0.3.1-rc.1', '0.3.0'), false);
  assert.equal(isNewer('', '0.3.0'), false);
  assert.equal(isNewer('garbage', '0.3.0'), false);
});
test('only an app bundle outside a mounted image can swap itself', () => {
  assert.equal(canSelfUpdate('/Applications/alans-way-localapp.app'), true);
  assert.equal(canSelfUpdate('/Volumes/alans-way-localapp/alans-way-localapp.app'), false);
  assert.equal(canSelfUpdate('/private/var/folders/x/AppTranslocation/y/d/alans-way-localapp.app'), false);
  assert.equal(canSelfUpdate(''), false);
});
```

- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement `mac-update.cjs`.**

```js
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const REPO = 'capthvnsen/alans-way';
const BUNDLE_ID = 'app.alans-way.localapp';

// Stable releases only: a pre-release tag (with '-') never offers itself.
function parse(v) { const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v || '').trim()); return m ? m.slice(1).map(Number) : null; }
function isNewer(latest, current) {
  const a = parse(latest), b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
function canSelfUpdate(bundlePath) {
  return /\.app$/.test(bundlePath || '') && !bundlePath.startsWith('/Volumes/') && !bundlePath.includes('/AppTranslocation/');
}

async function checkLatest() {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { accept: 'application/vnd.github+json' } });
  if (!res.ok) return null;
  const { tag_name: tag } = await res.json();
  return tag ? { tag, version: tag.replace(/^v/, '') } : null;
}

async function download(url, file) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status}).`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

// Downloaded by the app itself, the image carries no quarantine flag, so the
// new version opens without another Gatekeeper prompt.
async function installMacUpdate({ tag, bundlePath }) {
  if (!canSelfUpdate(bundlePath)) throw new Error('Open Alan is not in a folder it can update. Move it to Applications first.');
  const base = `https://github.com/${REPO}/releases/download/${tag}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openalan-update-'));
  const dmg = path.join(dir, 'OpenAlan-mac.dmg'), mount = path.join(dir, 'mnt');
  try {
    await download(`${base}/OpenAlan-mac.dmg`, dmg);
    const want = (await (await fetch(`${base}/OpenAlan-mac.dmg.sha512`)).text()).trim().split(/\s+/)[0];
    const got = crypto.createHash('sha512').update(fs.readFileSync(dmg)).digest('hex');
    if (!want || want !== got) throw new Error('The downloaded update did not match its checksum.');
    fs.mkdirSync(mount);
    execFileSync('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, dmg]);
    try {
      const app = fs.readdirSync(mount).find((name) => name.endsWith('.app'));
      if (!app) throw new Error('The update image has no app in it.');
      const id = execFileSync('defaults', ['read', path.join(mount, app, 'Contents', 'Info'), 'CFBundleIdentifier'], { encoding: 'utf8' }).trim();
      if (id !== BUNDLE_ID) throw new Error('The update image holds a different app.');
      const staged = `${bundlePath}.update`, old = `${bundlePath}.old`;
      fs.rmSync(staged, { recursive: true, force: true }); fs.rmSync(old, { recursive: true, force: true });
      execFileSync('ditto', [path.join(mount, app), staged]);
      fs.renameSync(bundlePath, old);
      fs.renameSync(staged, bundlePath);
      fs.rmSync(old, { recursive: true, force: true });
    } finally {
      try { execFileSync('hdiutil', ['detach', '-quiet', mount]); } catch {}
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { isNewer, canSelfUpdate, checkLatest, installMacUpdate };
```

- [ ] **Step 4: Main wiring** (after `createWindow()` in `whenReady`).
  - `prefs.lastVersion !== app.getVersion()`: when it's set and different,
    set `update.justUpdatedFrom = prefs.lastVersion`. Always save
    `prefs.lastVersion = app.getVersion()`.
  - **win32 + `app.isPackaged`:**
    `const { autoUpdater } = require('electron-updater'); autoUpdater.autoInstallOnAppQuit = true;`
    - on `update-downloaded`, set `update.ready = true` and `broadcast()`;
    - call `autoUpdater.checkForUpdates().catch(() => {})` now and every 6h;
    - command `update-now` calls `autoUpdater.quitAndInstall()`.
  - **darwin + `app.isPackaged`:** `checkLatest()` now and every 6h. When
    `isNewer(latest.version, app.getVersion())`, set
    `update.available = latest.version` and `update.tag = latest.tag`, then
    broadcast.
    - Command `update-now`: set status, then call
      `installMacUpdate({ tag, bundlePath: path.resolve(process.execPath, '../../..') })`.
    - On success: `app.relaunch(); app.exit(0)`.
    - On error: set `update.error = e.message`, broadcast, and rethrow so
      the renderer toasts it.
  - Command `open-download`:
    `shell.openExternal('https://openalan.com/download/' + (HOST_LABEL === 'windows' ? 'windows' : 'mac'))`.
  - Command `dismiss-updated`: clear `justUpdatedFrom`.
  - Wrap every network call in try/catch. An offline launch is silent.
- [ ] **Step 5: Renderer.** Reuse the footer's `#workspace-status` row. Add
  a `#update-note` button in `.workspace-footer`:
  - "Update to vX" (Mac `available`): calls `update-now`, and on error
    switches to "Open download page" (`open-download`).
  - "Restart to update" (Windows `ready`): calls `update-now`.
  - When `justUpdatedFrom` is set, show a one-time toast: "Updated to vX.
    Your agent may need updating too: Settings → Agent setup → Copy agent
    update prompt." Then call `dismiss-updated`.
- [ ] **Step 6: Run `npm run check` (add the new module), then commit.**
  Message: "Update the app in place: electron-updater on Windows, a verified dmg swap on Mac."

### Task 7: Plugin setup copies a complete connector without npm

**Repo:** `~/alans-way-agents`, new branch `capthvnsen/connector-no-npm`.

**Files:**
- Modify: `setup.sh:487-527` (the two Mac branches)

- [ ] **Step 1:** Run `git pull`, read `tests/` for any test of the connector
  copy (`grep -rn "connector" tests`), and run the existing test command
  from its README or CI to get a baseline.
- [ ] **Step 2:** Replace both Mac branches (the `elif ... npm ci` branch
  and the `else` partial copy) with one branch. It copies
  `browser-mcp.cjs`, `mac-computer.swift`, all `src/*.cjs`, `package.json`
  and `package-lock.json`, then *tries* `swiftc`. No `npm ci`: the router
  runs the connector with the app's Electron and
  `NODE_PATH=<app>/Contents/Resources/app/node_modules`
  (`workspace-router.cjs:188-199`), and the copied `computer.cjs` (Task 1)
  falls back to the app's prebuilt helper.

```sh
    elif ssh -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=yes "$MAC_SSH" \
        'mkdir -p "$HOME/Library/Application Support/Hermes Workspace/connector/scripts" "$HOME/Library/Application Support/Hermes Workspace/connector/src"' \
      && scp -q -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=yes \
        "$DESKTOP_DIR/desktop/scripts/browser-mcp.cjs" \
        "$DESKTOP_DIR/desktop/scripts/mac-computer.swift" \
        "$MAC_SSH:Library/Application Support/Hermes Workspace/connector/scripts/" \
      && scp -q -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=yes \
        "$DESKTOP_DIR"/desktop/src/*.cjs \
        "$MAC_SSH:Library/Application Support/Hermes Workspace/connector/src/"; then
      # The router runs this copy with the app's own Electron and node_modules,
      # so it needs neither Node nor npm here; swiftc is optional because the
      # app bundle ships a prebuilt helper.
      ssh -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=yes "$MAC_SSH" \
        'swiftc -O -o "$HOME/Library/Application Support/Hermes Workspace/connector/scripts/mac-computer" "$HOME/Library/Application Support/Hermes Workspace/connector/scripts/mac-computer.swift"' >/dev/null 2>&1 \
        || true
      ok "Mac connector updated for browser and computer use"
    else
      warn "could not copy the Mac connector — the installed app's scripts stay in use"
    fi
```

- [ ] **Step 3:** Run `sh -n setup.sh` and the repo's tests. Expected: pass.
- [ ] **Step 4:** Check the ordering problem: a pinned `DESKTOP_REF` older
  than Task 1 would push a `computer.cjs` without the fallback. Note in the
  commit that `DESKTOP_REF` must be repinned to the alans-way commit that
  contains Task 1 once it merges. Don't repin to an unmerged commit.
- [ ] **Step 5:** Commit. Message: "Copy the whole Mac connector and let the app's runtime supply its modules."

### Task 8: README

**Files:** `README.md` (install section, around line 48)

- [ ] **Step 1:** Lead the install section with "Download for Mac
  (https://openalan.com/download/mac) / Windows
  (https://openalan.com/download/windows), open it, and follow the setup
  wizard." Keep the curl and irm commands under "Build from source".
  Mention the first-launch "Open Anyway" and "Run anyway" steps.
- [ ] **Step 2:** Commit. Message: "Lead the README with the downloads."

### Task 9: openalan.com

**Repo:** `~/Projects/openalan`, branch `capthvnsen/cleanup`, after `git pull`.

**Files:** `index.html`, `_redirects`, `llms.txt`, new `favicon.png`, `apple-touch-icon.png`

- [ ] **Step 1: Icons.**
  `sips -z 32 32 <alans-way>/desktop/assets/icon.png --out favicon.png` and
  `sips -z 180 180 ... --out apple-touch-icon.png`. Replace the inline SVG
  `<link rel="icon">` with
  `<link rel="icon" type="image/png" href="/favicon.png"><link rel="apple-touch-icon" href="/apple-touch-icon.png">`.
- [ ] **Step 2: `_redirects`.** Append:

```
/download/mac      https://github.com/capthvnsen/alans-way/releases/latest/download/OpenAlan-mac.dmg 302
/download/windows  https://github.com/capthvnsen/alans-way/releases/latest/download/OpenAlan-windows-setup.exe 302
/agent-update      https://raw.githubusercontent.com/capthvnsen/alans-way/main/docs/update-for-agents.md 302
/agent-update.md   https://raw.githubusercontent.com/capthvnsen/alans-way/main/docs/update-for-agents.md 302
```

- [ ] **Step 3: Read `index.html` fully,** then do the design pass with the
  frontend-design skill, keeping Cormorant Garamond, IBM Plex Mono and the
  classical identity:
  - **Hero:** keep "OPEN ALAN", tighten the subcopy, and make two primary
    buttons the main call to action. "Download for Mac" (Apple Silicon)
    links to `/download/mac`. "Download for Windows" links to
    `/download/windows`. Each has the `download` attribute, and there is no
    clipboard JS. A few lines of JS add `.primary` to the visitor's OS
    button (`navigator.userAgentData?.platform || navigator.platform`).
  - Under the buttons: the first-launch notes for Mac and Windows from the
    spec, plus a "Prefer to build from source?" `<details>` holding the
    existing curl and irm commands.
  - Remove the Linux button.
  - The GitHub link reads "Source · GPL-3.0".
  - Remove "No binaries yet".
  - Merge the "Tell your agent", "Or your Hermes bot", "Mac app only" and
    "Windows app only" blocks into one "How setup works" section with three
    steps: download and open; copy the prompt from the wizard to your
    Hermes bot; paste the one command it sends back.
  - Keep sections I-IV, normalise spacing to one scale, and make sure there
    is no horizontal scroll at 375px.
  - No em-dashes in new copy.
- [ ] **Step 4: `llms.txt`:** add the two download URLs and `/agent-update`.
- [ ] **Step 5: Verify.** `python3 -m http.server` in the repo. Screenshot at
  1440px and 375px in a browser, confirm `scrollWidth <= innerWidth` at
  375px, and confirm the download links' `href`s.
- [ ] **Step 6: Commit on the branch.** Pushing to `main` waits for Alex.

### Task 10: End-to-end verification and review

- [ ] **Step 1:** Push the alans-way branch, then push tag `v0.3.0-rc.1` on
  it. It stays a draft. Watch the workflow with
  `gh run watch`. Expected: both builds are green and the draft release has
  the 4 assets. `gh release view v0.3.0-rc.1 --json isDraft` shows true.
- [ ] **Step 2:** Download the CI dmg with
  `gh release download v0.3.0-rc.1 -p 'OpenAlan-mac.dmg*'` and add a
  quarantine flag:
  `xattr -w com.apple.quarantine "0081;$(printf %x $(date +%s));Safari;" OpenAlan-mac.dmg`.
  - Check `shasum -a 512` against the `.sha512`.
  - Mount it, then run `codesign --verify --deep --strict` on the app
    (expected: valid) and `spctl -a -vv` (expected: rejected, which is the
    "Open Anyway" path, not "damaged").
  - Copy the app to a temp dir, then run
    `ELECTRON_RUN_AS_NODE=1 <app>/Contents/MacOS/alans-way-localapp -e "require('<app>/Contents/Resources/app/src/computer.cjs')"`
    with `PATH=/usr/bin:/bin`, and confirm the helper resolves to the
    bundled binary.
- [ ] **Step 3:** The Windows exe can't be run here unless a Windows machine
  exists. Report that it's unverified.
- [ ] **Step 4:** Ask whether a full setup against Alex's real VM should
  wait for Alex. It touches his live agent, so report it as not run.
- [ ] **Step 5:** Run superpowers:requesting-code-review on the alans-way
  branch, fix the findings, and re-run `npm run check`.
- [ ] **Step 6:** Report to Alex with evidence. Ask before:
  - merging `release.yml` and the branch to `main`;
  - pushing `v0.3.0`;
  - pushing the website;
  - repinning `DESKTOP_REF`.

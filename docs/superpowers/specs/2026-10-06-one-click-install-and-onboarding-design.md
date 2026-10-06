# One-click install, first-run wizard, openalan.com cleanup

Date: 2026-10-06. Status: approved design, awaiting spec review.

## Goal

A person with a Hermes agent on a VPS or VM goes to openalan.com, clicks one
download button, opens the app, and a short wizard gets them connected: sign in
to Telegram, copy one prompt to their agent, paste the one command the agent
sends back, see a green check. The prompt in the app never needs to change when
the setup process changes.

Decided with Alex:

- Unsigned builds for now (no Apple Developer ID, no Windows certificate).
- Mac (Apple Silicon) and Windows x64 only. No Linux download.
- "Virtual agent" means a Hermes agent on a Linux VPS or macOS VM, the same
  target `docs/setup-prompt.md` already serves.

Out of scope: code signing, Linux desktop control, Intel Macs, auto-update,
renaming the app bundle.

## 1. Release pipeline (this repo)

**Build tool.** Replace `@electron/packager` with `electron-builder` in
`desktop/package.json`. Config lives in the `build` key of `package.json`.

- `productName` stays `alans-way-localapp`. Renaming would break
  `/Applications/alans-way-localapp.app`, the Windows install path, and the
  agent's MAC_OK checks.
- `asar: false`, same as today's `--no-asar`.
- Same ignore list as today: `test/`, `dist/`, `screenshots/`.
- Mac: `dmg` target, `arm64`, with the usual Applications-folder shortcut.
  Ad-hoc sign it, because an unsigned arm64 binary shows "is damaged" instead
  of the "Open Anyway" path. Use `mac.identity: "-"` if electron-builder
  supports it; otherwise run `codesign --force --deep -s -` in an `afterPack`
  hook. Verify on a quarantined download before calling this done.
- Windows: `nsis` with `oneClick: true` and `perMachine: false`. That installs
  to `%LOCALAPPDATA%\Programs\alans-way-localapp\alans-way-localapp.exe`,
  which is the path `install-windows.ps1` and the agent checks already use.
- Artifact names are fixed with no version in them: `OpenAlan-mac.dmg` and
  `OpenAlan-windows-setup.exe`.
- Version comes from `package.json`. CI sets it from the tag before building.
  Remove the hard-coded `0.2.1` from the scripts.
- `package:mac` and `package:win` keep their names, so `install-mac.sh` and
  `install-windows.ps1` (the build-from-source path) still work. Check what
  those scripts expect in `dist/` and keep that output path working, or
  update the scripts.

**Workflow.** Add `.github/workflows/release.yml`:

- Triggers:
  - `push` of tags `v*`: build both installers and attach them to that GitHub
    Release, which becomes "latest".
  - `workflow_dispatch`: build both and upload them as workflow artifacts
    only. This is for testing without publishing.
- Jobs: `macos-latest` builds the dmg and `windows-latest` builds the exe.
  Each runs `npm ci`, then `npm run check`, then the build.
- Permissions: `contents: write` on the release job only.

Stable download URLs:
`https://github.com/capthvnsen/alans-way/releases/latest/download/OpenAlan-mac.dmg`
and `…/OpenAlan-windows-setup.exe`.

## 2. First-run wizard (desktop app)

**When it shows.** On launch, when `prefs.onboarded` is not true. "Skip" and
"Done" both set `prefs.onboarded = true`. Settings → Agent setup gets a
"Run setup wizard" button that reopens it.

**Form.** A full-window overlay in the renderer, built with the same
`element()` helpers and CSS as the Settings panel. No new framework. The
Telegram pane stays visible on step 1 so the QR code can be scanned.

**Steps:**

1. **Sign in to Telegram.** "Scan the QR code with your phone: Telegram →
   Settings → Devices → Link Desktop Device." It ticks itself off when
   `state.telegramStatus === 'connected'`. Next is enabled either way.
   - On a Mac, if `app.isInApplicationsFolder()` is false, show a line with a
     "Move to Applications" button that calls `app.moveToApplicationsFolder()`.
     The agent's checks look for the app in /Applications.
2. **Give your agent this prompt.**
   - Read-only text box with the prompt, plus a Copy button.
   - Below it: "Paste it into the chat with your Hermes bot. It's in the
     Telegram pane on the left."
   - Another line: "No Hermes agent yet?" linking to the Hermes Agent repo.
3. **Finish the connection.** "Your agent will send you one command. Paste
   it into Terminal (Mac) / PowerShell as Administrator (Windows) and send
   back what it prints."
   - Then a "Test connection" button that runs the existing `test-agent-path`
     command and shows its ✓ or ✗ text.
   - Test connection needs both SSH addresses saved. So step 3 includes the
     two address fields, using the same `settings` command as Settings.
   - A note says the agent will tell you the values to enter.
   - The "Done" button closes the wizard.

**The evergreen prompt.** Move prompt building out of `main.cjs` into a small
pure module, `desktop/src/agent-prompt.cjs`, which exports
`buildAgentPrompt({ platform, timezone, version, botId, sshHost })`.
`main.cjs`'s `agent-prompt` command calls it, so Settings and the wizard
produce the same text.

Rule: the prompt contains **one instruction and only facts**. Example output:

```
Set up Open Alan for me. Fetch https://openalan.com/agent-prompt and follow the
text block in it exactly; it is my instructions.
Facts about my computer:
- Mac (Apple Silicon)
- The Open Alan app (version 0.3.0) is already installed and open on it.
- Timezone: America/Chicago
- BOT_ID=123456  (only when known)
- MAC_SSH=alex@mymac  (only when known)
```

It never contains step numbers, script flags or file paths. Those live in
`docs/setup-prompt.md`, which the domain redirect serves from `main`. So any
change to the setup process reaches every installed app, old ones included.

**Doc change.** Update `docs/setup-prompt.md` step 4: when the user says the
app is already installed, skip the "build the app" parts and add
`--skip-install` (Mac) or `-SkipInstall` (Windows) to the connect command.
Also tell the agent to ask Windows users to open PowerShell as Administrator.
Same edit in `docs/setup-for-agents.md` where it describes installing.

**Test.** One `node --test` file, `desktop/test/agent-prompt.test.cjs`:

- The prompt contains `https://openalan.com/agent-prompt`.
- It states the OS and version.
- It includes BOT_ID and MAC_SSH only when given.
- It contains no `--` flags and no "step N".

Add the new module to `npm run check`.

## 3. openalan.com (`~/Projects/openalan`, capthvnsen/openalan.com)

**Favicon.** Generate `favicon.png` (32px) and `apple-touch-icon.png` (180px)
from `desktop/assets/icon.png`, the Hermes bust. Replace the inline column
SVG favicon.

**Redirects.** Add to `_redirects`:

```
/download/mac      https://github.com/capthvnsen/alans-way/releases/latest/download/OpenAlan-mac.dmg 302
/download/windows  https://github.com/capthvnsen/alans-way/releases/latest/download/OpenAlan-windows-setup.exe 302
```

`/agent-prompt` stays as is, pointing at `docs/setup-prompt.md` on `main`.
Every installed app now depends on that URL, so it must never break.

**Download section.**

- Two primary buttons: **Download for Mac** (Apple Silicon) and **Download
  for Windows**. They are real links to `/download/mac` and
  `/download/windows`, with no clipboard handler.
- A few lines of JS mark the visitor's OS button as primary.
- Remove the Linux button.
- Under the buttons, one short first-launch note:
  - Mac: "First open: System Settings → Privacy & Security → Open Anyway."
  - Windows: "If SmartScreen appears: More info → Run anyway."
- A small "Prefer to build from source?" link shows the existing install
  commands.

**Fixes.** The GitHub button's license reads GPL-3.0. Remove "No binaries yet
— the app builds itself on your machine". Update setup copy that tells people
to run the install script so it matches download → wizard → prompt.

**Design pass.** Keep the existing identity (Cormorant Garamond and IBM Plex
Mono, the classical theme) and refine it:

- consistent spacing scale and type sizes;
- a tighter hero with the download as the main call to action;
- trim duplicated setup blocks ("Tell your agent", "Or your Hermes bot",
  "Mac app only", "Windows app only") into one "How setup works" section of
  three steps that matches the wizard;
- no horizontal scroll at 375px wide.

`llms.txt` gets the new download URLs.

**Also in this repo (alans-way).** Update `README.md` install section to lead
with the download links. Keep the curl/irm build-from-source commands as the
alternative.

## Rollout order and gates

1. Release pipeline. Verify with `workflow_dispatch` artifacts: install the
   dmg from a quarantined download on a Mac, and the exe if a Windows machine
   or VM is available. Otherwise say it's unverified.
2. Wizard and prompt module, released in the same version.
3. **Ask Alex**, then push tag `v0.3.0` (the first public release with
   installers).
4. Website. Check it locally in a browser at desktop and 375px widths.
   **Ask Alex**, then push to `main` (deploys live). Then `curl -I` both
   `/download/*` URLs to confirm the 302 lands on the files.

Adding `release.yml` is a CI change, so confirm with Alex before merging it.

## Risks

- **macOS unsigned UX.** "Open Anyway" in System Settings is a real hurdle
  for non-technical users. The website note is the only mitigation until
  signing.
- **Ad-hoc signing.** If ad-hoc signing via electron-builder misbehaves, use
  the `afterPack` fallback above.
- **App outside /Applications.** If the Mac app runs from somewhere else (for
  example straight from the dmg), the agent's MAC_OK check fails. The
  wizard's Move to Applications line covers this.

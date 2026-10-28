# Desktop QA — Codex

2026-10-28; macOS arm64, Node 24.4.1, Electron 44.5.1. All changes were made in
the dispatched `qa-desktop-app` worktree. No releases, deployments, merges,
credential changes, or public listeners were used.

## Confirmed findings

1. **Chat tool updates stay invisible until reply text changes — fixed, [PR #245](https://github.com/capthvnsen/alans-way/pull/245).**
   Repro: start a turn displaying `Working`, then emit `tool.start` and
   `tool.complete` without another text delta. The tool is missing or remains
   running because the render signature ignores tools. The signature now compares
   the bounded display projection. A regression test failed before and passes
   after the fix.

2. **Long-session chat history freezes at its transcript cap — fixed, PR #245.**
   Repro: fill the bounded transcript, then append another completed message so
   the oldest row is evicted and the row count stays constant. The pane keeps
   showing the old rows and omits the dropped-history notice. The same signature
   fix covers this path; a constant-count replacement regression failed before
   and passes after the fix.

3. **Unit results depend on unrelated home-directory plugin clones — fixed, [PR #248](https://github.com/capthvnsen/alans-way/pull/248).**
   Repro: have an older `~/alans-way-agents` clone, then run `cd desktop && npm test`
   without `ALANS_WAY_AGENTS`. The optional parity test silently loads that clone
   and fails while a clean machine skips it. The test now requires an explicit
   integration target. An explicitly invalid or incompatible target still fails.

4. **Settings recovery assertion races an unrelated connection status — fixed, PR #248.**
   Repro: run `npm run test:settings-pending-recovery` while the fixture viewer
   changes from “connecting” to “reconnecting” during the late-rejection check.
   The old assertion compared the entire dialog and failed despite intact saved
   addresses and drafts. It now compares the initiating address-save status.

5. **Settings persistence fixture passes despite API startup crashing — fixed, PR #248.**
   Repro: run `npm run test:settings-persistence` on macOS. Its computer-module
   stub omitted `createDesktopLease`, producing an unhandled startup rejection
   while the suite reported success. The stub now supplies the inert lease
   already used by another fixture, and the suite checks that main reaches its
   guarded API listener.

6. **Headless plugin fixtures wait on the macOS keychain — fixed, PR #248.**
   Repro: run both `plugin-*-headless` suites with fresh profiles using cached
   Playwright Chromium 1248. Initial `Page.navigate` times out after 15 seconds
   and the host returns HTTP 502. Chromium 1234 passes; adding
   `--use-mock-keychain` to 1248 makes both suites pass. Both fixtures now use
   that macOS-only flag, matching `vps-host-chrome.test.cjs`.

7. **The CI-pinned plugin and desktop commit-pattern lists differ — open.**
   Repro: select an archive of plugin commit
   `b9dfb89a1acb564b0750c1c800210ca60fbe3bf5` via `ALANS_WAY_AGENTS` and run
   `node --test test/commit-patterns.test.cjs` from `desktop`. The exact parity
   assertion fails: that plugin lacks the desktop's tax-schedule and three
   navigation exceptions. The local home-directory clone also differs. This is
   a confirmed contract mismatch, not evidence of an approval bypass. Updating
   the paired plugin revision requires separate cross-repository review; the
   explicit integration check continues to expose it.

## Verification

- Initial full `npm test`: 1,655 tests; 1,618 passed, 36 skipped, one failure
  caused by implicit home-directory plugin discovery.
- Full `npm test` after test isolation: 1,655 tests; 1,618 passed, 37 skipped,
  zero failures. Platform-only and optional checks remain explicit skips.
- Chat regression suite on PR #245: all 68 tests passed; both new cases were
  observed failing before the change.
- Electron fixture lifecycle check passed, including teardown of a page that
  refuses unload while a debugger is attached.
- Real Chromium host suite: 27 passed, zero skips, including request barriers,
  popup readers, bounded tab reaping, screenshots, and CAPTCHA handback.
- Core Electron suites passed: Telegram opening, cloud onboarding messaging
  against fake pages, desktop integration, trusted agent input, permissions,
  new-tab page, PDF viewer, tab restoration, needs-human, recorder, automatic
  takeover, CAPTCHA handback, updater, extensions, and onboarding layout.
- Workspace suites passed on the initial sweep except the reproduced settings
  text race: browser continuation, real Chromium crash recovery, connection
  drafts/journeys, conversation/session-wire compatibility, first action,
  asynchronous settings/navigation/persistence, shortcut query/round2, and state
  ordering. Final fixture reruns passed: both plugin suites, all 37 settings
  recovery checks, and settings persistence with zero failures and no startup
  rejection.

Live installed-app suites, real accounts, vendor Web Store installation, native
Hermes execution, Windows hardware, and a multi-hour memory soak were not run.
The history-cap regression and existing bounded settings-churn/lifecycle checks
cover specific long-session paths; they do not establish flat process memory
over hours. Real update installation was not performed.

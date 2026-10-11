# Check setup

## Goal

One button in the app that tells a user whether their Alan's Workspace setup works and, when it doesn't, lists each
problem with a one-line fix. It covers both machines and the versions between them, which no existing check
does. It ships in the app so it reaches users with a normal release, without a plugin catalog review.

## What the user sees

A **Check setup** button in Settings → Agent setup. The wizard's last step uses it in place of
**Test connection** (it saves the two SSH addresses first, as Test connection does now). The button shows
"Checking…" for up to two minutes, then a list grouped as **This computer**, **Connection** and **Server**.
Each row is ✓ (ok), ! (works, but should be fixed) or ✗ (broken), a short title, and for ! and ✗ one line
saying what to do, plus a button when the app can do it.

## Checks

| # | Check | How | Fix shown |
|---|---|---|---|
| 1 | Signed in to Telegram | `state.telegramStatus` | Scan the QR code |
| 2 | App is in Applications (Mac) | `app.isInApplicationsFolder()` | **Move to Applications** (existing) |
| 3 | Accessibility granted (Mac) | existing `mac-permissions` | **Open settings** (existing `open-mac-privacy`) |
| 4 | Screen Recording granted (Mac) | existing `mac-permissions` | **Open settings** |
| 5 | Connector copy is not older than the app | version in `<userData>/connector/package.json` | **Remove old copy** |
| 6 | This computer reaches the server | `sshRun(host, 'echo …')` | Check the address and key |
| 7 | The server reaches this computer | existing `testAgentPath()` (keeps its Tailscale SSH message) | Its existing detail text |
| 8 | Server app tools match the app | `--doctor` `version` vs `app.getVersion()` | **Update server** (existing VM update) |
| 9 | Server browser host is running, same version | `--doctor` `hostVersion` | **Update server** |
| 10 | Plugins are on the latest published version | `--doctor` plugin rows (see below) | **Update server** |
| 11 | Computer use goes through the Alan's Way Plugin | `--doctor` `computerBackend` per profile | Update Hermes to a build with the computer-use provider API, then re-run setup |
| 12 | Server setup audit passes | `--doctor` `verify`, one run per server (setup.sh audits every profile itself): each `FAIL` line is ✗, each `warn` line is ! | "Ask your bot to run `setup.sh --verify` and fix what it reports" |

Checks 8 to 12 run only if check 6 passes. If check 6 fails, the Server group shows one ✗ row:
"Couldn't reach the server, so its checks were skipped."

**Latest published plugin version (check 10).** For each profile that has `alans-way` or `alans-way-computer`:

- `class: catalog` (from `hermes plugins check-updates --json`): behind when `update_available` is true. The
  catalog's pin is the published version, so a newer GitHub tag that the catalog hasn't picked up yet is not a
  problem.
- Any other class (a clone install, `drift`, `manual`): behind when the newest `vX.Y.Z` tag of
  `alans-way-agents` is newer than the plugin's `plugin.yaml` version. When the tag can't be read, show !
  "Couldn't check for plugin updates".

## Components

- **`desktop/scripts/vm-update.sh --doctor`** (new mode, read-only). It reuses the script's existing helpers
  (`find_checkout`, `status_body`, `list_profiles`, `hermes_bin`, `plugin_version`) and prints one JSON line:

  ```json
  {"ok":true,"version":"0.4.0","hostVersion":"0.4.0","pluginTag":"v0.7.0","error":"",
   "verify":{"ran":true,"fails":[],"warns":["no primary route bound: …"]},
   "profiles":[{"profile":"default","computerBackend":"alans-way-computer","checked":true,
     "plugins":[{"name":"alans-way","version":"0.7.0","class":"catalog","updateAvailable":false}]}]}
  ```

  - `pluginTag` comes from `git ls-remote --tags https://github.com/capthvnsen/alans-way-agents`.
  - `verify` runs `setup.sh --verify --hermes-home <home>` once per server, from `~/alans-way-agents`, falling
    back to the clone named in a plugin install record. `setup.sh` audits every profile itself, so it is never
    run per profile. It keeps the text after `FAIL` and `warn`. With no `setup.sh` it is
    `{"ran":false,"reason":"no-setup"}`. A timeout is `{"ran":false,"reason":"time"}`. A non-zero exit with no
    `FAIL` line adds the fail `setup.sh --verify stopped early (exit N)`.
  - Profiles run in order within a 100-second budget. A profile the budget doesn't reach is reported with
    `"checked":false` and shows as one "Not checked (out of time)" row. (`ponytail:` every alans-way profile is
    checked; filter by the app's bot ids if multi-profile users find it slow.)
  - A catalog plugin whose update state Hermes couldn't determine has `"updateAvailable":null` and shows as
    "Couldn't check".
- **`desktop/src/vm-update.cjs`**: `doctorVm(vm)`, the same `runGuest` path with `--doctor` and a 120-second
  timeout. A Windows server returns `{ ok: false, error: 'windows' }` without running anything.
- **`desktop/src/setup-check.cjs`** (new, pure):
  - `buildFindings({ local, connection, server, appVersion, platform })` returns a list of
    `{ group, level, title, fix, action }`.
  - `staleConnectorCopy(userDataDir, appVersion)` returns the connector folder's path when it is older than
    the app, otherwise `null`.
- **`desktop/src/main.cjs`**:
  - A `setup-check` command collects the inputs and returns the findings.
  - A `remove-old-connector` command does what its name says.
  - At startup on Mac and Linux, remove the connector copy when `staleConnectorCopy` says it is older than the
    app and `bundledConnectorReachable` says the router can find the app's own connector (see below).
- **`desktop/src/renderer.js`**: the button and result list in Agent setup, and the wizard's step 3.

## Old connector copy at launch

`setup.sh` copies a connector into `<userData>/connector`, and the router uses that copy before the one in the
app. Nothing updates the copy afterwards, so it falls behind on the first app update. At each launch, the app
removes the copy when its `package.json` version is older than the app's version, but only if the router can
find the connector inside the app. On a Mac that means a packaged app running from `/Applications/<name>.app`
with a bundle name the router lists. On Linux it means a packaged app in one of the router's fixed app roots
(an AppImage never qualifies). Otherwise the copy is the only connector the router can find, so it is kept,
and Check setup doesn't report it as stale. The names and roots are mirrored from the router
(`alans-way-agents/alans-way/scripts/workspace-router.cjs`) and must be kept in step with it. A copy that is
newer than the app is always kept.

A connector that is already running keeps working until its SSH session ends. If it loads a file that has
since been removed, it exits, and the router starts the app's own connector on the next call. On Windows the
copy has no `package.json`, so it is left alone (out of scope).

## Copy report

The goal is something a user can send to support when they're stuck. Support either fixes the bug or tells them
what to change on their side.

- A **Copy report** button next to **Check setup**, and again under the results. Next to it is a
  **Get help on Discord** link, which opens the public invite from the README (`https://discord.gg/jBQCPUsVE`).
  After the copy, a message says: "Report copied. Paste it in Discord so we can take a look."
- The report is plain text. It contains:
  - the time;
  - the app version, OS and CPU, and whether the build is signed;
  - the saved server address;
  - the last Check setup results with their fix lines, or "Check setup not run yet";
  - the server's doctor summary: versions, plugin rows, and the `FAIL` and `warn` lines;
  - the last 50 lines of `main-errors.log`.
- Every failed app action gets logged. The `workspace:command` handler writes any error to `main-errors.log`
  before passing it on to the screen. Today only crashes and a few background tasks are logged, so most of what
  a user sees fail never reaches the file.
- Before copying, `redactReport(text)` takes out secrets:
  - Telegram bot tokens;
  - `"token": "…"` values;
  - `Authorization` and `Bearer` values;
  - `sk-…` API keys;
  - private key blocks.

  SSH addresses, usernames and versions stay in, because the report is useless without them.
- The report is only ever put on the clipboard when the user clicks. The app sends nothing on its own.
- Code: `buildReport(...)` and `redactReport(text)` in `setup-check.cjs`, plus a `copy-report` command in
  `main.cjs`.

## Errors

Every check is independent: one that throws becomes a ✗ row with the error text and doesn't stop the others.
SSH uses the existing options (`BatchMode`, pinned host keys). A `--doctor` run that times out or prints no
JSON line shows one Server ✗ row with the last two lines of its output.

## Testing

- `desktop/test/setup-check.test.cjs`: findings for healthy and broken inputs, including each rule in check 10
  and the skipped Server group.
- `desktop/test/vm-update-script.test.cjs`: `--doctor` against the existing fixture remote, with a fake
  `hermes` (check-updates JSON, `config get`) and a fake `setup.sh` that prints `FAIL` and `warn` lines. Also
  that `--doctor` changes nothing in the checkout.
- `staleConnectorCopy`: older, same, newer, and missing copies.
- `redactReport`: each secret shape is removed, and SSH addresses and versions are kept. `buildReport`: with and
  without check results, and with a missing log file.
- By hand: the new-user test run (a fresh macOS account and a fresh Hermes home on a test server), once healthy
  and once with problems put in on purpose: Screen Recording off, browser host stopped, an old connector copy,
  and an older plugin.

## Out of scope

- A terminal `alan doctor` command.
- Checks for Windows servers. The Server group says "Server checks aren't available for Windows servers yet."
- The Windows connector copy.
- Fixing `setup.sh --verify` failures automatically.
- Server logs (gateway, browser host) in the report. Add them when reports turn out to be missing them.

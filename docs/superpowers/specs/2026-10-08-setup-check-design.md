# Check setup

## Goal

One button in the app that tells a user whether their Open Alan setup works and, when it doesn't, lists each
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
| 11 | Computer use goes through Alan's Way | `--doctor` `computerBackend` per profile | Update Hermes to a build with the computer-use provider API, then re-run setup |
| 12 | Server setup audit passes | `--doctor` `verify` per profile: each `FAIL` line is ✗, each `warn` line is ! | "Ask your bot to run `setup.sh --verify` and fix what it reports" |

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
   "profiles":[{"profile":"default","computerBackend":"alans-way-computer",
     "plugins":[{"name":"alans-way","version":"0.7.0","class":"catalog","updateAvailable":false}],
     "verify":{"ran":true,"fails":[],"warns":["no primary route bound: …"]}}]}
  ```

  - `pluginTag` comes from `git ls-remote --tags https://github.com/capthvnsen/alans-way-agents`.
  - `verify` runs `setup.sh --verify [--profile <name>]` from `~/alans-way-agents`, falling back to the clone
    named in the plugin's install record. It keeps the text after `FAIL` and `warn`. With no `setup.sh` it is
    `{"ran":false}`.
  - Profiles run in order within a 100-second budget. A profile the budget doesn't reach is reported as
    `"verify":{"ran":false,"reason":"time"}`. (`ponytail:` every alans-way profile is checked; filter by the
    app's bot ids if multi-profile users find it slow.)
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
    app.
- **`desktop/src/renderer.js`**: the button and result list in Agent setup, and the wizard's step 3.

## Old connector copy at launch

`setup.sh` copies a connector into `<userData>/connector`, and the router uses that copy before the one in the
app. Nothing updates the copy afterwards, so it falls behind on the first app update. At each launch, the app
removes the copy when its `package.json` version is older than the app's version. The router then uses the
connector inside the app, which the router already lists for `alans-way-localapp.app` and `Open Alan.app`. A
copy that is newer than the app is kept.

A connector that is already running keeps working until its SSH session ends. If it loads a file that has
since been removed, it exits, and the router starts the app's own connector on the next call. On Windows the
copy has no `package.json`, so it is left alone (out of scope).

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
- By hand: the new-user test run (a fresh macOS account and a fresh Hermes home on a test server), once healthy
  and once with problems put in on purpose: Screen Recording off, browser host stopped, an old connector copy,
  and an older plugin.

## Out of scope

A terminal `alan doctor` command, checks for Windows servers, the Windows connector copy, and fixing
`setup.sh --verify` failures automatically.

# Browser persistence

The browser keeps its existing profile. No profile migration, cookie database
inspection, or change to controller/epoch authorization is needed. `owner` records
tab origin for restoration; `botId`, controller, locks, approvals, and epochs still
govern access.

## Storage and lifecycle inventory

References below describe the implementation in this change.

| Entry point | Location | Effect on browser data |
| --- | --- | --- |
| App data root | `src/main.cjs:82` | Stable `appData/Hermes Workspace`, or the explicit `HERMES_WORKSPACE_DATA` override. No version or bundle path. |
| Local browser profile | `src/main.cjs:710` | `persist:browser`; Chromium stores its profile below the session data root, normally `Partitions/browser`. |
| Chat profile | `src/main.cjs:3357` | Separate `persist:telegram` partition under the same stable root. |
| Automatic preference saves | `src/main.cjs:201` | Only user-origin local tabs, in order, with active selection. New-tab URLs are portable `about:blank` records. |
| Settings saves | `src/main.cjs:409` | Uses the same tab snapshot and existing atomic private-file writer. |
| Startup restoration | `src/main.cjs:3331` | Up to the existing 40-tab limit; user control on restored tabs. Never promotes bot tasks to user tabs. |
| Signed Mac/Windows app update | `src/main.cjs:1291`, `electron-builder.cjs:29`, `electron-builder.cjs:80` | Stable identity; saves tabs and drains cookie/site storage before `quitAndInstall`. |
| Unsigned Mac app update | `src/mac-update.cjs:95`, `src/main.cjs:1302` | Swaps only bundle/staging directories. Saves the browser after staging, before relaunch and forced exit. |
| Normal quit | `src/main.cjs:3545` | Holds quit while saving. Snapshot is frozen before view teardown; write failures keep the app open for retry. |
| OS session end | `src/main.cjs:3382` | Starts the same save; OS shutdown cannot be held indefinitely. |
| Window close/hide | `src/main.cjs:3383` | Hides/minimizes the workspace; does not delete the profile or close browser tabs. |
| Close one tab | `src/main.cjs:805` | Removes that tab from the next snapshot; cookies/site storage remain shared. |
| Run setup wizard | `src/renderer.js:1813`, `src/main.cjs:2235` | Reopens setup on Home. Keeps the live tabs and the browser profile. |
| Reset browser permissions | `src/renderer.js:1224`, `src/main.cjs:1984`, `src/site-permissions.cjs:36` | Removes permission decisions only. |
| Clear cookies | `src/main.cjs:1948` | Explicitly removes cookies for the chosen domain or all domains, and refreshes the encrypted session snapshot before returning. Local storage is unchanged. |
| VM/Hermes update or setup retry | `src/main.cjs:2138`, `src/main.cjs:2161`, `src/server-setup.cjs:21` | Runs guest setup/update code; does not replace the local Electron profile. Guest browser profiles are independent. |
| Stale connector cleanup | `src/main.cjs:3485` | Deletes only the stale connector copy under app data. |
| Damaged preferences | `src/main.cjs:195` | Renames the damaged preference file for recovery; does not delete Chromium storage. |
| Extension install/removal | `src/extension-store.cjs:127`, `src/extension-store.cjs:141` | Removes only the managed extension directory, not the browser partition. |

There is no factory-reset handler that deletes the local Chromium profile.
Deleting app data externally, deleting the OS user, or replacing a guest disk
cannot preserve data that was stored only there.

## Root causes and repairs

On the original baseline, `src/main.cjs:201` and `src/main.cjs:400` saved every
non-extension tab without its origin. `src/main.cjs:3331` reopened the first 12
records using `createTab`'s human-controller default, then selected Home. Bot
tasks and popups therefore reappeared as user tabs, while later user tabs and
active selection were lost.

Origin is now recorded at creation and inherited by task popups and handbacks.
Human takeover does not change a task's origin, and a bot controlling a user
tab cannot make its own popups restorable user tabs. Startup does not replay
bot opens. Connector requests already avoid transport-level mutation replay
(`scripts/browser-mcp.cjs:204`); no retry policy or safety assertion was weakened.

During work, the original Telegram popup handler reused recently auto-opened
links, but its navigation handler (`src/main.cjs:571` on the baseline) always
created another tab. `src/main.cjs:548` now shares the existing 15-second link
reuse window across both paths. The auto-link notification also checks that
window when it arrives after a human click, without changing the existing tab's
controller or epoch. Explicit browser opens are unaffected.

The existing stable profile and `persist:` partitions were already correct.
However, the original update exits (`src/main.cjs:1267`, `src/main.cjs:1278`) did
not wait for Chromium cookie writes. Both update paths now flush storage before
exiting, including work done while an unsigned update is staged.

Electron also explicitly disables session-cookie persistence and restoration,
even in persistent partitions. See [Electron's network context implementation](https://github.com/electron/electron/blob/v44.5.1/shell/browser/net/network_context_service.cc#L101).
`src/browser-session.cjs:6` saves only session cookies with OS encryption in the
existing private preferences file, restores before pages load, preserves
host-only/Secure/HttpOnly/SameSite flags and partition keys, and does not invent expiry dates.
The [Electron cookie converter](https://github.com/electron/electron/blob/v44.5.1/shell/browser/api/electron_api_cookies.cc#L54)
omits partition keys, so the snapshot uses Chromium's cookie protocol through
private, unloaded views in each session partition. Those views are always
destroyed. Opaque partition keys cannot survive a process and are not restored
as unpartitioned cookies.
Live cookie changes, logout, explicit clearing, and quit refresh that snapshot.
Writes are serialized and use the latest preferences after asynchronous reads.
No plaintext fallback is allowed, including Linux `basic_text`.

Old bot-associated records have no reliable origin. They are retained in
`legacySavedTabs` for recovery, but are not automatically opened. Old shared
records still restore. Session-only sign-ins require working OS encryption;
native persistent cookies and site storage do not use this extra snapshot.

## Verification

- `node --test test/browser-persistence.test.cjs test/browser-session.test.cjs`
  covers ownership, ordering, selection, interrupted navigation, update/quit
  barriers, staging, encrypted restoration, logout, write errors and safe fallback.
- `node test/browser-storage-electron.cjs` uses a local HTTP fixture and three
  windowless Electron processes with temporary HOME/profile directories. It
  checks cookies/local storage across forced exits and clearing across relaunch,
  including third-party partition keys and isolation between browser and chat.
- `npm run test:restore-tabs` uses hidden windows, blocked external services,
  temporary profiles and six launches. It checks pending navigation, popups,
  15 user tabs, active selection, and task exclusion across repeated restarts.
- The storage fixtures mock the OS encryption boundary. They never consult the
  real keychain, profile, installed app, VM, gateway, or desktop controls.
- Full application checks: `npm ci --include=dev`, then `npm test` with the
  configured disposable headless Chromium binary. The known router-copy test
  failure is reported separately; it is not relaxed by this change.

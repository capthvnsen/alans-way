# Bug triage

[Claude], 2026-11-10, from `origin/main` `7672fdd`. There is no real issue list (#183 is a stub), so this list was built from:

- the computer-use QA report in draft PR #256 (`docs/qa/claude-computer-use.md`, bugs numbered CU-1 to CU-15 below);
- the security QA report in draft PR #250 (`docs/qa/qa-security.md`, S1 to S4);
- the "left standing" notes from lane G2 (PR #286);
- the desktop test suite (`cd desktop && npm test`).

## Already fixed on main

| Item | Fixed by |
|---|---|
| CU-1 VM desktop has no lease between agents | #252 |
| CU-2 helper timeout has no `code` | #253 |
| CU-3 VM drops step results when the app cannot be read afterwards | #254 |
| CU-4 VM screen password check fails open | #255 |
| S1 missing bot identity skips desktop approval | #243 |
| S2 secrets written to logs before redaction | #246 |
| S3 human-held VPS tab metadata leaks to bots | #249 |
| S4 failed env read can overwrite credentials | #266 |
| CU-7 approval wait not subtracted from the connector's budget | Mostly resolved: the connector now sends `X-Alans-Way-Remaining-Ms` for actions, and `computer-http.cjs` runs the approval and the action in that call context, so `checkCall()` stops the steps when the caller's time runs out. What remains: the approval prompt itself still waits its full 40 s and does not stop at the caller's deadline. Low priority. |

## Test suite on main

`npm test`: 1755 tests, 1716 pass, 0 fail, 39 skipped. Every skip depends on the environment: 20 Windows-guest update-script tests, 14 Windows PowerShell 5.1 file-source checks, 2 that need root on Linux, and 3 that need an `alans-way-agents` checkout or the router. None of them is a hidden failure.

## Ranked open bugs

Ranked by harm: lost or doubled input first, then wrong guidance to the agent, then cosmetic.

| Rank | Bug | Area | Status |
|---|---|---|---|
| 1 | CU-5 VM: xdotool input can outlive the 20 s helper kill, so every step result is lost | VM timeouts | **Fixed in this branch** |
| 2 | CU-6 Mac: `act` has no deadline, so long typing loses every result | Mac timeouts | **Fixed in this branch** |
| 3 | CU-9 Mac: AXPress `cannotComplete` makes a second event click (double press) or a retryable `failed` | Mac retries | **Fixed in this branch** |
| 4 | CU-12 VM: point steps skip the generation check and press a stale cached control | VM accuracy | **Fixed in this branch** |
| 5 | CU-10 Mac: the note after an action always says "unresponsive", even for a closed window or a quit app | Mac messages | **Fixed in this branch** |
| 6 | CU-11 the `not_found` hint sends the agent to `workspace_computer_apps` for a bad menu or file path | Connector messages | **Fixed in this branch** |
| 7 | CU-13 VM pixel input is not bounded to the target window | VM accuracy and policy | Needs a decision (below) |
| 8 | CU-8 Mac: refs and the selected window are cached per pid, not per bot | Mac concurrency | Needs a decision (below) |
| 9 | CU-14 smaller VM issues (xdotool failures read as `no_window`, exited pid gives an empty tree, `menu_bars` has no deadline, shot fallback geometry) | VM | Open, not fixed: each one is small and was reported from code reading only |
| 10 | CU-15 smaller Mac issues (interrupted drag skips `restoreCursor`, vertical slider inverted, partly visible ref clicked at full-frame centre) | Mac | Open, not fixed: each needs a real Mac GUI to reproduce |
| 11 | `mac-computer.test.cjs` "builds and its self test passes" falls back to an older prebuilt helper when the source does not compile, so it can pass against old code | Tests | Open. The "oldest macOS" compile test in the same file still fails on a compile error, so a full run catches it. A run filtered to the self test does not. |
| 12 | Low-contrast and sub-11px text in the sidebar caption, loading label and footer | Desktop UI | Needs a decision (below) |

## Needs Alex's decision (not fixed)

- **CU-13 bound VM clicks to the target window.** A click outside the window that `activate()` raised can land on another app, including a blocked one. Refusing points outside that window closes the policy gap. It would also refuse clicks on popups and dropdown menus, which X draws as separate windows. Decide: strict bounds, bounds that also allow the pid's other windows, or leave it as is.
- **CU-8 Mac per-bot ref books.** Keying caches by (bot, pid) stops two bots from inheriting each other's window and renumbering each other's refs. The cost is a separate tree read per bot. The current behaviour fails safe (`stale_ref`), so this is a design choice, not a crash.
- **G2 contrast and type size.** The colours and sizes come from the existing Workspace theme. Changing them is a design decision.
- **S-series deployment conditions** from #250 (separate OS users, tailnet ACLs, egress firewall install, historical log cleanup). The code is merged. Applying it to live machines is Alex's call.

## Verification limits

The VM fixes are tested through `vps-computer.py selftest` with stubs, not on a real X/AT-SPI desktop. The Mac fixes are tested through the native fixture (`test/mac-native-fixture.swift`), which swaps the AX and CGEvent calls for fakes, not on a real app. None of these fixes was run against a live GUI.

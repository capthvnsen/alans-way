# Computer-use QA: Mac and VM desktop tools

[Claude], 2026-10-28. Scope: the `workspace_computer_*` MCP tools on the local Mac (app `/v1/computer` API, `mac-computer.swift`) and the workspace VM (in-process `vps-computer.py`). I looked at accuracy, timeouts, retries, error messages, and concurrency between two agents (Hermes and Grok Bot).

Status labels:
- **Fixed**: a regression test failed before the fix and passes after.
- **Confirmed**: I traced the code path end to end but changed nothing.
- **Reported**: found by a read-only code review and not reproduced. Treat it as a lead.

Nothing here was run against a real Mac GUI, X server, or AT-SPI desktop. Doing that would mean taking over the screen.

## Fixed

| # | Bug | PR |
|---|-----|----|
| 1 | VM desktop has no lease between agents | [#252](https://github.com/capthvnsen/alans-way/pull/252) |
| 2 | A helper timeout carries no error code, so the recovery hint never fires | [#253](https://github.com/capthvnsen/alans-way/pull/253) |
| 3 | The VM helper drops step results when the app cannot be read after the input | [#254](https://github.com/capthvnsen/alans-way/pull/254) |
| 4 | The VM screen password check switches off when any one app fails to answer | [#255](https://github.com/capthvnsen/alans-way/pull/255) |

### 1. VM desktop: two agents' input interleaves (concurrency)

Hermes's `alans-way-computer` router child and Grok Bot's router child each start their own `browser-mcp.cjs` on the VM. Each one drives the desktop through its own in-process helper. The desktop lease exists only in the Mac app's `/v1/computer` handlers, so on the VM nothing stops two agents from clicking at the same time.

Repro:
1. Start two connectors with different `--bot-id` values against one host that lists `agent-desktop` but not `computer`.
2. Agent A runs `workspace_computer_action`.
3. Agent B immediately runs `workspace_computer_action`. It succeeds.

The legacy fix adds a file lease beside `connection.json` with the same rules as the Mac lease. Updates are serialized with an exclusive lock and corrupt/unwritable storage fails closed. A crash during a lease update can require stopping connectors and manually clearing its stale lock. The holder keeps it for 20 idle seconds, and a holder process that dies frees it at once. Test: `test/browser-mcp.test.cjs` `two agents on one in-process desktop share its lease`.

For mutually untrusted bots in separate OS users, use the identity-bound broker
credentials in [#268](https://github.com/capthvnsen/alans-way/pull/268) and shared
broker computer endpoint in [#272](https://github.com/capthvnsen/alans-way/pull/272).
The latter refuses the old in-process fallback; a writable shared lease file is
not an OS security boundary. No live desktop or service was changed.

### 2. A helper timeout has no `code`

The 20 s helper kill rejects with `Computer helper timed out.` but no code. Because of that, `COMPUTER_NEXT.timeout` ("It may still have run: snapshot … before retrying") never reached the agent, and wait polls reported `failed`.

Repro: use a fake helper with `FAKE_MODE=hang`. `helper.request({cmd:'act'})` rejects with `code === undefined`.

### 3. VM helper: input sent, but reported as failed

In `vps-computer.py`, `cmd_act` reads the app again after its steps and does not guard that read. Pressing a control that quits, closes, or hangs the app makes the read raise. The reply then becomes `{ok:false}` and drops every step result, even though the input landed. A model could press again (a double send). The Mac helper already handles this case.

Repro: in the selftest's agent-desktop stubs, make `walk_app` raise `Fail('…','unresponsive')`, then run `cmd_act` with one click. The reply is `ok:false` after the click was sent.

### 4. VM screen password check fails open (security)

`refuse_password_focus` asks every app on the bus when the target is the whole screen (pid 0 or an app with no tree). If one app had no Collection interface, or one app hung, it returned without checking anything else.

Repro: stub a bus with two apps. App 1's `GetMatches` errors and app 2 has a focused password field. The check returns `None` and the input proceeds.

Remaining limit: the app that failed is still not checked on the screen path. It is marked `shortcut:` in the code.

## Not fixed

Ranked by impact.

### 5. On the VM, xdotool input can outlive the 20 s helper kill (timeouts, confirmed)

`send_xdotool` uses a 30 s subprocess timeout (`vps-computer.py` `send_xdotool`), which is longer than the 20 s JS kill. `type` allows 2000 characters at `--delay 8`, which is at least 16 s before per-key overhead. When it runs over:
- JS kills the helper partway through typing,
- every step result is lost,
- the agent gets "helper stopped mid-action".

`cmd_act` also has no overall deadline across its 25 steps.

Repro: on a real VM desktop, `workspace_computer_action` `{action:'type', text:<2000 chars>}` into a slow app.

Fix direction: give `cmd_act` a deadline below 20 s (for example 17 s) and stop with a `timeout` result. Cap each `send_xdotool` call by the time remaining.

### 6. On the Mac, `act` has no deadline, so long typing loses every result (timeouts, reported)

`mac-computer.swift` `act()` tracks no elapsed time. When `AXSelectedText` insertion fails (Electron, web views, terminals), a 2000-character `type` with no ref posts one key per character with an 8 ms sleep each, which is about 16 s or more. The pre-action and post-action reads (up to about 6 s each) then push it past the 20 s kill. The text is half typed and every result is lost.

Fix direction: the same deadline as #5, inside Swift.

### 7. An untrusted agent's first action can exceed the connector's 90 s abort (timeouts, confirmed)

The order of costs for a Grok Bot action is:
1. `desktopApproval.check` waits up to 40 s for the user's Allow (`desktop-approval.cjs` `ASK_MS`).
2. Then `service.action` starts its own 45 s step budget plus up to 20 s for one run.

The connector does not send `X-Alans-Way-Remaining-Ms` for actions, so nothing subtracts the approval wait. If the user clicks Allow late and then runs a long batch, the total passes the connector's 90 s fetch abort. The agent then sees "response unavailable … may have executed", and the app cancels the remaining steps.

Repro: an untrusted bot sends a 25-step batch with waits. Click Allow at about 39 s.

Fix direction: run the approval inside the call context and give `service.action` a deadline of `min(CALL_BUDGET_MS, remaining)`.

### 8. On the Mac, refs and the selected window are cached per pid, not per bot (concurrency, reported)

In `mac-computer.swift`, `caches[pid]` (around line 1522) and `RefBook` are keyed by pid only. Two consequences:
- **Wrong window.** A bot that never took a snapshot of that pid and sends a coordinate action with no `windowId` inherits whichever window another bot snapshotted last.
- **Ref churn.** Two bots reading different windows of one app renumber each other's refs. This is fail-safe (`stale_ref`), but the two can keep invalidating each other.

Repro (by reading only): bot B snapshots window W2 of app P. Bot A, with no snapshot, sends `click x,y` to P. The click goes to W2.

### 9. On the Mac, AXPress `cannotComplete` is treated as "did not run" (retries, reported)

`pressElement` (around `mac-computer.swift:748`) and `pressMenu` (around :957) treat any AX result other than success as a failed press.
- A press that opens a modal (Save As…, a Delete confirmation) can block past the 1 s messaging timeout and return `cannotComplete`.
- `pressElement` then falls back to an event click on the same spot, which is a second press, and reports `ok:true`.
- `pressMenu` throws `failed`, which invites a retry of a menu item that already fired.

Fix direction: map `cannotComplete` to `unresponsive` ("may have run, snapshot first") with no fallback click.

### 10. Mac post-action note always says "unresponsive" (error messages, confirmed)

`mac-computer.swift` (around :1556-1559) adds `unresponsive: the steps ran but the app stopped responding` whenever the read after the action fails. That includes a window the step closed (`stale_window`) and an app that quit (`not_found`), so the agent is told a healthy app is hung. Fix #3 gives the VM the real code; the Mac still needs the same change.

### 11. `not_found` hint is wrong for menu and file errors (error messages, confirmed)

`not_found` is also returned for `No such menu item.`, `That file does not exist.` and `No app opens that file.`. The attached `COMPUTER_NEXT.not_found` hint tells the agent to "call workspace_computer_apps if the app may have quit", which sends it the wrong way for a bad menu path or file path.

Repro: fake helper with `FAKE_MODE=bad-menu`, or a real `workspace_computer_menu` with `path:["Nope"]`.

### 12. VM pointer steps skip the generation check (accuracy, reported)

In `vps-computer.py`, the generation is checked only when a step has a `ref`. Steps with `x,y` on a user desktop hit-test the cached `WALKS[pid]` of any age and act on that cached handle. On the agent desktop, pixel steps are used instead, so this affects only a Linux user's computer.

Repro: `WALKS[7]` holds an old button covering (10,10). `act click x=10 y=10 generation=999` returns ok and presses the old handle.

### 13. VM pixel input is not bounded to the target window (accuracy, reported)

For pid > 0, `activate()` raises the largest window of that pid, but `(x,y)` is never checked against it. The policy check covers the pid, not the window under the point, so a click can land on another app, including a blocked one.

Repro: stub `best_window` to return 100x100 at (0,0), then send `act pid=9 click x=900 y=900`. The click is sent.

### 14. Smaller VM issues (reported)

- `xdotool()` swallows failures and returns `''`, so `best_window` reports `no_window` when xdotool actually failed.
- On the agent desktop, a pid that has exited gives `ok:true` with an empty tree rather than `not_found`.
- `activate`, `select_text` and `secondary_action` come back as `unsupported_action` on Linux.
- `menu_bars` crawls the tree one call at a time with no deadline, so a big app can pass 20 s.
- In the shot fallback (scrot or ffmpeg region, clamped to the display), the reply reports the unclamped window geometry, so image-to-screen math is off for windows that extend past the screen.

### 15. Smaller Mac issues (reported)

- A drag that the user interrupts drops at an intermediate point and then throws `in_front`, which implies nothing happened. It also skips `restoreCursor`.
- Vertical `AXSlider` drag math treats the top as the minimum, so the value is inverted.
- Event clicks on a ref use the full frame's centre even when only part of the element is visible.

## Latency

Measured on this Mac (M-series, Node 26.7) with no GUI.

| Path | Before | After |
|------|--------|-------|
| In-process action + VM lease (#252), 2000 runs | p50 0.001 ms, p95 0.003 ms | p50 0.55 ms, p95 1.6 ms |
| `computer-bench.cjs --fixture --runs 20` (service and snapshot cache) | wall p50 0.07 ms, p95 0.88 ms, 60/60 | unchanged (no service-path change) |

Fixes #2, #3 and #4 add no work on the success path. I did not run the real-app bench (`computer-bench.cjs` without `--fixture`) or the VM end to end, because both drive a live desktop.

## Test commands

```sh
cd desktop
node --test test/browser-mcp.test.cjs test/desktop-lease.test.cjs test/computer-helper.test.cjs \
  test/desktop-approval.test.cjs test/remote-agent-e2e.test.cjs test/vps-computer.test.cjs test/mac-computer.test.cjs
python3 scripts/vps-computer.py selftest
```

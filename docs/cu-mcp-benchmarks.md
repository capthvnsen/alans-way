# CU MCP benchmarks

A repeatable speed benchmark for Alan's CU MCP (`desktop/scripts/browser-mcp.cjs`): ten fixed tasks, six in the browser and four in a Mac app, all driven over stdio through the MCP server the way a model drives it. It measures the tool layer only, with no model time.

## Run it

```sh
cd desktop
node test/bench/cu-mcp-bench.cjs --runs 3 --mac-app /Applications/alans-way-localapp.app
```

- **Browser tasks** run headless Chrome (or `HERMES_TEST_CHROME`) with this checkout's VM browser host (`scripts/vps-browser-host.cjs`). They reuse the fixtures and emulated agent loop of `scripts/browser-bench.cjs`.
- **Mac tasks** drive `test/computer-bench-app.swift`, a two-window fixture app shown at the right edge of the screen. Its panels never take focus. Accessibility belongs to Alan's Workspace, not your terminal. `--mac-app` therefore re-runs the bench under that app's Electron, as Node, launched by `open`. The app's grant then covers the helper, while the computer code that runs is this checkout's. No app window opens. `--computer-connection FILE` drives a running app's own bundled code instead. Without either flag, the Mac tasks are skipped.
- `--root DIR` benches another checkout's MCP server, VM host and computer code, for a baseline. `--json FILE` saves every call.

Per task it reports success, round trips (MCP calls), tool time, the per-call p50, KB returned and tool errors. Per tool and action it reports p50/p95 latency. Success is checked by code: the fixture page reports its state, or the final app tree has to show the expected text.

| Task | What |
|---|---|
| search-open | Type a query, press Enter, open the 6th result, read a date |
| form-multifield | Fill 7 controls of 5 kinds and submit (approval-gated) |
| cookie-modal | Add to cart past a newsletter modal and a cookie banner |
| popup-tab | Read a code from a pop-up tab and enter it in the first tab |
| confirm-dialog | Delete a draft behind a confirm dialog (approval-gated) |
| spa-rerender | Add, tick and delete todos in a list that re-renders (approval-gated) |
| mac-press-x3 | Press Increment three times and confirm `Count: 3` |
| mac-type-submit | Type a name, submit, confirm the result |
| mac-other-window | Act in the second window, confirm the copied text |
| mac-scroll-list | Scroll a long list until rows past 10 are on screen |

There is no menu task. On a Mac, menus need the app frontmost, and making it frontmost would take focus from whoever is using the machine.

## Results

Recorded 2026-11-11 on a MacBook (darwin-arm64), 3 runs per task, medians. The baseline is `origin/main` at `7672fdd` (`--root`). "After" is branch `agent/m1-cu-speed`. Someone else was using the Mac during both runs.

| Task | Round trips | Tool ms, before | Tool ms, after | Change |
|---|---|---|---|---|
| search-open | 3 | 799 | 786 | noise |
| form-multifield | 4 | 1072 | 1053 | noise |
| cookie-modal | 4 | 464 | 417 | noise |
| popup-tab | 4 | 459 | 470 | noise |
| confirm-dialog | 7 | 474 | 433 | noise |
| spa-rerender | 7 | 1811 | 1814 | noise |
| mac-press-x3 | 2 | 705 | 290 | **−59%** |
| mac-type-submit | 2 | 476 | 186 | **−61%** |
| mac-other-window | 2 | 449 | 194 | **−57%** |
| mac-scroll-list | 2 | 106 | 91 | noise |
| **Total** | **37** | **6815** | **5734** | **−16%** |

Success was 30/30 before and 30/30 after. Bytes returned were unchanged at 81.1 KB in total. A Mac `batch` call's p50 went from 337 ms to 175 ms.

## What the baseline showed

1. **A Mac batch ending in `wait` paid a fixed 300 ms.** After any `press` or `click`, the helper sleeps until 300 ms have passed, so a pane drawn by another process (System Settings) has time to update. When the caller's next step is a `wait`, that sleep only adds latency, because the wait polls the tree for the effect anyway. **Fixed:** a run of steps followed by a `wait` asks the helper for the normal event-based settle without the fixed floor (`settleMs`). A run that is not followed by a wait keeps the beat. Mac only: the Windows and Linux helpers read `settleMs` as their whole settle (60 ms by default), so they are not sent it.
2. **A busy desktop turned into a model round trip.** When the target app is frontmost and the person touched the keyboard or mouse within 2 s, the helper refuses with `in_front`, and the model is told to wait and retry. The baseline runs hit this while someone was using the Mac. **Fixed:** an `in_front` refusal at the start of an action, where nothing has been sent yet, now waits out the idle rule (2.1 s) and retries once inside the call. If the person is still busy, the same clear error comes back. Mac only: on Windows and Linux `in_front` means the target is the foreground app, which waiting does not change. The hint to the model is unchanged, so older hosts still get correct advice.
3. **The browser is at its floor.** Each action costs about 130 ms, mostly the post-action settle, which catches late DOM reactions (a 250 ms first watch, a 60 ms quiet window, a 400 ms cap). Steps inside a batch don't settle one by one; the batch does one effect read at the end. Trimming those windows would trade reliability for speed, so it was left alone.
4. **Extra round trips are by design.** Of the 37, 6 are tool errors: approval gates (`commit_required` on Send, Delete, and Enter near a Delete) and a covering modal. Each error names its fix, so the next call succeeds. Snapshots are cheap: 4 ms p50, thanks to the snapshot cache.

## Not measured

- Model time, and therefore a Codex comparison: see [benchmarks/computer-use.md](benchmarks/computer-use.md) for the model-arm harness.
- The app's in-window browser. The browser half uses the VM host's code.
- Windows and the VM desktop.

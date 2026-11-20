# Handoff and VM desktop QA — Codex

2026-10-28; base `5d10e81`; isolated Orca worktree `qa-handoff`.

## Fixed

| Bug | Reproduction | Fix / evidence |
| --- | --- | --- |
| Unchanged live tasks lose their VM mirror after 24 hours. | Mirror an agent tab, leave URL/scroll/drafts/cookies unchanged for more than 24 hours, then sleep the Mac and request VM restore. The app suppresses every refresh and the host rejects the expired mirror. | Hourly refresh with failed-push retries; simulated sleep/network/Tailscale recovery test. [PR #244](https://github.com/capthvnsen/alans-way/pull/244). |
| Refreshing an identical checkpoint replays navigation over VM work. | Restore a mirror, resend the same payload, restore again. The host advances the checkpoint revision and navigates the existing VM tab again. | Separate liveness timestamp from content revision; real host API regression asserts no extra navigation. PR #244. |
| Double Move requests duplicate the task. | Pause the source queue, submit two handoff commands, resume; two destinations appear. For Move back, refresh the remote tab cache while the checkpoint is paused and submit again. | One pending operation per source ID, independent of polling replacements. [PR #247](https://github.com/capthvnsen/alans-way/pull/247). |
| A retired source can be moved again. | Complete a Move, then resubmit the original source ID directly to the command path. | Reject an already retired source; regression checks exactly one destination. PR #247. |
| A completed move is not saved when destination focus fails. | Restore successfully, then fail the final remote `activate` request. The source is retired but persistence is skipped and the command throws. | Save completion before best-effort focus; injected network-drop regression. PR #247. |
| Move back permits agents on the destination despite uncertain VM retirement. | Restore locally, then pause or drop the response to the VM source's retirement request. Claim the local copy as an agent. | Destination stays gated until retirement finishes, and failed retirement retains human review; regressions exercise the production claim policy. PR #247. |
| A lost restore reply leaves an unrecorded VM destination. | Create the VM destination, then lose the restore response. | The app asks the VM whether its tab carries this move's handoff id; if so the move is recorded once, otherwise the unconfirmed destination is deleted and the source goes back to its agent. If the VM answers nothing at all the destination may remain human-held on the VM; the source is still the only agent copy. |
| A failed outbound Move hides its retry button. | Fail the restore (or the take-over) after the source was handed to the human. | Any failure before the source is retired gives it back to its agent, and a failed Move back closes its half-made local copy. |
| A silent VNC handshake wedges the VM viewer indefinitely. | Accept a WebSocket upgrade but send no VNC negotiation bytes. Wake/focus/online events cannot recover the still-pending attempt. | 15-second deadline with stale-event fencing and auth cancellation. Unit regressions plus actual hidden Electron/noVNC against a loopback fault server. [PR #251](https://github.com/capthvnsen/alans-way/pull/251). |

## Still open

- **Optional paired-plugin parity.** Set `ALANS_WAY_AGENTS` explicitly to opt into a paired plugin checkout. The default suite stays inside this repository.

## Verification and limits

- Every fixed failure was reproduced red before its fix. The mirror/host suite passes 55 tests; the final handoff/persistence suite passes 23; reconnect/preview passes 27; lease coverage passes 19.
- Combined `cd desktop && npm run check`: syntax checks passed, then 1,629 tests passed, 36 skipped, one failed on the external commit-pattern mismatch above (1,666 total). The final retirement-in-flight regression was added afterward and the affected 23-test handoff/persistence suite passed again. An initial run before dependencies were installed also failed on missing SDK/build packages; `npm ci` resolved those environment failures.
- The stale lease test advances time by 24 hours, acquires a new owner, then delivers the old owner's delayed release. Expiry and active-request protection already work; no lease code change was needed.
- Real viewer check: `cd desktop && node test/run-electron.cjs test/remote-reconnect-electron.cjs`. Uses actual noVNC, a hidden Electron window, disposable profile, and loopback WebSocket faults; asserts recovery without enabling control. The same runtime test against the original viewer source failed after 24 seconds with only one connection attempt; the fixed viewer passed.
- Physical lid-close, live Tailscale changes, and authenticated Mac↔VM routing were not exercised. The routing plugin is a separate repository; README describes in-flight host tasks as blocking/resuming rather than migrating. No automatic mid-task migration claim is made.
- No release, deployment, public listener, signing operation, credential change, or merge was performed. The three draft PRs are independent; the local `capthvnsen/qa-handoff-validated` branch combines them for validation only.

# Chat surfaces speed benchmark

Goal: prove Alan's native chat is the fastest of the three surfaces, and keep it that way. This doc defines the metrics, records what could be measured on 2026-11-11, and says how to measure the rest.

## Result of this run

**No latency numbers were measured.** The reasons are below; nothing here is estimated.

| Item | Result | Samples |
|---|---|---|
| Hermes webapp at `http://127.0.0.1:9120`: time to first byte, total time, asset sizes, cache headers | Not measured. Nothing is listening on the port | 0 |
| Telegram Desktop cold launch | Not measured. Telegram was already running and was not quit | 0 |
| Telegram Desktop version | 12.10 | n/a |
| Hermes Desktop app bundle version (`/Applications/Hermes.app`) | 0.0.1 (bundle version; the agent itself is v0.23.1) | n/a |
| First token | Not measured. It needs a message sent to a live bot, which this run did not do | 0 |

### Why the webapp could not be measured

Real output from this Mac:

```
$ curl -s -o /dev/null -w "%{http_code} %{time_total}\n" -m 5 http://127.0.0.1:9120/
000 0.000181
$ lsof -iTCP:9120 -sTCP:LISTEN
(no output)
$ pgrep -fl "ssh.*9120"
(no output)
```

- No code in this repo opens that tunnel. `9120` appears only as the Hermes webapp port in help text (`desktop/src/renderer.js:1731`, `:2168`). The embed design doc records a hand-run SSH tunnel to that port (`docs/design/hermes-webapp-embed.md:34`) and gives Tailscale Serve as the set-up on the Hermes host (`:76`).
- The Workspace app was running, so the tunnel is simply not up.
- Tailscale shows one bot host active and one offline for 54 days. Which one serves the webapp was not checked, because that means contacting the VM.
- The run was told not to change the VM, so the tunnel was not started.

**To unblock:** start the tunnel or the Tailscale Serve address the usual way, then re-run the HTTP section below. No VM change is needed for the measurement itself.

## Metrics

| Metric | Definition | Start | End |
|---|---|---|---|
| Cold open | App not running to chat usable | Process spawn | Composer accepts input and the last message of the default thread is painted |
| Warm open | Window hidden to chat usable | Window show | Same end mark |
| Thread switch | Click another bot to its thread visible | Pointer-up on the row | Last message of the new thread painted and the composer focused |
| First token | Send to first visible reply text | Enter pressed | First streamed text painted in the reply bubble |
| First token overhead | First token minus the same request made straight to the Hermes API from the same machine | n/a | n/a |
| 1k scroll | Smoothness scrolling a thread of 1,000 messages top to bottom | Scripted scroll start | Scroll end |

For 1k scroll, record p95 frame time, percentage of frames over 16.7 ms, and the longest single frame.

Always record alongside: surface, app version, machine, power state, network path (loopback, tunnel or tailnet) and round-trip time to the bot host. Webapp and native numbers include the network; Telegram's go to Telegram's servers. Without the round-trip time the surfaces are not comparable.

## Targets

Native chat must meet these and must beat both other surfaces on every metric on the same machine and network.

| Metric | Median | p95 |
|---|---|---|
| Cold open | under 1.5 s | under 3 s |
| Warm open | under 150 ms | under 300 ms |
| Thread switch | under 100 ms | under 250 ms |
| First token overhead | under 50 ms | under 150 ms |
| 1k scroll frame time | n/a | under 20 ms, under 2% slow frames |

These are starting targets. Replace them with "10% better than the best other surface" once the first full run exists.

## Method

Shared rules: 3 warm-up runs discarded, then 20 runs (10 for cold open). Report median and p95. Same machine, on power, nothing else heavy running.

### Harness

Nothing in the repo measures chat speed today. The existing benches time computer-use tools. Reuse their plumbing:

- `desktop/scripts/browser-bench.cjs` already launches the app under Electron with a throwaway profile (`--engine app`) and records per-call latency. Add a `chat` engine beside it.
- `desktop/test/webapp-embed-electron.cjs` already serves a fake loopback Hermes into the embedded pane. Extend that fixture to serve a 1,000-message session and a scripted streamed reply. This gives network-free numbers for both webapp and native chat.
- `scripts/bench-cu.sh` and `desktop/eval/report.cjs` already write `results.json`, `results.md` and a `meta.json` with git revision, platform and host round-trip time. Emit the same shape under `docs/benchmarks/results/<date>-chat/`.
- The `manual` arm of `desktop/eval/run.cjs` is a stopwatch mode. Use it for Telegram Desktop where scripting is not possible.

### Per surface

| Metric | Native chat | Embedded webapp | Telegram Desktop |
|---|---|---|---|
| Cold open | Spawn time to a `chat-ready` mark set by the renderer | Spawn time to `did-finish-load` plus a composer-present check run in the view | `open -a Telegram` to first window, polling the window count every 50 ms. Needs Accessibility permission |
| Thread switch | Marks around the row click handler and the first paint after it | Scripted click in the view, then a mutation observer waits for the new thread's last message | Scripted click plus screen-capture diff, or the manual arm |
| First token | Mark on send, mark on first streamed text node | Same, inside the view | Manual arm only |
| 1k scroll | Scripted wheel events with a frame-time recorder | Same, inside the view | Screen recording at 120 fps and frame analysis |

Two runs per surface for first token and scroll: once against the loopback fixture (pure client cost), once against the real bot (what the user feels).

### HTTP check for the webapp (run when the tunnel is up)

Read-only, no sign-in, no messages sent:

```
for i in $(seq 1 10); do
  curl -s -o /dev/null -m 10 \
    -w "%{http_code} ttfb=%{time_starttransfer} total=%{time_total} bytes=%{size_download}\n" \
    http://127.0.0.1:9120/
done
```

Then list the scripts and stylesheets the root page references, with size, transfer time and cache headers. Total script weight is the best single predictor of webapp cold open.

### First token needs a go-ahead

It sends a real message to a real bot. Use a dedicated test bot and a fixed prompt, and get Alex's OK before the first run.

## Open questions

1. Which host serves the webapp today, and over which path (tunnel or Tailscale Serve)? Needed before any real-network run.
2. Is a 1,000-message Hermes session available, or should the fixture be the only scroll source?
3. Should the benchmark gate merges (fail CI when native chat regresses), or run nightly?

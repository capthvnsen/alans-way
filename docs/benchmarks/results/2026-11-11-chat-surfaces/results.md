# Chat-surface speed, 2026-11-11

Native chat (`native`) vs the embedded Hermes Webapp (`hermes-desktop`) vs Telegram, in the real app
(`desktop/src/main.cjs`, branch `agent/w1-native-chat`, #297) with a throwaway profile per surface.
Raw samples: `results.json`. Harness: `desktop/test/bench/chat-surfaces-bench.cjs` (`npm run bench:chat`).

## Machine and conditions

Apple M5 Pro, 48 GB, macOS 27.2 (26B123), Electron 44.5.1, Node 26.7.0, app 0.21.14, git `fa73763`.
Power: **AC, charging at 46%** when the run started (the machine was on battery while the harness was
developed). Load average at start 5.4 / 8.0 / 7.4: other agents and Alex's own Alan's Workspace were running,
so absolute numbers carry that noise. The display refresh rate was not recorded.
Hermes Agent 0.23.1 (scratch `HERMES_HOME`, loopback) with the deterministic fake model at its defaults
(first chunk after 50 ms, 15 ms per 4-character chunk, replies `pong: <text>`).
n: 3 warm-ups discarded then 10 for cold opens; 20 thread switches; 10 first tokens after 1 discarded turn;
5 scroll runs. p95 is nearest-rank, so for n=10 it is the slowest sample.

## Results (ms unless stated; median / p95)

| Metric | native | hermes-desktop | Telegram | Winner |
|---|---|---|---|---|
| Cold open: spawn to last message painted and composer present (n=10) | **479 / 519** (cache primed); 518 / 545 with the disk cache deleted | 907 / 960 | not measured (needs a signed-in session) | native, 1.9x (-428 ms) |
| Thread switch, click to last message painted (n=20) | **6.8 / 14.2** | 61.3 / 102.3 | not measured | native, 9x (-54 ms) |
| First token, Enter to reply text painted (n=10) | **141.7 / 153.6** | 321.3 / 357.2 | not measured | native, 2.3x (-180 ms) |
| 1k scroll, p95 frame (n=5) | **9.9 / 9.9** | 19.6 / 24.6 | not measured | native, 2x |
| 1k scroll, % frames > 16.7 ms (n=5) | **0.2 / 0.4** | 23.9 / 29.4 | not measured | native |
| 1k scroll, worst frame (n=5) | **18.3 / 20.2** | 33 / 232 | not measured | native |

Telegram, cold open to the sign-in screen only (throwaway profile, never signed in, real `web.telegram.org`
over the network, n=10): **7,318 / 8,451 ms** to the painted "Log in by phone number" button. This is a
different endpoint from a thread paint and is not comparable with the rows above.

Native lost no metric. Cross-checks with the app's own marks agree: native `pane-painted` 475 / 516 ms.

### First-token floor (plain `curl`, `POST /api/sessions/{id}/chat/stream`, spawn to first `assistant.delta`, n=10 after 1 discarded)

| | median / p95 |
|---|---|
| new session | 131.1 / 157.1 |
| existing session | 127.2 / 140.1 |
| curl spawn to `/health` first byte (inside the numbers above) | 8.2 / 9.5 |
| `POST /api/sessions` | 1.3 / 9.2 |

Overhead = surface - floor (new session): native **+10.6 ms** (about +2 ms net of curl's spawn);
hermes-desktop **+190 ms**. The Webapp does not use this API: it talks to the gateway over its own
WebSocket, so its overhead includes a different server path, not only client cost.
The very first turn after the gateway has been idle costs about 1.1 s (agent setup); that turn was discarded everywhere.

### VM over tunnel (`http://127.0.0.1:9120`)

Round trip to `/api/status` (`curl -w %{time_total}`, n=10, HTTP 200): **246.5 / 760 ms**.
Cold open and thread switch on the VM: **not measured**, see below.

## Method

- **Cold open**: the parent stamps `Date.now()` just before spawning Electron; the child reports the epoch time
  of the first frame (rAF, then a 0 ms timer, as the app's own marks do) in which the last message of the 40-message
  thread `bench A` is in the DOM and the composer is shown. The same predicate form is used on both surfaces.
  - native: the last thread is remembered and painted from the disk cache (second row: cache deleted before each launch).
  - hermes-desktop: the Webapp has no sign-in here but needs a one-use link on every launch (its credential is in
    `sessionStorage`). The harness mints one just before the spawn (excluded) and pastes it through the app's
    `webapp-link` command as soon as the app asks (included). The Webapp does not reopen the last thread, so once the composer
    is up (median 700 ms, "composer ready" in `results.json`) the harness sets the route `#/<session id>` and the metric ends
    when that thread paints. A person would click a sidebar row there, so this is a lower bound.
  - All launches of native and hermes-desktop answer Telegram's `https` with a static page, so Telegram's
    real load (which the real app starts in the background on every surface) is excluded.
- **Thread switch**: alternating between two seeded threads (40 and 44 messages). native: menu item click; hermes-desktop:
  sidebar row click. Time from the click to the frame with that thread's last message painted and its identity shown.
- **First token**: new conversation, real key events (`insertText` + Enter), `hello`. t0 is the Enter keydown in
  the page; the end is the first frame whose assistant text contains `pong`. native's own `send`->`first-token`
  marks are in `results.json` as a cross-check.
- **1k scroll**: the seeded 1,000-message thread (long markdown messages). 150 wheel events of 400 px up (60,000 px)
  then 150 back down, 16 ms apart, sent with `webContents.sendInputEvent` at a point over the scroller; a rAF loop records
  frame deltas. The harness fails the run if the scroller did not move. Frame deltas are over both legs (about 660 frames native, 400-460 hermes-desktop).
  The Webapp's sidebar drawer covers the thread at chat-pane width, so it is closed before scrolling.
  For the 5 hermes-desktop openings of the 1k thread the sidebar had no row for it, so the harness used the route (`#/id`) instead; the 20 switches and the cold opens are unaffected.

## How the Webapp was made to work in the lab

`/` said "The Webapp is not built". The bundle is the Vite renderer of `apps/desktop`; the gateway serves
`<checkout>/apps/desktop/dist-webapp`, or the folder named by **`HERMES_WEBAPP_DIST`** (read at gateway start; the
gateway then serves it read-only and never builds or marks it). The real install already has a built
`apps/desktop/dist`. It was **copied** to `$LAB/webapp-dist` (Electron-only files dropped), nothing was written under
`~/.hermes`, and the lab was restarted **once**: `lab.sh stop`, then `HERMES_WEBAPP_DIST=$LAB/webapp-dist lab.sh start`
(this replaced the lab gateway pid 23774 with 39739; the fake model was restarted with it). The lab's `pids/gateway.pid` was
left stale by that restart and was corrected by hand. Sign-in: the lab Webapp has none but needs a one-use link, which
`hermes webapp --no-open --skip-build` mints through the lab gateway's control socket, with `HERMES_HOME`, `HERMES_GATEWAY_LOCK_DIR`
and `HERMES_WEBAPP_DIST` pointing into the lab. The Webapp lists API and Telegram sessions in per-platform sidebar
groups, so no re-seeding under another `source` was needed. Fixtures (`bench 1k` 1,000 messages, `bench A` 40,
`bench B` 44) are seeded with `lab.sh seed`, newest first so the sidebar shows them.

## Cross-surface (E2E proof)

`/tmp/w1-proof/hermes-desktop.png`, `hermes-desktop-transcript.txt`, `cross-surface.txt` (kept outside the repo). A message
`hello from hermes desktop` sent in the Hermes Desktop surface got `pong: hello from hermes desktop`. The session is
`local-f9d213d5...`, source **`local`**, 2 messages. The native API lists it and reads its messages (200). `POST .../chat`
with `hello from native` is **refused with HTTP 500** (gateway log: `RuntimeStoreError('permission_denied')`, unhandled),
so native shows such sessions read-only ("Continue here" forks a copy).

## Not measured, and why

- **Telegram thread switch, first token, 1k scroll, and a cold open to a thread**: needs Alex's signed-in session, which lives in his
  real app profile; that profile was not used, copied or read and nothing was signed in. Manual stopwatch procedure for someone signed in
  (screen recording at 60 fps is the most accurate; otherwise a phone stopwatch, 10 runs, take the median):
  1. Quit the app, start it, start the stopwatch at the click or `open`, stop when the last message of the open chat and the composer are on screen (cold open).
  2. With two chats open in the list, start on a click on the other chat and stop when its last message shows (thread switch), 20 times alternating.
  3. In a new chat type `hello`, start on Enter, stop when the first reply text appears (first token); against the same fake-model Hermes `pong: hello` is the reply.
  4. Open the longest chat and drag the scrollbar or hold the Page Up key from the newest message to the oldest and back; note stutter by eye, or record the screen and count frames longer than 16.7 ms.
- **VM over the tunnel: Hermes Desktop cold open and thread switch.** The VM Webapp (0.23.0) has no sign-in but `GET /api/sessions` without a
  credential answers 401, so a one-use link must be minted on the VM (`hermes webapp --no-open`). That is an action on Alan's host this run was
  not allowed to take. Only the round trip above was measured.
- The real app's Telegram background load during native/hermes-desktop runs (stubbed out, see Method).
- Battery behaviour: the run itself was on AC.

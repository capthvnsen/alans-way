# Alan's Way gateway: design spec

Status: draft for owner review, 2026-11-19. Design only; no product code changed.

How to read the references:

- `path:line` is this repo at `3d0ecda`.
- `hermes:path:line` is the Hermes checkout installed at `~/.hermes/hermes-agent` (commit `ae2a81ccc00`, 2026-11-16). It was read only. No `hermes` process was started or touched, and no auth or `.env` file was read.
- **unconfirmed** marks a claim I could not check in code. The benchmarks ran on Hermes 0.23.1/0.23.2; the installed checkout's `pyproject.toml` says `version = "0.0.0"`. That the checkout's wire equals the Hermes on the VM is itself unconfirmed.

## Today

### Three chat paths, one inbox

| Gateway row | Transport | Auth | After a dropped connection |
|---|---|---|---|
| Telegram | Telegram Web (desktop), TDLib (iOS) | Telegram login | Telegram's own client retries |
| Hermes | Hermes Desktop Webapp in an embedded view, over Tailscale Serve (`docs/hermes-desktop-signin.md:1-12`) | username + password, cookie | not ours |
| Alan's Way | Hermes REST + SSE (`/api/sessions/*`), main process | static API key (`API_SERVER_KEY`) | stream is lost, see below |

`desktop/src/gateway-list.js:5-9` defines the three rows; `gatewaySections` (`:13-22`) makes one row per bot per connected gateway. `docs/native-chat.md:87-127` describes the sections.

### Native chat (the "Alan's Way" row)

- **Shape.** Thin client; Hermes keeps the conversations. HTTP runs only in the Electron main process; the renderer gets a projected state and an allowlist of commands (`desktop/src/native-chat.cjs:1-5`, `docs/native-chat.md:7-9`).
- **Client.** `desktop/src/hermes-api.cjs:142-152`: list/create/fork sessions, `getMessages`, `getRun`, `stopRun`, `answerApproval`, `answerClarify`, and `streamChat` (`POST /api/sessions/{id}/chat/stream`, SSE).
- **Stream loss.** A stream that is silent for 45 s counts as dropped (`hermes-api.cjs:7,113-140`). There is no resume. `finish()` shows "The connection dropped during the reply; it may be incomplete." and re-reads the stored messages (`native-chat.cjs:234-258`, text at `:248`).
- **Sends.** One reply at a time per conversation (`native-chat.cjs:313`). A send gets a local row with state `sending`, then `sent` on `run.started`, or `failed` (`:206,239,262`). **Retry** starts a new run with the same text (`:324-332`). `failed` is set only if the drop happened before `run.started` arrived (`:238`). A request that reached Hermes but whose `run.started` was lost can therefore be sent twice. This is the duplicate the queue in phase 2 must close.
- **Clarify questions** are found by polling the run once a second (`native-chat.cjs:185-201`, `docs/native-chat.md:134-135`), because they are not on the SSE stream.
- **Cache.** Messages per conversation in `native-chat-cache/`, merged by server row id, 32 MB cap (`native-chat.cjs:12,33-39,79-101`).
- **Address rule.** `https://` to any host, `http://` only to loopback (`hermes-api.cjs:15-24`). It does not consult `HERMES_WORKSPACE_REQUIRE_TAILNET`: there is no import of `tailnet.cjs` in `hermes-api.cjs` or `native-chat.cjs`.
- **Key storage.** Sealed with `safeStorage` (`desktop/src/main.cjs:3812-3822`); memory only when no keychain.
- **Tests.** `npm run test:native-chat` (`desktop/package.json:33`) is `desktop/test/native-chat-electron.cjs`, an end-to-end run against `native-chat-mock.cjs` or a lab Hermes. Unit tests are `desktop/test/native-chat.test.cjs` and `native-chat-blocks.test.cjs`. The unit tests inject a fake API through `createNativeChat({ apiFactory })` (`native-chat.cjs:43`, used at `native-chat.test.cjs:39,55,67`). That injection point is what phase 1 uses.

### The Hermes WebSocket client (already in the repo)

The Hermes gateway wire (`/api/ws`, JSON-RPC 2.0, protocol name `hermes-gateway-v1`) already has a client in the desktop app. It is not the Alan's Way row.

| Piece | What it does | Where |
|---|---|---|
| Connector | probe `/api/status`; password sign-in through RFC 8252 PKCE; refresh; single-use WS ticket; WebSocket adapter | `desktop/src/hermes-remote.cjs:1-14,170-260,264-334` |
| Wire | JSON-RPC framing, call correlation, server requests, limits (1 MiB frame, 128 pending, 30 s call timeout). Header: "no hidden retry/replay/reconnect" | `desktop/src/hermes-session-wire.cjs:1-33` |
| Conversation | bind, send, stop, answer requests, `syncFromReplay`. Header: "no reconnect or durability" | `desktop/src/hermes-conversation.cjs:1-42` |
| Hub | owns connector, wire, one controller per session; list/resume/create sessions; persists tokens | `desktop/src/hermes-hub.cjs:1-12,181-291,451-490` |
| Pane | draws hub state; states and the "Delivery unconfirmed" tombstone | `desktop/src/hermes-view.js:20-28,44-45` |

What the code already uses of the wire:

- **Used:** `gateway.ready` (reads `replay_epoch`), `gateway.capabilities`, `client.capabilities {server_requests:true}`, `session.active_list`, `session.activate`, `session.list`, `session.resume`, `session.create`, `session.events.since`, `prompt.submit`, `session.interrupt`, server requests (approval, clarify, value prompts) with `request.cancel` (`hermes-conversation.cjs:235-276,444,477`, `hermes-hub.cjs:263,276,461,477`).
- **Events:** the wire emits `{type, sessionId, seq, payload}` per event (`hermes-session-wire.cjs:375-389`).
- **Dedupe by seq:** the controller drops `seq <= lastSeq` and counts gaps (`hermes-conversation.cjs:661-675`).
- **Replay is built but not used.** `syncFromReplay()` (`hermes-conversation.cjs:581-611`) is called only by tests (`desktop/test/hermes-conversation.test.cjs:592-636`). Nothing in `src/` calls it.
- **No automatic reconnect.** On socket close the hub tears everything down and shows an error (`hermes-hub.cjs:122-159,227-237`). The pane says "Connection lost" and offers a manual reconnect (`hermes-view.js:256,304`). A controller whose wire closes goes to `disconnected`, terminal for binding (`hermes-conversation.cjs:58-63,939-955`).
- **No heartbeat.** Neither the wire nor the connector sends `gateway.ping` (no match in `hermes-session-wire.cjs`, `hermes-remote.cjs`, `hermes-hub.cjs`).
- **Ticket in the URL.** The ticket goes in `?ticket=` (`hermes-remote.cjs:253-260`) and the socket is opened with no subprotocol (`:274`).
- **No sleep/wake hook for the hub or native chat.** `powerMonitor` and `net.isOnline()` are used for the VPS mirror, the remote viewer and Telegram only (`main.cjs:3653-3667`).
- **A send that was in flight at a drop becomes `uncertain`** and is never replayed (`hermes-conversation.cjs:26-28,90-92,455-466,939-947`; tombstone at `hermes-hub.cjs:122-141`). This matches `docs/mobile-ios-plan.md:98` and `SECURITY.md:36`.
- **Which surface shows the hub pane** to a user, and how it relates to the three gateway rows, is unconfirmed. It is wired through IPC (`main.cjs:2069-2073`, `desktop/src/preload.cjs:32-33`).

What Hermes does on its side (confirmed in the installed source):

- **Handshake.** `gateway.ready` carries `replay_epoch` and `heartbeat: true` (`hermes:tui_gateway/ws.py:655-662`). Clients may call `gateway.ping`, answered `{ok:true}` (`ws.py:709-713`). The client heartbeat deadline is 45 s (`ws.py:90-93`).
- **Replay.** Every event for a session gets a per-session monotonic `seq` and lands in a ring: 512 events and 4 MiB per session (`hermes:tui_gateway/event_replay.py:30-35`). `session.events.since {session_id,last_seen}` returns `{events, latest_seq, truncated, count, epoch, open_requests}` (`hermes:tui_gateway/methods_session.py:2276-2291`). `epoch` is a per-process uuid; a Hermes restart resets `seq` (`event_replay.py:21-26`).
- **Orphan grace.** When a socket drops, its sessions are parked. After a grace window (default 20 s, `dashboard.ws_orphan_reap_grace_s`) an orphaned session is reaped; a running turn is interrupted only after 600 s without activity (`hermes:tui_gateway/server.py:128-169`, `ws.py:748-751`). The exact interplay of these two is unconfirmed. A reaped session's ring is freed (`event_replay.py:forget_session`).
- **Multiple peers.** Several sockets can attach to one live session; events fan out through bounded per-peer mailboxes, and a peer that overflows is closed so it reconnects and replays (`hermes:tui_gateway/transport.py:143-153`, `session_transports.py:1`).
- **Tickets.** The ticket is accepted as a `hermes-gateway-ticket.<ticket>` subprotocol (preferred) or `?ticket=` (`hermes:hermes_cli/web_server_boundary.py:156-173`, `web_server_chat.py:377-396`).
- **No client message id on `prompt.submit`.** `prompt.submit` takes `session_id`, `text` and a few typed extras (`hermes:tui_gateway/methods_prompt.py:842-900`) and returns `{status:"streaming", user_row_id}` (`:995`). A grep for `client_message_id`, `idempotency`, `dedupe`, `submit_id` over `tui_gateway/` finds an idempotency key only on `session.create` (`methods_session.py:338`, `server.py:117-121`). While a turn runs, a second submit is refused with error 4090 "Nothing was sent" or forwarded and queued (`methods_prompt.py:755-765`).
- **Read state.** Hermes stores one `last_read_at` watermark per session; unread means activity after it (`hermes:hermes_state_sessions.py:1071-1078`). It is set with `PATCH /api/sessions/{id}` `{unread:false}` (`hermes:gateway/platforms/api_server.py:74,1564,2661`). Native chat does not call it today.
- **HTTP run replay exists too.** `GET /v1/runs/{id}/events` honours `Last-Event-ID` / `last_seq` (`hermes:gateway/platforms/api_server_runs.py:287,1277`). Whether it works for runs started by `/api/sessions/{id}/chat/stream` (`api_server.py:3084`, which builds its own `_SessionEventQueue`) is unconfirmed.

### Network rules, benchmarks, iOS

- **Tailnet.** `HERMES_WORKSPACE_REQUIRE_TAILNET=1` makes `tailnetUrl` accept only literal Tailscale addresses (`desktop/src/tailnet.cjs:3,19-24`). `hermes-remote.cjs` applies it to every request and to the socket (`:52,68,273`). `SECURITY.md:44` documents the flag. The Hermes Webapp helper accepts `*.ts.net` HTTPS names and loopback (`tailnet.cjs:26-37`).
- **Benchmarks** (`docs/benchmarks/results/2026-11-11-chat-surfaces/results.md`, `...-after-polish/results.md`; median / p95 ms, Apple M5 Pro, loopback Hermes, fake model whose first chunk comes after 50 ms):

  | Metric | native | Hermes Desktop |
  |---|---|---|
  | First token, Enter to painted (n=10) | 141.7 / 153.6 (after polish 139.3 / 160.7) | 321.3 / 357.2 (386.1 / 434.7) |
  | `curl` floor, new / existing session | 131.1 / 157.1, 127.2 / 140.1 | (same server) |
  | Cold open, last thread from cache | 479 / 519 (539 / 568) | 907 / 960 (1,031 / 1,105) |
  | Thread switch (n=20) | 6.8 / 14.2 (9.2 / 12.6) | 61.3 / 102.3 (79.6 / 155.6) |

  Over the VM tunnel only one number exists: one `curl` request to `/api/status` took **246.5 / 760 ms** (n=10). The first turn after the Hermes gateway has been idle costs about 1.1 s extra (agent setup). In the Hermes arm benchmark, model + Hermes time is about 95% of a task's wall time, 3.3 s per turn (`docs/benchmarks/results/2026-11-19-model-arms/results.md`, "Where the time goes"). Cold open, thread switch and first token **on the VM** were not measured.
- **iOS chat today** is TDLib behind `TelegramStore` (`ios/AlanWorkspace/Telegram/TelegramStore.swift`): `sendText` hands the message to TDLib (`:257-275`), and TDLib owns retries, persistence and resume; the app only tells it about network changes (`:391-405`). There is no WebSocket or Hermes client anywhere in `ios/AlanWorkspace` (no `URLSessionWebSocketTask`). Deployment target is iOS 17.0 (`ios/project.yml:5`). The Keychain wrapper stores Telegram secrets as `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` under service `com.hermescompanion.telegram` (`TelegramKeychain.swift:5-8,72`). The existing viewer URL must be `https` (`ios/AlanWorkspace/Support/WorkspaceSettings.swift:4-12`). A private tailnet URL needs Tailscale connected on the phone first (`ios/README.md:100`). `Info.plist` has no App Transport Security exception.

## 1. Goals and non-goals

**Goal.** The fastest and most reliable way to talk to a Hermes agent that runs on a VM, from a laptop or phone on a bad network.

**Goals, in order:**

1. A reply that is already streaming survives a dropped connection: nothing lost, nothing doubled.
2. A message typed offline or on a dead link is never lost and never sent twice.
3. First token as fast as the best existing surface, plus one network round trip.
4. Two devices can watch and answer the same conversation.
5. Reuse the Hermes wire; add as little as possible.

**Non-goals:**

- Replacing Telegram. It stays a row and the iOS chat.
- A hosted cloud service in the first version. The only server is the user's own Hermes.
- Android.
- No new agent features, no new message types, no attachments or voice in this spec.
- No change to Hermes itself in phases 1 to 3, except two requests listed in the open questions.
- No end-to-end encryption design; the tailnet already encrypts.

## 2. Architecture

### What runs where

| Place | Runs | New by us |
|---|---|---|
| VM | Hermes (`hermes serve`: `/api/ws`, REST, auth routes), the agent, the session DB | Nothing in phases 1 to 3. Phase 4 adds a relay (sketch only). |
| Desktop (Electron main process) | Link supervisor, outbox, wire + auth (existing), adapter into native chat, projected state to the renderer | `gateway-link.cjs`, `gateway-outbox.cjs`, `gateway-api.cjs` |
| Desktop (renderer) | Draws state, banner, message states. No sockets, no credentials. | small additions to `native-chat.js` |
| Phone (SwiftUI) | Same four parts in Swift: wire client, auth, outbox, store, view | `ios/AlanWorkspace/Gateway/` |

### Reused unchanged from the Hermes wire

JSON-RPC 2.0 over WebSocket, subprotocol `hermes-gateway-v1`. `gateway.ready` and `replay_epoch`. `gateway.ping`. `gateway.capabilities`, `client.capabilities`. `session.list`, `session.active_list`, `session.create`, `session.resume`, `session.activate`. `session.events.since` and its `epoch`/`truncated`/`open_requests`. `prompt.submit`, `session.interrupt`. Events `message.start`, `message.delta`, `message.complete`, `tool.start`, `tool.complete`, `status.update`, `request.cancel`, `session.reclaimed` (all seen in `hermes:tui_gateway/`; the client-side handling is `hermes-conversation.cjs:628-720`). Server requests for approval and clarify. Single-use ticket auth. Per-session `seq` as the event id. Read state through `last_read_at`.

### The thin layer we add (client side only)

| Part | Job | Why the wire cannot do it |
|---|---|---|
| Link supervisor | One socket per account: connect, ping, detect dead links, back off, reconnect, re-attach sessions, replay from `lastSeq`, fall back to history | The wire and controller are deliberately one-shot (`hermes-session-wire.cjs:1-21`, `hermes-conversation.cjs:1-6`) |
| Outbox | Persist each message with a client id; submit in order; resolve in-doubt sends by reading the transcript | `prompt.submit` has no client id and no dedupe |
| Device id + label | Name this install for "answered on" text and for phase 3 | Hermes has no device concept |
| Adapter (`gateway-api.cjs`) | Presents the existing `createHermesApi` shape to `createNativeChat` and maps wire events to the SSE event names native chat already handles | Keeps the renderer, cache, markdown and tests |

Event mapping for the adapter: `message.start` to `message.started`; `message.delta` to `assistant.delta`; `message.complete` to `assistant.completed` + `run.completed`; `tool.start`/`tool.complete` to `tool.started`/`tool.completed`; approval and clarify server requests to `approval.request` and the clarify card (this removes the 1 s clarify poll, `native-chat.cjs:185-201`). The existing names are in `native-chat.cjs:203-232`.

### Where the Hermes wire is not enough

| Gap | Effect | Our answer | Needs Hermes? |
|---|---|---|---|
| No client id on `prompt.submit` | A send in doubt cannot be proved sent or not | Resolve by transcript match; ask the user if still ambiguous (section 3) | Request `client_message_id` upstream (Q4) |
| Replay window is short: 20 s orphan grace, 512 events / 4 MiB, process-local `epoch` | Replay only covers short drops. A longer drop, a laptop sleep or a Hermes restart needs a history reload | Detect with `truncated`, `epoch` change, or session missing from `session.active_list`; reload with `session.resume` (`hermes-hub.cjs:451-470`) | Raising `dashboard.ws_orphan_reap_grace_s` is a VM config choice (Q3) |
| `session.activate` has no event cursor (`hermes-conversation.cjs:266-269`) | A device joining mid-stream cannot place the snapshot exactly | Mark the overlap, then reconcile against `session.events.since` (phase 3) | Unconfirmed whether a cursor can be added |
| Read state is a time per session, not per device or message | No per-device unread position | Use it as is | No |
| Only reachable over the tailnet | No phone path off the tailnet, no push | Later phases (section 6) | No |

### One transport decision

Alan's Way moves from REST+SSE to the WebSocket wire in phase 1, behind the adapter. REST stays for session lists, older history pages and the read-state `PATCH`. The SSE path stays as a fallback behind a setting for one release. Reason: replay, `open_requests`, heartbeat and server requests exist only on the WebSocket wire. Alternative considered: `GET /v1/runs/{id}/events` with `Last-Event-ID`. It gives per-run replay but no epoch, no open requests and no heartbeat, and its fit with `chat/stream` runs is unconfirmed.

The hub and `HermesConversation` stay as the reference for event application and answer validation; the link supervisor wraps them rather than rewriting them (small change in phase 1: a controller can start with a given `{epoch, lastSeq}`).

## 3. Reliability design

### Link states

| Link state | Meaning | Banner | Composer |
|---|---|---|---|
| `live` | socket up, sessions bound, replay applied | none | sends now |
| `reconnecting` | socket lost, attempt in progress | "Reconnecting…" after 3 s (no flicker for short blips) | queues |
| `offline` | no network path | "Offline. N waiting to send" | queues |
| `syncing` | socket up, replay or history reload running | "Catching up…" | queues |
| `signin` | refresh token rejected | "Sign in again" (queue kept) | queues |
| `gap` | replay was truncated or epoch changed; history reloaded | one-time note under the reply: "Part of this reply was missed and was reloaded from history" | sends now |

### Resume after a drop

1. Socket dies: `close` event, a missed ping, resume from sleep, or a network path change. Keep every controller's transcript and `lastSeq`; do not dispose them (today's teardown wipes them: `hermes-hub.cjs:122-159`). Mark the link `reconnecting`.
2. Reconnect (backoff below): mint a ticket, open the socket with the ticket as subprotocol, wait for `gateway.ready`, read `replay_epoch`.
3. **Epoch differs** from the stored one: Hermes restarted. Every runtime session and `seq` is gone. Discard watermarks. For each open conversation call `session.resume` by stored id and replace the transcript with the history. If a reply was streaming and history has no final assistant row, show it as interrupted. State `gap`.
4. **Same epoch:** call `session.active_list`. If the session is still listed, `session.activate` and then `session.events.since {last_seen: lastSeq}`. Apply events in `seq` order (the controller already skips `seq <= lastSeq`, `hermes-conversation.cjs:661-675`) and merge `open_requests` (`:581-611`). If `truncated: true`, or the session is no longer listed (reaped after the 20 s grace), go to step 3's history path. State `gap` for `truncated`.
5. Re-evaluate the outbox (below). State `live`.

Invariant: `lastSeq` only moves forward, and only after the event is applied. Replay and live frames can overlap; the `seq` check makes that safe.

### Offline send queue and idempotent ids

- Every message gets a `cmid` (UUIDv7) at the moment the user presses send. The outbox record is `{cmid, sessionKey, text, createdAt, state, attempts, userRowId?}`, written to disk (atomic, 0600, like `writePrivateJson`, `shell-support.cjs:17-25`) before anything is sent.
- The outbox submits per session in FIFO order, one `prompt.submit` at a time, and waits for the previous turn to complete before the next (today's rule, `native-chat.cjs:313`; it also avoids Hermes's 4090 busy refusal).
- A failed head blocks the queue behind it. A later message must never overtake an earlier one that the user has not decided on.

What the layer can and cannot promise, given there is no id on the wire:

| Situation when the link died | What we know | Action |
|---|---|---|
| Never written (still `queued`) | Not sent | Send after reconnect |
| Wire reported a definite reject (`DEFINITE_REJECT`, `hermes-conversation.cjs:90-92`) | Not admitted | `failed`, user can Retry |
| Written, no ack (`uncertain`, `:455-466`) | May or may not have arrived | `checking`: after reattach, fetch the last stored rows and match a user row with the same text and a time at or after the send time minus 60 s (the same rule as `native-chat.cjs:147`), take the earliest row not already matched to another outbox item. Match: `sent`, store `userRowId`. No match after a second read 2 x RTT later (min 1 s): treat as not sent, send again. |
| Same text sent twice inside the match window | Cannot tell which is which | Ask: "Did the second one arrive?" with Send again / It arrived. Never auto-resend. |

Residual risk, stated plainly: the old socket's last bytes could reach Hermes just after the transcript read, so one resend in a rare race can duplicate. It closes fully only with a server-side `client_message_id` (Q4). Until then the guarantee is *at most one automatic submit per message plus transcript-resolved doubt*, not exactly-once. This is the same honesty rule the repo already holds (`SECURITY.md:36`, `docs/mobile-ios-plan.md:98`).

### What the user sees per message

| State | When | Label / affordance | Moves to |
|---|---|---|---|
| `queued` | not yet written: offline, link not `live`, or waiting for the previous turn | "Waiting to send" + Cancel | `sending` |
| `sending` | `prompt.submit` written, no result yet | "Sending…" (as `hermes-view.js:44`) | `sent`, `checking`, `failed` |
| `sent` | result `status: streaming` received | no label | |
| `checking` | link died with a send in doubt; resolving | "Checking…" (at most about 10 s) | `sent`, `queued`, or the ask card |
| `failed` | definite reject, user stopped it, or the queue time limit passed (Q5) | "Not sent" + Retry + Edit | `queued` on Retry |

`sending` on screen for more than 8 s without a result is treated as in doubt, so a half-open link cannot show "Sending…" forever.

Replies: `streaming`, `waiting` (an approval or question is open), `done`, `interrupted` (user pressed Stop), `incomplete` (reply cut and the gap not closed). These reuse the existing `SEND_STATUS` names (`hermes-view.js:44-45`).

### Reconnect backoff and liveness

| Setting | Value (start values, tuned by the harness) |
|---|---|
| Delay | 0.5 s x 2^n with full jitter, cap 15 s; reset after 30 s of a stable `live` |
| Immediate attempt (skip the wait) | network path becomes available, resume from sleep, window regains focus after more than 15 s, user presses Retry |
| One attempt at a time | yes; a new trigger cancels the wait, not a running attempt |
| Connect timeout | 8 s (today 15 s: `hermes-remote.cjs:264`, `hermes-hub.cjs:248-251`) |
| Ping | `gateway.ping` after 10 s of silence, dead after 4 s without an answer. Under Hermes's 45 s deadline (`ws.py:90-93`) |
| Auth failure | refresh token rejected: `signin`, stop retrying. A 4401 ticket error: mint a fresh ticket once, then `signin` |

### Laptop sleep, wake, network change

| Event | Behaviour |
|---|---|
| `powerMonitor` `suspend` | flush outbox and `lastSeq` to disk; mark `suspended` (not a failure); close the socket |
| `resume` | assume the socket is dead (it is usually half-open); reconnect at once if the network is up, else `offline` until `net.isOnline()` is true. Poll every 1 s while offline (today 3 s, `main.cjs:3659-3665`). |
| Wake after more than 20 s | expect the session to be reaped; the history path (step 3) is the normal route, not an error |
| Wi-Fi to Wi-Fi, VPN or Tailscale toggle, IP change | treat as a drop even if the socket looks alive; the ping confirms within 4 s |
| iOS foreground | reconnect and resume on `scenePhase == .active`; no keep-alive in the background (phase 3) |

## 4. Speed design

### Where a first token goes

Warm path: the socket is open and the session is attached. RT is one network round trip, measured by the ping.

| Step | Today (native, REST+SSE) | Gateway target | Evidence |
|---|---|---|---|
| Keypress to request written | one new HTTP request per send, new connection unless the agent keeps it alive (unconfirmed, `hermes-api.cjs:85-96`) | one frame on the open socket, no handshake | code |
| Network out | 0.5 RT, plus connect/TLS if not kept alive | 0.5 RT | |
| Hermes admits the prompt | about 70 ms (derived: 127 ms `curl` floor minus 50 ms fake-model first chunk minus about 8 ms `curl` spawn) | the same, not ours | results.md, first-token floor |
| Model first chunk | 50 ms in the bench; real turns about 3.3 s | not ours | model-arms results |
| Network back | 0.5 RT | 0.5 RT | |
| Parse and paint | 10.6 ms over the floor in total (native) | 10 ms or less; renderer pushes are coalesced to one per frame (`main.cjs:3825-3827`) | results.md |

Cold path, to a live attached session, as the code is ordered today (derived from the code, not measured): probe `/api/status`, refresh token, ticket, WebSocket upgrade, wait for `gateway.ready` (`hermes-hub.cjs:186-254`), then five sequential calls: `gateway.capabilities`, `client.capabilities`, `session.active_list`, `session.activate`, `session.events.since` (`hermes-conversation.cjs:235-276`). That is about 9 sequential exchanges. At one request costing 246.5 ms (the only VM figure) it is roughly 2.2 s at the median, and 6.8 s if every one hits the 760 ms p95.

Target cold path, 4 exchanges: skip the probe when `auth_required` is cached; skip the refresh when the stored access token is unexpired (`expiresAt`, `hermes-remote.cjs:233-238`); mint a ticket (1); open the socket (2); send `gateway.capabilities`, `client.capabilities` and `session.active_list` together (3) (the wire allows concurrent calls, `hermes-session-wire.cjs:29,113`); send `session.activate` and `session.events.since` together (4). The overlap rule in `hermes-conversation.cjs:266-272` must be re-checked for the pipelined form; that check is part of phase 1.

### Warm connection

- One socket per account, opened at app start and kept for the app's life, not per conversation or per send.
- Attach the active conversation and the few most recent; attach others lazily on open.
- Painting never waits for the network: the last thread paints from the disk cache first (`native-chat.cjs:63-77`), as it does today.
- Prewarm the agent: Hermes's first turn after idle costs about 1.1 s. `session.activate` after the thread opens may build it; whether it does is unconfirmed (`hermes-hub.cjs:459-461` calls resume "lazy"). Phase 1 measures the first turn after activate against the first turn after idle and keeps the activate call only if it moves the number.

### Streamed vs fetched

| Streamed on the socket | Fetched on demand over REST or RPC |
|---|---|
| `message.delta` and `message.complete`, `tool.start`/`tool.complete`, `status.update`, server requests and `request.cancel`, session change events | session list (on attach and on a session-changed event), older history pages (500 rows, `native-chat.cjs:12`), the full transcript after a `gap`, read-state `PATCH` |

### Numbers to beat

Median / p95, nearest-rank, in the same harness and conditions as the chat-surfaces benchmark (loopback, fake model, n >= 10 after a discarded warm-up). The remote rows use the network-drop harness with an injected round trip, because the VM has no benchmark yet.

| Metric | Best today | Gateway must be |
|---|---|---|
| Warm first token, loopback | native 141.7 / 153.6 (139.3 / 160.7 after polish) | 152 / 164 or better (native + 10 ms) |
| Warm first token, remote | not measured; one VM request 246.5 / 760 | RT + 150 / RT + 190, where RT is the ping in the same run |
| Cold open from cache | 539 / 568 | no worse; network never on the path |
| Thread switch | 9.2 / 12.6 | 12 / 15 or better |
| Cold attach, to bound | about 9 exchanges (derived) | 4 exchanges |
| Reconnect, network back to `live` | manual button, no number | 4 exchanges + 100 ms; at injected 100 ms RT: 500 ms p95 |
| Dead-link detection (half-open) | none; waits for the OS (unconfirmed) | 14 s or less |
| Lost events after a drop within the grace window | the reply is lost ("may be incomplete") | 0 |
| Duplicate user messages after any single drop | possible (see Today) | 0 for definite cases; doubt cases go through the ask card |

A first VM baseline (one warm WebSocket round trip and one first token, 10 runs) is the first deliverable of phase 1; the remote targets are re-based on it. That run needs the owner's go-ahead because it uses the real VM.

## 5. Multi-device

**Attach.** A second device signs in, gets its own ticket, opens its own socket, finds the runtime session in `session.active_list` and calls `session.activate`. Events fan out to every attached socket (`hermes:tui_gateway/transport.py:143-153`). A device that falls behind is closed by Hermes and recovers through the same replay path as phase 1. If the session is not live, `session.resume` makes it live for that device.

**Joining mid-stream.** Activate returns the history and an `inflight` snapshot. The controller marks overlap as "needs review" (`hermes-conversation.cjs:647-651`) because the snapshot has no event cursor (`:266-269`). Phase 3 must show a device joining mid-reply with no duplicate and no hole. Plan: after activate, run `session.events.since` from 0 and drop events whose text is already in the snapshot. A cursor on the snapshot would be cleaner; unconfirmed.

**Read position.** Use Hermes's `last_read_at` as is. A device that shows a thread, focused and at the bottom, sends `PATCH /api/sessions/{id} {unread:false}` after a 1 s pause. Other devices clear their unread dot when the session-change event arrives; that the event fires on a read change is unconfirmed (`last_read_at` is in the watched field list, `hermes:tui_gateway/change_watcher.py:198`). It is per session and a time, not a message id and not per device. Per-message, per-device position is not in v1.

**Approvals.**

| Question | Rule |
|---|---|
| Who may answer | Any attached device that declared `server_requests` |
| Who wins | First valid answer. Hermes drops answers to a request that is no longer open and sends `request.cancel` (`hermes:tui_gateway/server_requests.py:1-25`) |
| What the others show | The card closes with "Answered on another device" (from `request.cancel` or an `expired` answer, `methods_prompt.py:1314`) |
| Which device is nudged | The device with the window focused. No push until phase 4. |
| Safety | Same on every device: full command shown; "Always allow" asks for a second tap |
| Unconfirmed | Whether Hermes delivers a request to all attached peers or only one. Phase 3 tests this against a lab Hermes with two live sockets. |

**Two devices sending.** The second `prompt.submit` during a running turn is refused with 4090 or queued by Hermes (`methods_prompt.py:755-765`). The outbox treats it as "wait for the turn", not as `failed`.

## 6. Reaching the VM

**Now: tailnet.** The gateway client accepts these addresses and nothing else:

| Address | Scheme | Notes |
|---|---|---|
| loopback (SSH tunnel or a local Hermes) | `http`/`ws` | as native chat today (`hermes-api.cjs:15-24`) |
| `<machine>.<tailnet>.ts.net` | `https`/`wss` | certificate-bound; `tailnet.cjs:26-29` gives this as the reason for the Webapp view |
| literal Tailscale address (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`) | `ws` | allowed under `tailnet.cjs:6-12`; TLS to a bare IP cannot be verified, so only when strict tailnet mode is on |

The check runs at configure time and on every connect (`hermes-remote.cjs:68,273`). Today the two desktop clients disagree on the rule (Today, "Address rule"); the gateway uses this one table. On iOS, Tailscale must be connected on the phone (`ios/README.md:100`). Whether App Transport Security allows `ws://` to a literal `100.x` address with no exception in `Info.plist` is unconfirmed; the safe path is the `.ts.net` `wss` name. Verify on a device in phase 3.

**Later (sketch only, not designed here):**

| Phase | Idea | What it must answer before it is built |
|---|---|---|
| 4a Relay | A small always-on service the VM connects out to, so a phone off the tailnet can reach the agent without an open inbound port. Same wire, same tickets. It stores a longer event log, so replay works after hours offline (Hermes keeps 20 s and 512 events). | Who runs it; public auth; abuse limits; retention; what it can see |
| 4b Push | APNs push when no device is attached and an approval or a finished reply arrives. Payload has no message text by default. | Who holds the APNs key; opt-in per conversation |

Neither is in phases 1 to 3.

## 7. Security

| Topic | Rule |
|---|---|
| Auth | Password sign-in with PKCE, refresh token, single-use ticket (30 s TTL, `hermes-remote.cjs:249`). Reuse `hermes-remote.cjs:170-260`. Whether the VM's existing Webapp sign-in mints WS tickets for this client is unconfirmed (Q1). |
| Ticket transport | Send as the `hermes-gateway-ticket.<ticket>` subprotocol next to `hermes-gateway-v1`, not as `?ticket=` (change at `hermes-remote.cjs:253-260,274`). The server accepts both and never reflects the ticket (`hermes:hermes_cli/web_server_chat.py:377-396`). |
| Desktop storage | Refresh and access tokens sealed with `safeStorage`; memory only when no keychain (`main.cjs:3772-3781`). The outbox and the message cache hold message text in a 0600 private file in the app data folder, like the existing cache (`native-chat.cjs:79-89`). Sent entries are deleted. |
| iOS storage | Keychain generic password, new service name for the gateway, `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` (same as `TelegramKeychain.swift:72`), never iCloud. Outbox in the app container with file protection `completeUnlessOpen`. |
| Never logged | Passwords, codes, access/refresh tokens, tickets, the API key, any URL with a query, message text, approval commands, tool arguments or results, outbox contents. Logs may carry: state changes, error codes, `seq` numbers, timings, truncated session ids. Phase 1 adds a canary test: put canary strings in a token and a message, run the harness, assert none appears in the app log. |
| Origin | All gateway code runs in the Electron main process or in Swift, never in a page, so no browser `Origin` is ever sent. What Hermes does with a WebSocket that has no `Origin` is unconfirmed; the existing fake backend accepts it (`desktop/test/hermes-auth-fake-backend.cjs:110-131`). Phase 1 checks it against the real Hermes. |
| TLS | `wss`/`https` use default verification. No `rejectUnauthorized:false`, no redirects followed. Certificate pinning is not in v1. |
| Limits | Keep the wire limits: 1 MiB per frame, 2 MiB buffered, 128 pending calls (`hermes-session-wire.cjs:26-33`). Cap the outbox at 200 messages and 1 MiB of text. |
| Approvals | Answers go through the controller's schema check (`hermes-conversation.cjs:543-577`) on every device. |
| Sign-out | Clears tokens and the device id's session. Unsent outbox items are kept and the user is asked whether to keep or delete them. |

## 8. Phased delivery

### Phase 1: resume after reconnect (desktop)

**Scope**
- Link supervisor: reconnect with backoff, ping, power and network triggers, resume as in section 3, states and banner.
- WebSocket transport for Alan's Way through the adapter; REST for lists and history; SSE kept as a setting.
- Subprotocol ticket; 8 s connect timeout; cached `auth_required`; pipelined bind.
- First VM baseline (needs owner go-ahead).
- Settings: gateway address and sign-in (reuses the hub's `configure` and `sign-in` commands and the `hermes-gateway.json` store).

**Files**
- new: `desktop/src/gateway-link.cjs`, `desktop/src/gateway-api.cjs`
- edit: `desktop/src/hermes-remote.cjs` (subprotocol, timeouts), `desktop/src/hermes-hub.cjs` (close handler hands over to the link instead of tearing down, `:227-237`), `desktop/src/hermes-conversation.cjs` (accept `{epoch, lastSeq}` at construction), `desktop/src/native-chat.cjs` (link state in `getState`, `gap` notice), `desktop/src/native-chat.js` (banner), `desktop/src/main.cjs` (suspend/resume and `net.isOnline` hooks beside `:3653-3667`; settings plumbing)

**Tests**
- `desktop/test/gateway-link.test.cjs`: unit tests with a fake wire: backoff sequence, immediate triggers, ping timeout, epoch change, `truncated`, session reaped, duplicate and out-of-order replay.
- Extend `desktop/test/hermes-auth-fake-backend.cjs`: today `session.events.since` always returns no events (`:100-101`). Give it a real ring with `seq`, an epoch switch, `gateway.ping`, and the 20 s grace.
- **Network-drop harness** `desktop/test/gateway-netdrop.cjs`, script `test:gateway-drop` in `desktop/package.json`. A small TCP proxy (`node:net`) sits between the client and the fake backend and can: reset the connection, blackhole it (stop forwarding but keep it open, which is the half-open case), add fixed delay and jitter, and flap.

  | Metric | How it is measured |
  |---|---|
  | Time to first token | key event to first painted delta, as in `chat-surfaces-bench.cjs` |
  | Reconnect time | from "path restored" (proxy accepts again) to link `live` with replay applied |
  | Message loss | server-side ring contents versus events applied by the client; for text, final text equals the server's final text |
  | Duplicates | events applied twice; `prompt.submit` calls per `cmid` seen by the fake server |
  | Detection time | blackhole start to link `reconnecting` |

  | Scenario | Pass |
  |---|---|
  | reset mid-reply, within grace, 100 runs | 0 lost, 0 duplicate, reconnect 500 ms p95 at injected 100 ms RT |
  | blackhole 30 s mid-reply | detected in 14 s or less; after heal, 0 lost if within grace, else `gap` with history |
  | Hermes restart (epoch change) | no stale watermark used; transcript equals history |
  | 25 s suspend then resume | history path taken, no error banner |
  | flap 20 times in 60 s | one attempt at a time; at most 1 socket open at any instant |
  | warm first token at injected 0 and 100 ms RT | within the table in section 4 |
- `npm run test:native-chat` and `desktop/test/native-chat.test.cjs` stay green (the adapter keeps the `apiFactory` shape).
- Log canary test (section 7).

**Explicitly out:** the outbox (while the link is not `live`, a send fails as it does today: the row turns `failed` with "That message was not sent.", `native-chat.cjs:238-243`), second device, iOS, any Hermes change, relay, push.

### Phase 2: offline send queue

**Scope.** Outbox with `cmid`, disk persistence, FIFO per session, the five message states, transcript resolution for doubt, the ask card, queue time limit.

**Files**
- new: `desktop/src/gateway-outbox.cjs`
- edit: `desktop/src/gateway-api.cjs` (send goes through the outbox), `desktop/src/native-chat.cjs` (local row states `queued` and `checking`; replace `retry`, `:324-332`), `desktop/src/native-chat.js` (labels, Cancel, Retry, ask card), `desktop/src/shell-support.cjs` (reuse `writePrivateJson`, no change expected)

**Tests**
- Unit: state machine; restart with a non-empty outbox; match rule with equal texts; head-of-line blocking; size caps.
- Harness scenarios (fake server models Hermes: no dedupe; it logs every `prompt.submit` with its `cmid`):

  | Scenario | Pass |
  |---|---|
  | cut at each of 5 points (before write, written no ack, acked before first event, mid-stream, after complete), 200 seeded runs each | 0 duplicates in definite cases; every doubt case ends `sent`, auto-resent, or in the ask card; 0 lost |
  | 20 messages typed offline for 60 s, then reconnect | all 20 delivered once, in order |
  | app quit and relaunch with queued messages | delivered after sign-in, once |
  | queue time limit | message marked `failed`, not silently dropped, not sent |
  | doubt race (old socket's bytes arrive after the read) | recorded as a measured residual rate, expected near 0; closes with Q4 |

**Explicitly out:** cross-device queue, editing a queued message beyond Cancel and Edit-after-fail, attachments, any Hermes change unless Q4 is yes.

### Phase 3: second device and the iOS client

**Scope.** Desktop: device id and label; attach as an additional socket; read-state `PATCH`; approval card behaviour from section 5; mid-stream join. iOS: a gateway client beside Telegram.

What an iOS gateway client needs (none of it exists in the app, per Today):

| Need | iOS piece |
|---|---|
| WebSocket with subprotocol | `URLSession.webSocketTask(with:protocols:)`, wire rules ported from `hermes-session-wire.cjs` (framing, ids, server requests, limits) |
| Sign-in, PKCE, tickets | Swift port of `hermes-remote.cjs:170-260` |
| Secrets | Keychain wrapper like `TelegramKeychain.swift`, new service name |
| Network changes | `NWPathMonitor` as in `TelegramStore.swift:391-405`, plus `scenePhase` for foreground resume |
| Outbox | file-backed, same record and rules as desktop. TDLib gives Telegram this for free; the gateway must do it itself |
| Store and view | an `@Observable` store like `TelegramStore`, a chat view in `ios/AlanWorkspace/Views/` |
| Reachability | Tailscale connected on the phone; `.ts.net` `wss` name preferred (ATS question in section 6) |

**Files**
- desktop: `desktop/src/gateway-link.cjs` (observer attach), `desktop/src/hermes-api.cjs` (add the read-state `PATCH`), `desktop/src/hermes-conversation.cjs` (mid-stream reconcile)
- iOS, new: `ios/AlanWorkspace/Gateway/{GatewayWire,GatewayAuth,GatewayKeychain,GatewayOutbox,GatewayStore}.swift`, `ios/AlanWorkspace/Views/GatewayChatView.swift`; `ios/project.yml` only if a source group is needed
- shared wire fixtures: `desktop/test/fixtures/gateway-wire/*.json`, consumed by node tests and Swift tests

**Tests**
- Two-socket harness: a second client in the node harness; device B joins mid-reply (0 duplicate, 0 hole), B answers an approval A also sees (first wins, A's card closes), both send during a turn (second waits, no `failed`), B falls behind and is closed by Hermes and recovers. Run once against a lab Hermes to settle the two unconfirmed delivery questions.
- iOS unit tests in `ios/AlanWorkspaceTests/` (`GatewayWireTests`, `GatewayOutboxTests`) over the shared fixtures.
- On-device checklist, real iPhone: airplane mode on and off mid-reply; Wi-Fi to cellular; lock and unlock; Tailscale off and on; 20 queued messages. Record the harness metrics in the same table.

**Explicitly out:** push, background sockets, relay, attachments, voice calls through the gateway, replacing Telegram on iOS, Android.

### Phase 4: relay and push (later, sketch only)

**Scope.** As sketched in section 6. Entry gate: phases 1 to 3 meet their numbers, and the owner confirms off-tailnet access is wanted.

**Files and tests.** Not specified. They are written when this phase is approved.

**Explicitly out of this spec:** everything in it.

## 9. Open questions for the owner

One line each; the recommendation is the first answer.

| # | Question | Recommended answer |
|---|---|---|
| 1 | Which credential does the gateway use: Hermes password sign-in with a WebSocket ticket, or the existing API key? | Sign-in and ticket; replay and heartbeat exist only on that path. Needs a check that the VM's sign-in also mints tickets for us. |
| 2 | Does Alan's Way move to the WebSocket in phase 1, with SSE as a one-release fallback? | Yes. |
| 3 | May we set `dashboard.ws_orphan_reap_grace_s` from 20 s to 300 s on the VM? | Yes; a 5 minute replay window, at the cost of a parked worker for 5 minutes after each drop. |
| 4 | Will you ask Hermes upstream for a `client_message_id` on `prompt.submit`? | Yes; until then doubt cases ask the user instead of resending. |
| 5 | How long may a queued message wait before it is marked "Not sent"? | 30 minutes; an old instruction should not run hours late. |
| 6 | Which addresses does the gateway accept: loopback, `.ts.net` HTTPS, literal tailnet IP? | All three, as in section 6, literal IP only in strict tailnet mode. |
| 7 | On iOS, is the gateway an extra tab beside Telegram or the default chat? | Extra tab; Telegram stays. |
| 8 | May a phone answer approvals before push exists? | Yes, with the full command shown and a second tap for "Always allow". |
| 9 | Is Hermes's per-session read time enough for read sync in v1? | Yes. |
| 10 | May the app write timing marks (first token, reconnect, drops) to a local file, never uploaded? | Yes; it feeds the harness numbers and phase 4's decision. |
| 11 | May phase 1 take a first baseline on the real VM (10 warm round trips and 10 first tokens)? | Yes; it touches Alan's VM, which earlier benchmark runs were not allowed to do. |

## Unconfirmed, in one place

First VM check, 2026-11-19: `docs/benchmarks/results/2026-11-19-gateway-vm/results.md` (Hermes Agent 0.23.0, source commit `2bd378ed1b`; 36 prompts).

**Confirmed against the real VM**

- The VM's Hermes is not the checkout this spec was written from (`ae2a81ccc00`, 2026-11-16): it is 0.23.0 at `2bd378ed1b` (2026-11-05). Everything tested on the wire matched.
- The WebSocket is reached through the dashboard (`/api/ws`) at the Tailscale Serve HTTPS name. The dashboard refuses any other Host (`400 Invalid Host header` for the tailnet IP), and the REST API server (`8642`) is loopback-only, reachable only by an SSH tunnel. Under `HERMES_WORKSPACE_REQUIRE_TAILNET=1` the app's own rule rejects the one address that works (client bug 1 in the results).
- The VM's password sign-in mints WebSocket tickets for a non-browser client (`signIn` PKCE, `/api/auth/ws-ticket`, single use, 30 s). Both `?ticket=` and the `hermes-gateway-ticket.<t>` subprotocol are accepted.
- A WebSocket with no `Origin` header is accepted (Node's `WebSocket` sends none).
- `session.resume` (`lazy:true`) works for a session created over REST; pipelined `activate` + `events.since` is answered in order, and the server dispatches a socket's RPCs one at a time in arrival order.
- The HTTP client keeps connections alive between sends (55 ms vs 110 ms for a new connection).
- Replay after a drop works: 10 drops mid-reply, 0 lost, 0 duplicated, text equal to history, one stored user row each.
- The live orphan grace is **20 s**: `ws_orphan_reap_grace_s: 300` is in the config file but read only at start, and the dashboard started before it was edited. A restart of the dashboard is needed for Q3 to take effect. A running turn is not interrupted while its activity is fresher than 600 s (source; not exercised live).
- A server request (clarify) is delivered to **all** attached sockets (2 of 2). Answering from one sends no `request.cancel` to the others; they see `tool.complete`. The spec's "closes with Answered on another device" needs that event, or a client-side rule, not `request.cancel`.
- Approval request shape (source; `approvals.mode` is `off` on the VM so none was provoked): `command`, `description`, `choices`, `request_id` in params, answer `{choice}`. Clarify shape (live): `questions[{qid, question, choices, multi_select}]`, answer `{answers:{qid: text}}`.
- This VM's config streams no reply text on either transport (no `message.delta`), only `thinking.delta` on the WebSocket: first token equals the whole reply.
- Measured: round trip 55 ms; warm submit-to-admitted RT + 18 / RT + 44 (target RT + 150 / + 190); cold connect + attach 694 / 1,348 ms; reconnect 723 / 914 ms (graceful close, `wss`) and 366 / 411 ms (reset, plain HTTP tunnel).

**Still unconfirmed**

- How the hub pane relates to the three gateway rows in the current UI.
- Whether `/v1/runs/{id}/events` works for `chat/stream` runs.
- Whether a read change emits a session-change event.
- Whether `session.activate` already enters its agent build (prewarm), and whether a cursor can be added to its snapshot. The first turn of a new session took about 8.4-8.7 s on both transports (n=1 each).
- Dead-link detection of a half-open connection, laptop sleep, and a Hermes restart (epoch change) against the real server.
- A real approval request (the VM has approvals off) and `request.cancel` timing on a second device.
- Token streaming (`message.delta` through the adapter) against a server that streams.
- Whether App Transport Security blocks `ws://` to a literal tailnet address on iOS.
- Every number marked "derived" above except those replaced by the measurements listed under Confirmed.

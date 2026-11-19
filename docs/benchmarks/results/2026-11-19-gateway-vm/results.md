Transport check and speed baseline of the app's two native chat transports against the **real remote Hermes on the agent VM** (Hermes Agent 0.23.0, reached over the tailnet from this Mac). Median / p95 in ms, nearest rank, n = 10 unless stated. Raw data: `results.json`. Script: `desktop/test/bench/gateway-vm-bench.cjs` (reads every credential from the environment). Setup details: `meta.json`.

Run on 2026-11-19, Apple M5 Pro, Node v26.7.0, repo at `121b795` plus this branch. 36 of the 40 allowed prompts were spent. Every session created was deleted (list at the end).

## What the VM exposes

| Question | Answer (live unless marked "source") |
|---|---|
| Listening | Everything Hermes is on loopback: dashboard `127.0.0.1:9119` (has `/api/ws`), REST API server `127.0.0.1:8642` (`/api/sessions/*`, SSE), a second listener `9120`. Nothing Hermes listens on the tailnet address itself |
| How the tailnet reaches it | Tailscale Serve proxies `https://<machine>.ts.net` to the dashboard `9119`. Raw TCP to `<tailnet-ip>:9119` is also forwarded, but the dashboard answers it **`400 Invalid Host header`** (it only accepts the bound or configured public hostname, `dashboard.public_url`). The REST API server (`8642`) is **not** exposed on the tailnet (Serve's `8443` points at another service): the only way to run REST+SSE is an SSH tunnel, as `docs/native-chat.md` documents |
| WebSocket | `/api/ws` exists on the dashboard, `wss://<machine>.ts.net/api/ws` works |
| Sign-in | Dashboard auth is on (`auth_required: true`, flows `cookie`, `native_pkce`, providers `basic`, `session-token`). The app's own password sign-in (`hermes-remote.signIn`, PKCE) works: 355 ms, access token valid 12 h, refresh token returned. A single-use WS ticket costs 62 ms; reusing a ticket is rejected. REST uses the separate static `API_SERVER_KEY` |
| Ticket transport | Both work live: `?ticket=` (what the app sends today) and the `hermes-gateway-ticket.<t>` subprotocol with `hermes-gateway-v1`; the server then selects `hermes-gateway-v1` and never echoes the ticket |
| `Origin` | Not needed. Node's `WebSocket` sends none (checked against a local server) and the real server accepted it |
| Tailnet rule in the app | **Conflict**, see client bug 1: with `HERMES_WORKSPACE_REQUIRE_TAILNET=1` the app refuses the only address that works (`.ts.net` name) and accepts the literal IP the server refuses |
| `session.resume` for a REST-created session | Works (`lazy:true`). It returns `session_id` (runtime id) and `session_key` = the stored id; the session then appears in `session.active_list` with `session_key` equal to the stored id |
| Pipelined `session.activate` + `session.events.since` | Both answered, in order, correct epoch. Source: a socket's RPCs are dispatched one at a time in arrival order (`tui_gateway/ws.py:95-96`, neither method is a long or concurrent-read handler), so pipelining is safe. `session.resume`, `session.active_list` and `session.list` are pool handlers whose replies can come back out of order, so they must not be pipelined with a dependant call |
| Approval request shape | Source only: `approvals.mode` is `'off'` on this VM, so none could be provoked without changing config (not allowed). Params `{session_id, request_id, command, description, choices[once|session|always|deny], allow_permanent?, allow_session?, smart_denied?, tool_name?}`, answer `{choice}` (`contracts/server_requests.py:173-195`). The adapter reads `command`, `description`, `choices` and answers with `{choice}`: consistent. The JSON-RPC frame id (`srq-…`) is the request id the client answers; `params.request_id` is Hermes's own queue id |
| Clarify request shape | Live: method `clarify`, params `{session_id, questions:[{qid, question, choices, multi_select}]}`; choice labels may carry text such as `"red (Recommended)"`. The adapter's `questions[0].question` / `choices` read and `{answers:{qid: text}}` answer worked (answer accepted, turn finished) |
| Request delivery | **All attached sockets.** One clarify request reached both attached sockets (1 and 1). Answering from one produced **no `request.cancel` on the other**; the other socket only saw `tool.complete` after (source: `resolve_response` pops silently; `request.cancel` is for timeout/interrupt/close) |
| Live orphan grace | **20 s**, not 300. An idle attached session left `session.active_list` 20.6 s after its socket closed. The config file says `ws_orphan_reap_grace_s: 300` but it was edited at 17:08 UTC on 2026-11-19 and the dashboard started on 2026-11-11 21:42; the value is read once at import (`tui_gateway/server.py:152`). It takes a dashboard restart. For a **running** turn (source, `session_lifecycle.py:954-1060`): after each grace the session stays detached and running while its activity is fresher than 600 s; it is only interrupted when idle that long, then reaped. Not exercised live |
| Token streaming | **Off in this configuration.** Neither transport sent a single `assistant.delta` / `message.delta`: a reply arrives whole in `message.complete`. The WebSocket does stream `thinking.delta`, `session.usage`, `session.info`, plus global `sessions.changed`, `platforms.changed`. Config has top-level `streaming.enabled: false` (and `display.streaming: true`); I did not change or test it |

## Transport check

| Check | REST + SSE (`hermes-api.cjs`) | WebSocket (`gateway-link` + `gateway-api`) |
|---|---|---|
| Create session, send, get a reply | works, 11/11 replies, `run.completed`, no errors | works, 11/11 replies, `run.completed`, no errors |
| Events seen | `run.started`, `message.started`, `assistant.completed`, `run.completed`, `done` (the last is unknown to native chat, harmless) | `run.started`, `message.started`, `assistant.completed`, `run.completed` |
| Reply equals server history | stored and streamed length equal on all 11 (text equality was folded into a check that also required deltas, so it cannot be isolated from the stored data; see Notes) | yes, same |
| Drop mid-reply, resume | not applicable (no resume) | **works**: 5 replies, 10 drops, 0 lost, 0 duplicated, final text equal to history on all 5, exactly 1 stored user row per prompt, 0 `gap` |
| Server request (clarify) with a second socket | polled via `getRun` (not exercised) | request arrives on the link, answer through the adapter works, closes cleanly |

Resume detail (5 replies, 2 drops each, long reply, drop 0.4 s after `run.started` then again 0.3 s after live): 3 replies dropped by closing the socket locally on the real `wss` path, 2 by a TCP reset through a local proxy in front of the tunnel. A second socket read the server's replay ring and compared sequence numbers: lost 0 and duplicated 0 on all five. Two uncounted `session.info` events were audit artefacts, not losses: the pre-bind `session.info` at seq 1 of a session's first reply (never forwarded by the controller), and one trailing `session.info`, the last seq after `message.complete`, that arrived after the audit's snapshot (the harness now waits 300 ms).

## Baseline numbers

RT (round trip) is the same on every path: `gateway.ping` p50 **55.3** (p95 57.4), keep-alive HTTP 56.8 (65.5), `tailscale ping` 53 (65, direct), WebSocket through the tunnel 56.9 (64.4).

| Metric | REST + SSE (tunnel) | WebSocket (wss) | Spec section 4 target | Result |
|---|---|---|---|---|
| Round trip, warm | 56.8 / 65.5 | 55.3 / 57.4 | the ping | n/a |
| New HTTP connection, per request | 110.9 / 113.1 (2 RT) | n/a | n/a | keep-alive confirmed: `node:http`'s default agent reuses the connection (55 ms vs 110 ms) |
| Submit to admitted (`run.started`) | 67.8 / 83.4 | 73.6 / 101.2 | RT + 150 / RT + 190 = 205 / 245 | **met**: overhead over RT is 11 / 18 (SSE) and 18 / 44 (WS) |
| Warm first token | = last token | = last token | RT + 150 / RT + 190 | **not measurable as specified**: no token streaming here, so first token is the whole reply (below) |
| Warm last token (whole reply, "ok") | 1,593 / 3,160 | 3,437 / 4,457 | no target | WS **1.8 s slower at the median**; see below |
| First turn of a new session | 8,673 (n=1) | 8,411 (n=1) | about 1.1 s extra (spec) | far more than 1.1 s, but per new session, not per idle gap; n=1 each |
| Cold: probe + ticket + socket + `gateway.ready` | n/a | 429.7 / 1,064.1 (probe 172, ticket 62, socket upgrade 182) | n/a | the 1,064 is one slow probe (594) |
| Cold: attach (`session.resume` + fresh bind) | n/a | 265.5 / 283.9 = about 4 RT (6 calls; the 3 negotiate calls run together, `activate` and `events.since` are sequential) | 4 exchanges total | attach alone is already 4; pipelining those two saves one RT (client bug 4) |
| Cold, everything | n/a | 693.8 / 1,348 | derived 2.2 s at 246 ms | measured RT is 55 ms, not 246 ms; 511 / 755 if the `/api/status` probe is skipped |
| Reconnect after a drop, idle, 31 s apart (n=10 each) | n/a | close socket on wss: **723 / 914**; TCP reset on tunnel: **366 / 411** | 4 exchanges + 100 ms; 500 ms p95 at 100 ms RT | **not met on wss** (about 13 RT), met on the plain-HTTP tunnel path |
| Reconnect mid-reply, 10 drops (some back to back) | n/a | 737 / 1,993 | same | first drops 373-1,060; repeated drops back off (client bug 2) |
| Dead-link detection, graceful close | n/a | 54-73 | 14 s or less | for a close frame, yes; a half-open link was **not tested** |
| Dead-link detection, TCP reset | n/a | 0.3-1.2 | 14 s or less | yes |
| Lost / duplicated events after a drop | the reply is lost | 0 / 0 | 0 | **met** |
| Live orphan grace | n/a | 20.6 s | spec assumed 20 s, config says 300 s | 20 s in effect |

Where the reconnect time goes (not fully decomposed): the reconnect path pipelines `activate` + `events.since` (`bindResume`, `hermes-conversation.cjs:369-371`), so after the socket it needs about two RT. On the plain-HTTP tunnel path that is ticket 62 + socket + 2 RT = 366 ms. On `wss` the same steps take 723 ms; the extra is the TLS + Tailscale Serve upgrade (182 ms median, up to 395 ms, in the cold test) and a jittered wait. The close or reset is noticed in 55 ms or less than 2 ms.

## Notes and caveats

- **The two transports are not the same server path.** REST+SSE runs on the gateway process's API server (via a tunnel, because that is the only way in); the WebSocket runs on the dashboard's `tui_gateway`. The WebSocket arm emits `thinking.delta` and takes about 1.8 s longer to answer a one-word prompt at the median. That gap is the turn, not the transport (submit-to-admitted is 6 ms apart at the median). I cannot say from here why (reasoning enabled on that path is the likely reason); it dominates any transport gain.
- **Warm first token cannot be compared with the 2026-11-11 loopback numbers**: that benchmark used a fake model that answered in 50 ms and streamed. The real model here answers in 1.5-4.5 s and, in this config, whole.
- **Harness changes after the runs.** The 22-prompt warm series ran before the harness recorded the first of delta-or-completed and before its text check allowed a reply with no deltas, so the stored `mismatches` array (22 entries) counts "no deltas", not wrong text; every one of the 22 ended `run.completed` with no error and equal stored/streamed length. The first drop run (5 prompts) waited for deltas that never come, so no drop fired and it is not reported. The next drop run's `wss-close` arm used a stale socket reference (a bug of mine: the audit socket replaced "the last connection"), so its 4 drop attempts were no-ops; that arm was rerun with 3 more prompts and the other arm kept.
- **The reconnect time of one drop is not representative of a flapping link.** The link's counter resets only after 30 s of stable `live`; 7 drops 0.5 s apart gave waits of about 0.4, 1.2, 1.4, 4.2, 3.0, 3.1 s with a healthy network each time (client bug 2).
- Not tested: a half-open (blackholed) link, a laptop sleep, a Hermes restart (epoch change), approvals, `/v1/runs/{id}/events` for `chat/stream` runs, whether `session.activate` prewarms the agent, ATS on iOS, token streaming on, 100 runs.

## Sessions created and deleted

Every id is `gwvmcheck-<stamp>-<tag>` with title `gateway-vm-check <stamp> <tag>` (REST, source `api_server`). 16 sessions were created: 13 by the bench (listed per run in `results.json`, `runs[].sessionsCreated`, each deleted and then 404 in the same run), 2 by a throwaway socket-close timing probe (deleted, 200) and 1 by my first handshake probe, which I deleted by hand at the end (200, then 404). A final listing of the VM's 203 sessions, before that last delete, found only that one of mine.

## Client bugs and deviations found against the live server

None fixed here, by the brief. Each is a proposal.

1. **The tailnet address rule rejects the only address that works.** `desktop/src/hermes-remote.cjs:52,68,273` call `tailnetUrl` (`desktop/src/tailnet.cjs:19-24`), which under `HERMES_WORKSPACE_REQUIRE_TAILNET=1` accepts only a literal Tailscale IP. Evidence: with the flag set, `normalizeBaseUrl('https://<machine>.<tailnet>.ts.net')` throws `bad_url` and `http://<tailnet-ip>:9119` is accepted, but the real dashboard answers that address `400 Invalid Host header` (it serves only the `.ts.net` name). Without the flag (today's default) everything works. Section 6 of the spec lists the `.ts.net` `wss` name as accepted and the literal IP as the strict-mode option; the code does the opposite for this server. Proposal: in the three checks also accept `https://*.ts.net` (the rule `hermesWebappUrl` already has, `tailnet.cjs:30`), and drop the literal-IP row from the spec unless the VM sets `dashboard.public_url`/trusted hosts for it.
2. **Reconnect delay grows even when each reconnect succeeds.** `desktop/src/gateway-link.cjs:72,82-86,108,154`: `failures` is reset only by the 30 s stable timer, and `dropConn` schedules with the escalated value. Evidence (idle session, healthy network, seven closes 0.5 s apart): waits of about 0.4, 1.2, 1.4, 4.2, 3.0, 3.1 s before each attempt. A flapping network, or a user who changes Wi-Fi twice in a minute, waits seconds for a link that connects in 0.4 s. Proposal: set `failures = 0` when an attempt reaches `live` (line 104), and in `dropConn` use `failures = 1` if the drop came less than about 2 s after `live`, so a real flap still escalates.
3. **The adapter ignores `thinking.delta`, so a turn shows nothing for seconds.** `desktop/src/gateway-api.cjs:50-62` handles `message.delta` but the real server (this config) streams only `thinking.delta` and `session.usage` until `message.complete`, 1.6-4.5 s later. The controller already collects them (`hermes-conversation.cjs:799-801`). Proposal: map the first `thinking.delta` to a "thinking" run state or a `tool.started`-like event so the UI can show activity. The `message.delta` mapping itself is untested against a live server (this one does not stream).
4. **Deviations from the Phase 1 scope in the spec.** (a) The fresh bind issues `session.activate` and then `session.events.since` one after the other (`hermes-conversation.cjs:247,268`); the server processes a socket's RPCs in arrival order, so they can be sent together as `bindResume` already does (`:369-371`): saves one RT (55 ms) on a cold attach. (b) The ticket still goes in the URL and the socket has no subprotocol (`hermes-remote.cjs:256,274`); the server accepts the subprotocol form (tested), so the planned change is safe and keeps the ticket out of access-log query strings. (c) `authRequiredCache` is per opener (`gateway-link.cjs`, `createGatewayOpener`), so a restart pays the `/api/status` probe again (172 ms median, 594 ms worst in 10).
5. **Not a bug, but the spec's multi-device wording needs a change:** an answered request produces no `request.cancel` for the other devices (see "What the VM exposes").

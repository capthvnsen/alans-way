# One conversation across Telegram, Hermes Desktop and native chat

Checked 2026-11-11 against Hermes Agent 0.23.1 (source at `~/.hermes/hermes-agent`, read only)
and a live lab: real gateway, fake model, loopback API on `127.0.0.1:18642`, Webapp on
`127.0.0.1:19120`. File references are relative to the hermes-agent repo.

## Verdict

There is a supported way, with limits:

- **The profile's Bot Chat** (the local session titled exactly `Bot Chat`) accepts
  `POST /api/sessions/{id}/chat` and `/chat/stream` from the API server. The turn enters that
  session's own queue as its owner's input, so native chat, Hermes Desktop and the CLI all write
  the same session id. This is the door `hermes peer dm` uses.
- **Sessions native creates** (`source: "api_server"`) are writable from Hermes Desktop and the CLI
  too, and native keeps writing them afterwards. So "native creates, both continue" also works.
- **Every other Hermes Desktop / CLI session** stays read-only over the API. Copy-and-continue
  (`/fork`) is still the only way to reply to those from native.
- **Telegram** sessions are not writable from any other surface (API or gateway WebSocket).

No server setting is needed. Nothing has to change on the VM.

## The ownership rule

Every API door that names a session (`/api/sessions/{id}/chat[/stream]`, `/v1/runs` `session_id`,
`X-Hermes-Session-Id` on Chat Completions) admits its turn through `admit_api_steps`
(`gateway/session_api_turn.py:153`). Before it admits anything, it reads the target row and refuses any
row whose `source` is not `api_server` or `bot_room`:

```
gateway/session_api_turn.py:177  existing = authority.db.get_session(sid)
gateway/session_api_turn.py:178  if existing is not None and existing['source'] not in ('api_server', 'bot_room'):
gateway/session_api_turn.py:179      raise RuntimeStoreError('permission_denied')
```

`RuntimeStoreError` is `hermes_state_runtime.py:23`. This is a hard-coded source check: no
header, parameter, token scope or config key changes it. `X-Hermes-Session-Key` only names a memory
scope (`website/docs/user-guide/features/api-server.md:762`). The docs say the same thing
(`api-server.md:500-512`: "API sessions are their own sessions … refused with HTTP 409 …
`permission_denied` … To work on a chat from another surface, attach through the gateway WebSocket").

The one exception is in front of that check. `_handle_session_chat` (`gateway/platforms/api_server.py:3040`)
first calls `_answer_through_live_bot_chat` (`:3054`, stream twin `:3094` →
`_stream_through_live_bot_chat` `:3001`). With session authority (always built on `gateway run`,
`gateway/run_runtime.py:38-58`), `_admit_to_live_bot_chat` (`:2916`) calls `admit_peer_turn`
(`gateway/platforms/api_server_bot_chat.py:128`). When the target is in the lineage of the session
titled `Bot Chat` (`bot_chat_tip`, `:116`; the title is `BOT_CHAT_TITLE`, `tools/bot_mode_probe.py:37`),
the turn goes into that session's FIFO as its owner's input (`actor = SessionActor(tip['user_id'], …)`,
`:149`), not as an API session. The module docstring calls this out as the supported path, and
says that binding the session as an API conversation "would be a second writer and is refused
(`permission_denied`) by design".

On the gateway WebSocket side (CLI, TUI, Hermes Desktop), a stored row that has no local receipt,
route or binding is mounted for reading only (`gateway/session_history_mount.py:32`, refusal
`session_read_only` at `:71`). Local CLI/TUI/Desktop rows are adopted as writable instead (`:37`),
and so are API rows that have an API binding.

Why native saw a bare HTTP 500: the sync `/chat` route does not map `RuntimeStoreError` to an HTTP
status, so aiohttp answers 500 "Server got itself in trouble". The traceback runs
`api_server.py:3060` → `:3688` → `session_api_turn.py:316` → `:134` → `:179`. `/v1/runs` and
Chat Completions map the same error to 409. `/chat/stream` answers 200 with an SSE
`event: error` `{"message":"permission_denied"}` frame.

## Candidates tried (live)

`LOCAL` = a Hermes Desktop session (`local-ee1fd6d1…`, source `local`), `TG` = a Telegram-source
session seeded into the lab DB (`telegram_20660f41`), `BC` = the Bot Chat, `API` = a native-created
session. All requests use `Authorization: Bearer <lab key>` and no Origin header.

| # | Request | Result |
|---|---|---|
| C1 | `POST /api/sessions/LOCAL/chat {"input":"probe c1"}` | **500** `Server got itself in trouble` (log: `RuntimeStoreError: permission_denied`) |
| C2 | `POST /api/sessions/LOCAL/chat/stream` | 200, SSE `run.started`, `message.started`, `error {"message":"permission_denied"}`, `done` |
| C3 | C1 plus `X-Hermes-Session-Key: LOCAL` | **500**, same |
| C4 | `POST /v1/runs {"input","session_id":LOCAL}` | **409** `{"code":"permission_denied"}` |
| C5 | `POST /v1/chat/completions` with `X-Hermes-Session-Id: LOCAL` | **409** `permission_denied` |
| C6 | `POST /v1/responses` with `X-Hermes-Session-Id: LOCAL` | 200, but answered in a **new** `api_server` session (`52750588-…`); LOCAL unchanged |
| C7 | `POST /api/sessions/TG/chat` | **500** |
| C8 | `POST /v1/runs {"session_id":TG}` | **409** `permission_denied` |
| C9 | `POST /api/sessions {"title":"Bot Chat"}` | 201, `id: local-5bffc3c6…`, `source: "cli"`, `user_id: "api-peer"` (a local session the owner minted) |
| C10 | `POST /api/sessions/BC/chat {"input":"probe c10"}` | **200** `{"session_id":BC,"message":{"content":"pong: probe c10"},"delivery_id":…}`; both rows stored in BC |
| C11 | `POST /api/sessions/BC/chat/stream` | **200** SSE `run.started`, `message.started`, `assistant.completed` (whole text, no deltas), `run.completed`, `done`; stored in BC |
| C12 | Rename LOCAL to `Bot Chat` (old BC renamed away), then `POST /api/sessions/LOCAL/chat` | **200**, stored in LOCAL. The gate is the title; titles restored afterwards |
| W1 | `HERMES_HOME=$LAB/home hermes chat -c "Bot Chat" -q "probe w1 from cli"` (gateway WebSocket) | written to BC; native `/chat` into BC still 200 afterwards |
| W2 | `hermes chat --resume <API> -q "probe w2 from cli"` | written to the `api_server` session; native `/chat` into it still 200 afterwards |
| W3 | `hermes chat --resume TG -q …` | refused: `Details: session_read_only` |
| W4 | `hermes chat --resume LOCAL -q …` | written (local row, as expected) |
| D1 | Hermes Desktop (lab Webapp inside the app) opens BC | shows the message native sent; its own send `hello from hermes desktop …` is stored in BC (`/tmp/polish-proof/sameconv-desktop.png`) |
| D2 | Hermes Desktop opens API (made by native) and sends | stored in that `api_server` session (`/tmp/polish-proof/sameconv-desktop-apisession.png`) |

Raw outputs: `/tmp/polish-proof/sameconv-transcript.txt`.

Not tested: a real Telegram lane session (the lab has no Telegram adapter; W3 used a seeded row
without a route), `/v1/runs` into BC (the code routes it through the same `admit_peer_turn`), approvals
inside a Bot Chat turn sent from native, and a gateway without session authority (there the Bot Chat
door only works while a Desktop holds the chat live, `api_server.py:2934-2952`).

## What native chat does now

- A local-surface session (`local`, `cli`, `tui`, `gui`, `desktop`) titled exactly `Bot Chat` is
  writable and marked **Shared with Hermes Desktop** in the switcher. No fork.
- Hermes Desktop's Bot Mode marks every Bot Chat `hidden` (by design:
  `apps/desktop/src/plugins/hermes-bots/hide-bot-chats.test.ts`; seen live, the lab Bot Chat became
  hidden right after the Webapp opened it), and `GET /api/sessions` leaves hidden rows out. Native
  therefore also asks `GET /api/sessions?title=Bot%20Chat&include_hidden=true&limit=1` and pins
  that row first in the switcher.
- Its replies arrive whole: the peer door sends `assistant.completed`, not deltas.
- If the Bot Chat is busy past the server's 300 s wait (`tools/bot_mode_dm.py:52`), the stream ends
  with `run.queued`. Native says the message is queued and the reply will show after a refresh.
- A `permission_denied` refusal reads "Hermes does not let this app write to that conversation."
- Hermes Desktop sessions are labelled "Hermes Desktop" (source `local`), not "local". Other
  non-API sessions keep **Continue here** (fork into an API session).

## What upstream would need for the rest

Only needed if every Hermes Desktop session, not just the Bot Chat, should be writable from the API:

1. `gateway/session_api_turn.py:177-179`: instead of refusing a local-surface row, hand the turn to
   that session's authority FIFO as a peer submission, the way `admit_peer_turn` already does for
   the Bot Chat (`gateway/platforms/api_server_bot_chat.py:128-160`). Gate it on an explicit opt-in:
   proposed `POST /api/sessions/{id}/chat` body field `"deliver_to_owner": true`, allowed only for an
   API key with operator scope, refused with 409 `permission_denied` otherwise. Messaging rows
   (Telegram etc.) stay refused, because their lane owns delivery to the chat.
2. `gateway/platforms/api_server.py:3040-3060`: map `RuntimeStoreError` in the sync session-chat
   route to the same 409 `{"error":{"code":"permission_denied"}}` that `/v1/runs` returns, instead of
   a bare 500.
3. Stream deltas for peer turns: `_stream_through_live_bot_chat` (`api_server.py:3001`) sends one
   `assistant.completed`; forwarding the owner's deltas would make it look like any other stream.

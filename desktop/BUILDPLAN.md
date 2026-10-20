# Native Hermes conversation surface — build plan

Goal: a real native composer/transcript in the companion Electron app, attached to an
explicitly configured `hermes serve` backend over the public authenticated seam —
`GET /api/status` → `GET /api/auth/providers` → RFC 8252 native PKCE login
(`/auth/native/authorize` → `/auth/password-login` → `/auth/native/token`, or
`/auth/native/refresh` for a stored refresh token) → `POST /api/auth/ws-ticket` →
`ws(s)://…/api/ws?ticket=…` speaking the TUI gateway JSON-RPC protocol through the
accepted `hermes-session-wire.cjs` + `hermes-conversation.cjs`.

Non-goals: mapping Telegram bots / VPS browser URLs / profile labels to sessions;
attaching across gateway processes; auto-answering approvals; faking auth.

## Milestones (independently reviewable)

1. **`hermes-remote.cjs`** — authenticated HTTP/WS connector. URL validation
   (http/https only, path prefixes preserved), status probe, provider discovery,
   PKCE password login, refresh-token rotation, WS ticket mint, WebSocket →
   `{input, output}` stream pair for `HermesSessionWire`. Loopback
   (`auth_required:false`) uses an operator-supplied `localToken` on `?token=`.
   Secrets never enter renderer IPC, URLs logged, or state projections.
   Tests: `test/hermes-remote.test.cjs` against a local node http stub +
   a minimal RFC6455 server.

2. **`hermes-hub.cjs`** — main-process owner. Holds the connector, the wire,
   one `HermesConversation` controller per bound session, session list, target
   identity, drafts, and a bounded display-state projection. Validates a closed
   command allowlist; secrets stay in main. Injectable `deps` seam for tests.
   Credential work rides a second epoch (`authSeq`) beside the connection
   `generation`: configure/sign-out/disconnect and every new sign-in attempt
   invalidate pending auth, and each async credential result is fenced by
   target+profile+epoch before it may mutate state, persist, or feed the next
   endpoint — a superseded attempt can never write, leak, or tear down the
   newer connection. The same invalidation also actively cancels fenced-out
   backend work (optional `AbortSignal` threaded through the remote's request
   and socket helpers): a superseded connect/sign-in is unwound at the point
   of invalidation instead of by request timeout, so a newer authorized
   `connect` never awaits obsolete I/O. `connect` keeps exactly one
   authoritative live socket — an existing conn is torn down and replaced
   rather than adopted beside a second socket, and a superseded socket's late
   close releases it without rewriting the newer epoch's status.
   Tests: `test/hermes-hub.test.cjs` with in-memory wire/controller fakes that
   exercise real hub logic (command validation, fencing, stale-state handling);
   `test/hermes-auth-race.test.cjs` drives the real remote+wire over loopback
   HTTP/WS fake backends for the stale-target/stale-refresh/sign-out/overlap
   cases, asserting persisted records and actual request bodies/headers.

3. **Main wiring** — `main.cjs` instantiates the hub, registers `hermes:get` /
   `hermes:command` (sender-checked via `trustSender`), pushes `hermes:state`
   to the shell renderer, exposes a small `hermes` summary + `chatTarget` in
   `workspace:get`, persists `prefs.hermes` (url/profile/session — no secrets),
   and encrypts the persisted access + refresh token pair via `safeStorage`
   in `hermes-gateway.json` (silent reconnect; no plaintext secrets at rest).

4. **Preload + renderer surface** — `window.hermes` bridge (get/command/onState);
   `hermes-view.js` renders the composer/transcript/request cards inside a new
   `#hermes-pane` in the chat pane; sidebar gains a Hermes section with one row
   per session plus connect/sign-in affordances. Telegram stays the default;
   selecting a bot restores the Telegram view (`telegram-slot` hidden ⇢ its
   `WebContentsView` collapses to zero rect and is hidden by `fit()`).

5. **Runtime acceptance** — `evidence/quality/native-hermes-chat-builder/`:
   owned loopback `hermes serve` (auth gate engaged via `dashboard.public_url`),
   owned basic-auth credentials, scripted model provider, real Electron main +
   real shell renderer driven over CDP. Proves sign-in, ticket, WS, sessions,
   streamed turn, clarify answer, stop, switch+draft survival, hostile markup.

Each layer pins its own sources (SHA-256 manifest) so connector and UI critics
can review independently.

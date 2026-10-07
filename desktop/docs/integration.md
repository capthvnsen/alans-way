# Hermes- Alan's way integration boundary

Keep stock Hermes unchanged. The companion should launch or register the browser MCP connector on the Mac through the existing private SSH route, using its bot/profile identity as `--bot-id`. Map Telegram bot IDs to Hermes profile IDs explicitly if those namespaces differ. The UI can assign a tab to either ID; they must match the connector argument.

## Local browser interface

The desktop app creates `~/Library/Application Support/Hermes Workspace/connection.json` with mode 0600. The connector rereads it for every call, allowing token rotation on app restart. Tokens and browser profiles never belong in the shared repository. The endpoint is loopback only; run the connector on the Mac rather than exposing the HTTP service on Tailscale.

All requests use bearer authentication and `X-Hermes-Bot`. The current protocol version is 1.

| Operation | Interface |
| --- | --- |
| Availability | `GET /v1/status` |
| Assigned tabs (every tab for an overseer) | `GET /v1/tabs` |
| New tab | `POST /v1/tabs` with `url` and optional `background` |
| Tab state | `GET /v1/tabs/:id` |
| Text and element refs | `GET /v1/tabs/:id/snapshot` (`maxChars`, `maxElements`, `since`); `loading: true` means the document was still parsing after a 400ms grace |
| Screenshot | `GET /v1/tabs/:id/screenshot` (`format` jpeg/png/webp, `quality`, `maxWidth`) |
| Input/navigation | `POST /v1/tabs/:id/actions` with current `epoch` |
| Close assigned agent tab | `DELETE /v1/tabs/:id` with `X-Control-Epoch` |
| Release or retake a tab | `POST /v1/tabs/:id/control` with `controller` (owning bot or overseer) |

Allowed actions: navigate, move, click, double_click, right_click, drag, select, type, press, scroll, back, forward, reload, batch, eval, wait, viewport, cdp. Move, click, double_click and right_click accept a fresh snapshot ref, a CSS `selector`, or viewport x,y; drag presses at that source and releases at `toRef`, `toSelector`, or `toX`,`toY`; select picks an option of a `<select>` by `value` or `label`; type and press accept a ref or selector; scroll x,y are deltas. Move provides real pointer hover. `batch` runs up to 25 steps per call and stops on the first error; `wait` blocks until a selector exists, text appears, or the URL contains a substring (`visible: true` requires a rendered element), and survives a navigation that lands mid-wait; `eval` evaluates JS in the page and returns the JSON result; `viewport` sets a per-tab device-metrics override (`clear: true` resets); `cdp` sends an allowlisted DevTools command (Page, Runtime, Input, Emulation, Network, DOM, DOMSnapshot, Accessibility, CSS, Log) for anything the named actions do not cover. Cookie and storage access, file inputs and choosers, downloads, request interception, browser-privileged fetches and persistent script injection are denied inside those domains, and `Page.navigate` goes through the same address validation as `navigate`. Snapshots cover the top document, its shadow roots and same-origin iframes. Cross-origin iframes are listed under `iframes` (title and src) but their contents are not traversed, and file uploads are not implemented. A screenshot can show frame content and coordinate input targets the tab viewport.

Agent tabs open in the background unless explicitly requested otherwise. Input travels through the tab’s Chromium DevTools target, with a decorative Agent cursor at dispatched coordinates. It does not use OS input, the clipboard, native window activation, or the human’s keyboard focus. Agent page popups preserve the selected human tab. Application menu shortcuts are suppressed during agent key dispatch.

A tab has `id`, `host`, `session`, `botId`, `allowedBots`, `controller`, and `epoch`. A bot can read its assigned or explicitly granted tabs. Mutation requires agent control and the current epoch. Take over, return control, assignment, and grant changes increment the epoch. Queued actions recheck it before dispatch. An input already sent to Chromium cannot be recalled. Human pointer input does not automatically change ownership: use Take over before intervening.

Agent-initiated navigation — the `navigate` action, `POST /v1/tabs` and `cdp` `Page.navigate` — refuses loopback, link-local and cloud metadata addresses (127.0.0.0/8, ::1, localhost names, 0.0.0.0, 169.254.0.0/16), with numeric and hex IP spellings normalized before the check. Private LAN ranges stay reachable for dev servers and home tools; human navigation is unaffected. `HERMES_WORKSPACE_ALLOW_LOOPBACK=1` lifts the loopback part only and exists for test fixtures that serve pages from 127.0.0.1 — it has no place in a real deployment.

While `controller` is `human`, page content is sealed to bots: `snapshot` and `screenshot` fail with `409 Tab is under human control.` for every bot actor, overseers included — including reads that were queued or in flight when the takeover happened, and each tab accepts at most 8 pending reads (429 beyond that). `GET /v1/tabs/:id` metadata stays readable so agents can still see the tab exists and who holds it, but on a human-controlled tab bots get an origin-only `url` and a blank `title`, `favicon` and handoff `note` instead of the live values. The human takeover boundary covers visibility, not just mutation. The trusted human path — `X-Hermes-Human` on the VPS host, the app itself on Mac — is unaffected.

An explicit human takeover also locks control itself: after Take over, human navigation or an extension page hand-off, `POST /v1/tabs/:id/control` with `controller:'agent'` returns 409 for every bot — owner, grantees and overseer alike — until the human gives the tab back with Give to agent in the UI. Only a human-caused return to human control locks the tab this way; the two routes below stay claimable.

Agent control also expires on its own. Every authorized tab request (snapshot,
screenshot, action, control change) refreshes the tab's agent activity clock; a
tab under agent control with no agent contact for `agentIdleMinutes` (default
15, Mac setting; `HERMES_AGENT_IDLE_MINUTES` on the VPS host) automatically
returns to human control with an incremented epoch — work finished or stalled
does not leave tabs held forever. Idle-expiry and bot-initiated releases do
not lock the tab, so a bot that is still genuinely working can retake its own
tab with `POST /v1/tabs/:id/control`, and a finished bot should release the
same way instead of waiting out the clock.

A designated overseer bot can supervise the whole workspace. On the Mac
connector list its bot ID in the `overseerBots` preference, seeded at load from
`HERMES_OVERSEER_BOTS` (comma-separated) when the preference is unset; on the
VPS host set `HERMES_OVERSEER_BOT_IDS` the same way. An overseer's
`GET /v1/tabs` returns every tab regardless of ownership, and its reads,
actions and `control` posts are permitted on any tab — that is the point: an
orchestrator can release or retake a runaway agent's tab. Ownership is the only
gate it bypasses; the human read gate, control and epoch checks still apply,
so it intervenes by changing control first.

The overseer is treated as the workspace's primary bot in the sidebar: it pins to
the top of the bot list with a PRIMARY badge. Pick a different one with the
`primaryBotId` preference (Settings → Primary bot); clearing it falls back to
the first overseer.

The Mac API lists assigned tabs across configured hosts. `POST /v1/tabs` accepts
`host: mac | vps` (default Mac). VPS tab operations relay through the configured
SSH alias to the private VPS broker. The native VPS MCP connector uses
`browser-mcp.cjs --connection /private/browser/connection.json --bot-id ID`
and accepts only VPS opens; it remains available when the Mac is offline.
Its Chromium/CDP endpoints stay on loopback. See [VPS setup](vps-browser.md).
Browser IDs are trusted routing identities, not a security boundary against
an agent with the host user's shell access. Overseer IDs share that model:
anyone holding `connection.json` can assert an overseer bot ID, so keep the
list short.

The VPS broker keeps two tokens. `connection.json` carries the agent token,
which never grants human operations: a request with `X-Hermes-Human: 1` and the
agent token gets 403. Human-only operations (`control` for another bot, `grant`,
`human-actions`, `checkpoint`, `restore`, `activate`, listing every bot's tabs)
and `POST /v1/mirror` need the app token, which the broker writes to
`app-token.json` (mode 0600) or to the absolute path in `config.json`'s
`appTokenFile`. The app's SSH `request` helper reads it automatically for those
calls. The app token only separates the human from the agent when the broker
and the app's SSH login run as a different user than the agent, with
`appTokenFile` pointing somewhere the agent user cannot read (and `sudo` set in
the VPS settings). In the common single-user setup the agent can read the file,
so the split guards against forged headers and mistakes, not a hostile agent
with shell access. Per-tab ownership and control epochs are cooperative policy
for agents, not a cryptographic boundary between callers that already share a
token. Restart the app or host to rotate both tokens.

Agent navigation is held to the same address rules everywhere: `open`,
`navigate`, `cdp Page.navigate`, redirects, pop-ups, frames, workers and
script-driven requests. On the VPS broker every request an agent-held tab makes
(including its pop-ups, cross-process frames and dedicated workers, which start
paused until the filter is on) is checked before it leaves, and one that names
a loopback, link-local or metadata address, in any spelling or with userinfo, is
failed. A tab that still lands on one is sent back to `about:blank` and a
pop-up is closed. The tab's `blocked` field says which URL was refused. Human
tabs are not intercepted. Measured on a 300-image page against headless Chrome,
the filter adds about 10 ms plus 0.1 ms per request. Known gaps: WebSocket
handshakes (the DevTools Fetch domain never sees them), service workers and
shared workers (not tied to one tab), and public hostnames that merely resolve
to a private or loopback address (there is no DNS check). Running Chromium
behind a local egress filter closes all three.

On `human_has_control`, wait for an explicit release. On `stale_control_epoch`, inspect current state and take a fresh snapshot before deciding whether to proceed. A timed-out form submission is uncertain; inspect the page rather than automatically repeat it. The UI must be the authority for tab access grants and human control.

## Browser task handoff

Control handoff keeps the same live tab on its execution host. For a Mac tab, the VPS agent drives the Mac through MCP, retaining that tab's cookies, uploads, JavaScript state, and open dialogs. It remains dependent on the Mac being awake.

The backend cross-host handoff helper creates a checkpoint with source
host/tab, URL/title, scroll position, a bounded task note and optional matching
text fields. Both source and destination stay human-controlled. Destination
`tab.handoff` records source/destination IDs, note, `verification`, and restored/
skipped draft counts. `verification: ready` means the URL matched; it is not
proof that the page's authentication or business state matches. A redirected
URL produces `review_required` and restores no drafts. Passwords and fields
identified as credentials, codes or payment details are excluded. Arbitrary
field classification is imperfect, so transferring text drafts is opt-in.
Cookies, files, JavaScript memory and open dialogs are not migrated.

The Mac UI displays only local browser tabs and one VPS desktop viewer.
Individual VPS tabs, VPS tab creation, and cross-host handoff controls are
not exposed in the app. The checkpoint/restore plumbing is retained for
the later Companion integration and its opt-in integration test.

Live login changes are shared within each host's single browser profile.
Mac/VPS authentication remains independent. The broker creates separate VPS
windows and agent-owned tab targets on one desktop. All desktop agents and the
human still see that shared desktop stream. Broker restart reattaches live
managed targets under human control with incremented epochs; browser exit
loses those live targets. Automatic agent resumption after a cross-host
handoff is not yet connected to the companion's task event system.

## Shared repository

The UI is `desktop/` within the companion repository. The Python Mac endpoint,
the native proactivity plugin, and this Electron browser connector
remain separate modules. They use the same existing VPS primary and Telegram
conversation. CI checks the Python package and desktop code independently.

Proactivity controls use the native `/proactivity` commands in the Telegram chat.
Status comes from the plugin's response; `hermes proactivity status|bind|set`
is the operator CLI. VPS **Take control** enables input
through the desktop picture; **Stop control** disables it. These viewer
controls do not pause browser or desktop agents. Coordinate shared desktop
work separately. Local **Take over / Give to agent** still enforces browser
control for Mac tabs.

## Site permissions

The browser remembers allow/block choices per origin (scheme, hostname and port)
in private app preferences, separately from Telegram. Settings → Site permissions
can change or reset those choices. Camera and microphone grants are independent.
The default "General area only" blocks classic/precise geolocation without a dialog;
only Chromium's explicitly approximate permission may be granted. Sites can still
estimate an area from IP. Availability of an approximate permission does not promise
that every site or desktop location provider supports it. A normal geolocation call
is never silently upgraded to precise access. Other supported permissions ask once
and remember the answer. Reload a site after changing its permission.

Inactive or agent-controlled tabs cannot use human permission grants. A navigation
or takeover while a dialog is open cancels that request. A previously started media
stream is not automatically stopped by editing a preference; reload or close that
tab to end it. Unsupported permissions are denied.

Run `npm run test:permissions` on a Mac to exercise actual Chromium requests,
reload persistence, the Settings controls and agent takeover, using a temporary
profile and local fixture without accessing the device's real location.

## Browser extensions

The address-bar puzzle button opens the local extension manager and Chrome Web
Store. Store installation uses `electron-chrome-web-store` in `persist:browser`,
with a native permission confirmation before downloading/loading code. It retains
Google's extension ID and checks loaded store extensions for updates. Disabled
extensions stay disabled on restart. The manager also imports unpacked code into
private app data and remembers enable/pin choices. It does not import Chrome
cookies, extension storage or password vaults. Extensions apply to all local tabs
sharing this session, including agents' tabs; Telegram and the VPS use separate
sessions. Review requested access when installing one.

`electron-chrome-extensions` supplies actual browser actions, dynamic popups,
click handlers, tabs/windows APIs and a native messaging bridge. The sandboxed
workspace preload is bundled by `npm run build:preload`; popup windows do not
receive the workspace preload or agent connector. Opening an action takes over
the selected local tab and invalidates pending agent epochs. Extension account
and settings tabs stay under human control and are omitted from the agent API.
Extensions themselves are trusted browser code with their declared permissions;
per-bot assignment does not restrict an installed extension's browser access.

This remains partial Chrome compatibility. For example, keyboard commands,
tab capture and some permission/settings APIs are incomplete. 1Password's
standalone setup must be completed by the user; do not infer successful vault
unlock or autofill from installation alone. Mac-app unlock/Touch ID requires
supported code signing and browser approval in 1Password. No browser identity
or signing check is bypassed. See [API coverage](https://github.com/samuelmaddock/electron-browser-shell/blob/master/packages/electron-chrome-extensions/README.md)
and [1Password browser requirements](https://support.1password.com/additional-browsers/).

Run `npm run test:extensions` for the generated MV3 fixture and
`npm run test:web-store` for the real public 1Password package. Each uses an
isolated profile; the latter requires network access and uses no account.
The desktop distribution is GPL-3.0-or-later; the Python addon stays MIT.

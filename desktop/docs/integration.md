# Hermes- Alan's way integration boundary

Keep stock Hermes unchanged. The companion should launch or register the browser MCP connector on the Mac through the existing private SSH route, using its bot/profile identity as `--bot-id`. Map Telegram bot IDs to Hermes profile IDs explicitly if those namespaces differ. The UI can assign a tab to either ID; they must match the connector argument.

## Local browser interface

The desktop app creates `~/Library/Application Support/Hermes Workspace/connection.json` with mode 0600. The connector rereads it for every call, allowing token rotation on app restart. Tokens and browser profiles never belong in the shared repository. The endpoint is loopback only; run the connector on the Mac rather than exposing the HTTP service on Tailscale.

All requests use bearer authentication and `X-Hermes-Bot`. The current protocol version is 1.

| Operation | Interface |
| --- | --- |
| Availability | `GET /v1/status` |
| Assigned tabs | `GET /v1/tabs` |
| New tab | `POST /v1/tabs` with `url` and optional `background` |
| Tab state | `GET /v1/tabs/:id` |
| Text and element refs | `GET /v1/tabs/:id/snapshot` |
| PNG screenshot | `GET /v1/tabs/:id/screenshot` |
| Input/navigation | `POST /v1/tabs/:id/actions` with current `epoch` |
| Close assigned agent tab | `DELETE /v1/tabs/:id` with `X-Control-Epoch` |

Allowed actions: navigate, move, click, type, press, scroll, back, forward, reload. Move/click accept a fresh snapshot ref or viewport x,y; type requires a fresh ref; press optionally accepts a ref. Scroll x,y are deltas. Move provides real pointer hover. Snapshots cover the top document; nested frame reference traversal, file uploads, and drag are not implemented. A screenshot can show frame content and coordinate input targets the tab viewport.

Agent tabs open in the background unless explicitly requested otherwise. Input travels through the tab’s Chromium DevTools target, with a decorative Agent cursor at dispatched coordinates. It does not use OS input, the clipboard, native window activation, or the human’s keyboard focus. Agent page popups preserve the selected human tab. Application menu shortcuts are suppressed during agent key dispatch.

A tab has `id`, `host`, `session`, `botId`, `allowedBots`, `controller`, and `epoch`. A bot can read its assigned or explicitly granted tabs. Mutation requires agent control and the current epoch. Take over, return control, assignment, and grant changes increment the epoch. Queued actions recheck it before dispatch. An input already sent to Chromium cannot be recalled. Human pointer input does not automatically change ownership: use Take over before intervening.

The Mac API lists assigned tabs across configured hosts. `POST /v1/tabs` accepts
`host: mac | vps` (default Mac). VPS tab operations relay through the configured
SSH alias to the private VPS broker. The native VPS MCP connector uses
`browser-mcp.cjs --connection /private/browser/connection.json --bot-id ID`
and accepts only VPS opens; it remains available when the Mac is offline.
Its Chromium/CDP endpoints stay on loopback. See [VPS setup](vps-browser.md).
Browser IDs are trusted routing identities, not a security boundary against
an agent with the host user's shell access.

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
the native proactivity plugin/startup hook, and this Electron browser connector
remain separate modules. They use the same existing VPS primary and Telegram
conversation. CI checks the Python package and desktop code independently.

Proactivity controls use the native `/proactivity` commands in the Telegram chat.
Status comes from the plugin's response. VPS **Take control** enables input
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

The address-bar puzzle button opens the local extension manager. It imports
unpacked Chrome extension code into private app data, loads it into the persistent
`persist:browser` session and remembers enable/pin choices across restarts. It
does not import Chrome cookies, extension storage or password vaults. Extensions
apply to this shared local session, including agents' local tabs; they are not
loaded into Telegram or the VPS desktop. Review requested access when adding one.

Pinned icons open manifest-defined `action.default_popup` or
`browser_action.default_popup` pages in sandboxed windows without the workspace
preload or agent connector. Opening a popup takes over the current local tab
before displaying it. Content scripts use Electron's built-in extension support.
Extensions do not have their own Hermes agent identities or obey per-tab bot
assignments; they are trusted browser code with their declared permissions.

This is partial compatibility, not a full Chrome extension host: dynamic action
APIs, Chrome Web Store installation, automatic extension updates and native
messaging are unavailable. In particular, 1Password browser autofill and desktop
unlock integration are not configured. The Mac-app shortcut only opens 1Password;
the workspace does not read its vault. See [Electron's supported APIs](https://www.electronjs.org/docs/latest/api/extensions)
and [1Password's additional-browser requirements](https://support.1password.com/additional-browsers/).

Run `npm run test:extensions` to exercise a harmless extension in an isolated
profile, including content scripts, a real popup, pin/enable persistence and removal.

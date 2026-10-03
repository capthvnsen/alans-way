# Hermes Companion integration boundary

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

Allowed actions: navigate, click, type, press, scroll, back, forward, reload. Click/type use refs from a fresh snapshot. Snapshots cover the top document; nested frame interaction, accessibility-tree traversal, file uploads, hover, and drag are not implemented in this first connector. A screenshot can show frame content but does not add frame action support.

A tab has `id`, `botId`, `allowedBots`, `controller`, and `epoch`. A bot can read its assigned or explicitly granted tabs. Mutation requires agent control and the current epoch. Take over, return control, assignment, and grant changes increment the epoch. Queued actions recheck it before dispatch. An input already sent to Chromium cannot be recalled. Human pointer input does not automatically change ownership: use Take over before intervening.

On `human_has_control`, wait for an explicit release. On `stale_control_epoch`, inspect current state and take a fresh snapshot before deciding whether to proceed. A timed-out form submission is uncertain; inspect the page rather than automatically repeat it. The UI must be the authority for tab access grants and human control.

## Browser task handoff

Control handoff keeps the same live tab on its execution host. For a Mac tab, the VPS agent drives the Mac through MCP, retaining that tab's cookies, uploads, JavaScript state, and open dialogs. It remains dependent on the Mac being awake. This first app exposes the Mac side of that path.

A separate **move execution** operation should create a checkpoint containing task identity, source host/tab, destination host, URL, bounded agent context, and the verified last action. Reopen on the destination browser and verify it before admitting more actions. Do not claim an arbitrary tab's DOM, in-memory JavaScript, or authentication sessions migrate perfectly. Do not copy browser profile directories between running Chromium processes.

Live Mac/VPS login propagation and separate VPS desktop streams need a dedicated design and tests. The current shared Mac browser profile supplies live cookie sharing only among this app's local tabs. All existing VPS desktops remain unchanged.

## Shared repository

The UI is `desktop/` within the companion repository. The Python Mac endpoint,
the native proactivity plugin/startup hook, and this Electron browser connector
remain separate modules. They use the same existing VPS primary and Telegram
conversation. CI checks the Python package and desktop code independently.

Proactivity controls use the native `/proactivity` commands in the Telegram chat.
Status comes from the plugin's response. There is no front-end toggle claiming
an agent is paused or a handoff completed. VPS Watch/Control controls viewer input;
it does not pause the agent or provide exclusive access to that desktop.

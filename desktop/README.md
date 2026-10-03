# Hermes Workspace

A free Mac desktop workspace with your Telegram bot chats on the left, real local Chromium tabs on the right, and a live VPS desktop in the corner. The dark three-pane layout follows the supplied Grok Bot reference. This is a functional first release for testing with Hermes bots.

## Use it

Open **Hermes Workspace.app**. Sign in to Telegram with its normal QR or phone login if needed. No Telegram developer API credentials are required: the chat pane loads the official Telegram Web A and applies local styling.

- The sidebar contains verified bot conversations from your Telegram account. Drag them to sort; hover and click × to hide one. Settings restores hidden bots. The + at the top opens a bot by username.
- The + beside browser tabs opens a Chromium tab on your Mac. ⌘L focuses its address; ⌘T opens a tab; ⌘W closes a local tab. Drag the divider to resize the chat pane.
- Paste an existing noVNC viewer URL into Settings. Keep Tailscale connected for a private VPS. The small desktop starts in Watch mode. Click its picture or ↗ to expand it into the VPS tab; ⛶ fills the workspace.
- **Watch / Control** enables mouse and keyboard input to the existing VPS desktop. This first release uses one shared desktop. Control does not pause or lock out Hermes agents on that desktop.
- Local tabs have an assigned bot ID. **Take over** blocks new browser actions from the connector; **Give to agent** returns control. The ⇄ button changes assignment or explicitly lets another bot share the tab.

Local tabs share this app's browser profile, so cookies and login changes are shared between tabs and bots running in the app. This is separate from Chrome/Safari profiles and from the VPS browser. Your Telegram session is stored in a separate profile.

## Give Hermes the local browser tools

Node 18+ is needed for the MCP connector; the desktop app itself includes its runtime. The connector is included in the installed app at:

```text
/Applications/Hermes Workspace.app/Contents/Resources/app/scripts/browser-mcp.cjs
```

For a Hermes process running on the Mac, merge this server entry into that profile's existing `mcp_servers` configuration. Replace the Node path and bot ID. The ⇄ dialog shows the ID of the assigned bot.

```yaml
mcp_servers:
  workspace_browser:
    command: /absolute/path/to/node
    args:
      - /Applications/Hermes Workspace.app/Contents/Resources/app/scripts/browser-mcp.cjs
      - --bot-id
      - YOUR_BOT_ID
```

For a Hermes process on the VPS, run the same command on the Mac through its already authorized SSH connection:

```yaml
mcp_servers:
  workspace_browser:
    command: ssh
    args:
      - -T
      - -o
      - BatchMode=yes
      - YOUR_MAC_SSH_HOST
      - "'/absolute/path/to/node' '/Applications/Hermes Workspace.app/Contents/Resources/app/scripts/browser-mcp.cjs' --bot-id YOUR_BOT_ID"
```

Use a different `--bot-id` for each bot. Keep existing Hermes settings and server entries. Restart or reload MCP through the workflow supported by your installed Hermes version. This project does not modify Hermes source or apply changes to running bot profiles.

The six tools are `workspace_browser_status`, `workspace_browser_tabs`, `workspace_browser_open`, `workspace_browser_snapshot`, `workspace_browser_screenshot`, and `workspace_browser_action`. Actions need the current tab epoch. Use fresh snapshot refs after each action. Opening a tab with `background: true` preserves the user's selected tab. The Mac must be awake and the app running; there is no silent fallback to a different computer.

The connector reads the current private connection file on the Mac, so no token needs to be pasted into Hermes configuration. The HTTP service listens only on `127.0.0.1:9464`, rejects browser-origin requests, and authenticates its native connector. Bot IDs guard against accidental crossover within this trusted connector; they are not independent authentication credentials.

## Build and test

```sh
npm ci
npm run check
npm start
npm run package:mac
```

The package command builds an Apple Silicon Mac app in `dist/Hermes Workspace-darwin-arm64`. It includes a custom icon and the Node MCP connector. This is a local development build; signed/notarized public distribution is a later release step. Building and running locally does not require a paid developer account.

With the app open, `node test/browser-smoke.cjs` exercises the real MCP protocol against its own local test page. It checks typing, clicking, screenshots, popups, shared cookies, bot ownership, and stale epochs. It asks you to click Take over and Give to agent to verify the human control boundary. It sends no Telegram messages and operates no third-party forms.

`node test/background-browser.cjs` verifies replacement typing, clicks and screenshots in a background tab without selecting it. Agent input uses Chromium's per-tab input protocol, so it can operate while the app is in the background. Hidden-tab screenshots paint in a temporary hidden window and return the same live tab to its original window.

App data lives in `~/Library/Application Support/Hermes Workspace/`. That directory holds private sessions, bot order/hiding preferences, the desktop URL, and a startup-rotated connector token. It is outside the source tree. The app restores up to twelve tab URLs after restart; live page execution state is not restored.

## Companion integration

This app lives in `desktop/` in the Hermes Companion repository. Install the
[proactivity plugin](../docs/proactivity.md) on your existing VPS primary, then
use `/proactivity status`, `/proactivity pause`, `/proactivity resume`, or
`/proactivity review` in its Telegram chat here. These commands reach the real
plugin; the UI does not maintain a second proactivity state. Configure the
browser MCP entry above on the same primary to let it use the local tabs.
[The integration contract](docs/integration.md) describes the browser interface.

The current browser handoff is control of the **same live Mac tab** from the VPS connector or the human UI. Moving execution to a new browser on the VPS, merging Mac/VPS login changes, and restoring arbitrary live page state require the later companion integration. Separate per-bot VPS desktops are also a later step.

## Implementation and licenses

- Electron `WebContentsView` renders actual Chromium pages; the app does not embed ordinary websites in restricted iframes. [Electron documentation](https://www.electronjs.org/docs/latest/api/web-contents-view).
- The official [Telegram Web A](https://web.telegram.org/a/) supplies messaging. The wrapper styles its DOM and reads its local IndexedDB cache for positively identified bots; it does not use a bot token to impersonate a user. Cache/schema changes upstream can require compatibility updates. [Telegram Web A source](https://github.com/Ajaxy/telegram-tt).
- [noVNC](https://github.com/novnc/noVNC) renders the existing remote desktop, using its own MPL-2.0 license.
- The [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) implements the stdio connector.

This project's original code is MIT licensed. Dependency licenses remain their own and are included with the packaged app. This project is independent of Grok Bot, Telegram, and Nous Research.

# Hermes — Alan's Way

**Your AI agents live on a VPS. This gives them a window into your Mac — on your terms.**

A desktop app for people running [Hermes Agent](https://github.com/NousResearch/hermes-agent) on a Linux server who want to watch, steer, and lend their agents a local browser — without giving up the keyboard.

```
┌──────────────────────────────────────────────┐
│  Telegram chat on the left ──────────────┐   │
│                                          │   │
│  Bot-owned browser tabs on the right ────┤   │
│                                          │   │
│  ┌─────┐ ← your agent's cursor, labeled  │   │
│  └─────┘   and colored per bot           │   │
│                                          │   │
│  ┌──────────┐ ← draggable VPS desktop    │   │
│  │ mini VM  │   preview, click to take   │   │
│  └──────────┘   control                  │   │
└──────────────────────────────────────────────┘
```

## What you get

- **See every bot's cursor.** Each agent gets a colored, named cursor in its tabs. You can literally watch it click around.
- **Agents get their own browser, not yours.** Bot tabs are separate Chromium views — your mouse, keyboard, clipboard, and other apps are never touched.
- **Grab the wheel anytime.** "Take over" a tab and every queued agent action on it is cancelled instantly.
- **A window into the VPS.** A mini preview of your server's desktop floats in the corner. Drag it anywhere, hide it, or click to take control.
- **Move work between machines.** Hand a tab from Mac to VPS (or back) and it lands with scroll position and form drafts intact — parked for review before the agent continues.
- **Shut your laptop, keep working.** With the [agent plugin](https://github.com/capthvnsen/alans-way-agents), bot tasks automatically route to the VPS browser when the Mac is unreachable — no silent weirdness, it fails visibly either way.
- **Explicit permissions.** Bots only see tabs you own or grant. Extension account pages are human-only. Nothing is shared unless you share it.

## The two repos

| Repo | What it is | Who installs it |
|---|---|---|
| **alans-way** (this one) | The Mac desktop app + companion CLI | You, on your Mac |
| [alans-way-agents](https://github.com/capthvnsen/alans-way-agents) | The plugin: proactivity, workspace skill, auto-routing | Your Hermes gateway (VPS) |

The app works without the plugin (manual tab sharing), and the plugin falls back to VPS-only browsing when the app isn't running.

## Install the app

Requires macOS and Node 20+:

```sh
git clone https://github.com/capthvnsen/alans-way
cd alans-way/desktop
npm ci
npm start
```

Sign into Telegram inside the app, and your existing bots appear in the sidebar.

To package a double-clickable app: `npm run package` (see the [desktop guide](desktop/README.md)).

## Connect your agents

In the app: **Settings → Agent setup**.

1. Enter this Mac's SSH address (how your VPS reaches it — Tailscale name or IP).
2. Click **Test agent path** — the app verifies VPS → Mac SSH end-to-end.
3. Click **Copy agent setup** — run the pasted commands on your VPS once per bot.

That's it. The bot gets a `workspace_browser` tool that opens tabs you can watch.

## Honest boundaries

- **Alpha software.** Tested on the author's setup; yours may differ. Bugs → [issues](https://github.com/capthvnsen/alans-way/issues).
- Agents think on the VPS. The Mac lends them a browser tab — it does **not** become their general-purpose computer.
- Agent input goes through Chromium's debugger into one tab — it never moves your real cursor or types into other apps.
- One exception: in the VPS preview, "Take control" mode *does* send your clicks to the remote desktop — that's the point of it.
- Telegram sending rides the embedded Telegram Web client. If sends stall, Settings → **Sync Telegram bots** reloads the session.

## Development

```sh
# Desktop app
cd desktop && npm ci && npm run check && npm start

# Companion CLI (optional — file tools + diagnostics)
python3 -m venv .venv && .venv/bin/pip install -e '.[mcp]'
.venv/bin/python -m unittest discover -s tests -v
```

Design docs live in [`docs/`](docs/) — [agent setup](docs/agent-setup.md), [security model](docs/mac-security.md), [integration](desktop/docs/integration.md).

## License

Desktop app: [GPL-3.0](desktop/LICENSE) · Companion CLI: [MIT](LICENSE) · Agent plugin: [MIT](https://github.com/capthvnsen/alans-way-agents/blob/main/LICENSE)

Independent community project. Not affiliated with Nous Research.

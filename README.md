# Alan's Way

**Your AI agents live on a VPS. This gives them a window into your computer — on your terms.**

JOIN THE DISCORD TO CONTRIBUTE OR SUBMIT BUGS: https://discord.gg/jBQCPUsVE
Follow and DM the creator here: https://x.com/alexhvnsen

A desktop app for people running [Hermes Agent](https://github.com/NousResearch/hermes-agent) on a server (Linux VPS, or a macOS VM via [Tart](https://tart.run)) who want to watch, steer, and lend their agents a local browser — without giving up the keyboard. The app itself runs on macOS (Apple Silicon) or Windows 10/11.



## What you get

- **See every bot's cursor.** Each agent gets a colored, named cursor in its tabs. You can literally watch it click around.
- **Agents get their own browser, not yours.** Bot tabs are separate Chromium views — your mouse, keyboard, clipboard, and other apps are never touched.
- **Grab the wheel anytime.** "Take over" a tab and every queued agent action on it is cancelled instantly.
- **A window into the VPS.** A mini preview of your server's desktop floats in the corner. Drag it anywhere, hide it, or click to take control.
- **Shut your laptop, keep working.** With the [agent plugin](https://github.com/capthvnsen/alans-way-agents), *new* browser work routes to the VPS when your computer is unreachable. An in-flight host action fails visibly; its live tab stays on the host and can be inspected or resumed after reconnecting. Work already running on the VPS continues. (Backend checkpoint/restore plumbing exists, but the app exposes no cross-host handoff button yet.)
- **Explicit permissions.** Bots only see tabs you own or grant. Extension account pages are human-only. Nothing is shared unless you share it.

## The two repos

| Repo | What it is | Who installs it |
|---|---|---|
| **alans-way** (this one) | Alan's Way desktop app (macOS/Windows) + companion CLI | You, on your computer |
| [alans-way-agents](https://github.com/capthvnsen/alans-way-agents) | Alan's Way Plugin: proactivity, workspace skill, auto-routing | Your Hermes gateway (VPS or macOS VM) |

The app works without the plugin (manual tab sharing), and the plugin falls back to VPS-only browsing when the app isn't running.

## How the pieces fit

- **Telegram stays stock.** Your existing Hermes gateway on the VPS keeps owning the bot conversation end to end. Alan's Way app embeds the official Telegram Web client so you can chat and watch — it is not a second gateway and never polls the bot token.
- **Host browser.** Alan's Way app's own Chromium tabs are the bots' window into your computer, driven per-tab through Chromium's debugger by a loopback-only connector.
- **VPS browser.** A separate managed Chromium on the server handles cloud work and is the fallback for *new* tasks when your computer is asleep. It does not absorb in-flight host tabs — those block and resume.
- **Remote desktop preview.** Optional. On a Linux server it needs a VNC server plus a noVNC (WebSocket) viewer you already run — the app only embeds the viewer URL you paste in. On a macOS guest VM, `scripts/mac-vm-preview.sh` bridges Tart's VNC display into the same view. Its **Take control** mode is the one place your input is forwarded to the remote desktop.
- **Plugin proactivity is read/research/draft by default.** The optional primary bot reviews its own work and drafts suggestions on a bounded budget; consequential actions (external messages, purchases, credential or permission changes, production changes, destructive operations) always require your approval.
- **No bundled account connections.** Email, calendar, Notion and similar tools exist only if you install and authorize them separately in Hermes — nothing here provisions them.

## Install the app

**Setting this up with an AI agent?** Point it at [docs/setup-for-agents.md](docs/setup-for-agents.md) — one page covering Alan's Way app, the server and Alan's Way Plugin, with a check after every stage and the exact steps that need you.

On a Mac (Apple Silicon) one command builds the app, installs it to
`/Applications` and opens it; re-run it to upgrade. Without git or Node it
downloads the source and a private, checksum-verified Node for the build:

```sh
curl -fsSL https://openalan.com/install-mac | sh
```

On Windows 10/11 x64, run `scripts/install-windows.ps1` from a clone of this
repo in PowerShell — it builds the app with `npm run package:win` into
`%LOCALAPPDATA%\Programs\alans-way-localapp` and opens it. Local builds skip
SmartScreen/signing prompts by construction.

Sign into Telegram inside the app, and your existing bots appear in the sidebar.

For development, run from source instead: `cd desktop && npm ci && npm start`
(see the [desktop guide](desktop/README.md)).

## Connect your agents

**Let your cloud agent do it (recommended).** Paste this to the agent that has a terminal on the server running your Hermes gateway. Your Hermes bot itself works. The steps live in the repo, so the prompt stays short.

```text
Set up Alan's Way. Repo: https://github.com/capthvnsen/alans-way
Fetch https://raw.githubusercontent.com/capthvnsen/alans-way/main/docs/setup-prompt.md and follow the text block in it exactly. Do not modify Hermes. Never print secrets.
```

**Or by hand, in the app:** **Settings → Agent setup** — the checklist shows what's already done.

1. Fill in both SSH addresses (your VPS, and how the VPS reaches this computer — Tailscale name or IP).
2. Click **Copy setup command** and paste it in a terminal on the VPS — one bootstrap installs the plugin, wires the browser, restarts the gateway, and offers to bind your primary bot. (Never configured Telegram on Hermes? The bootstrap walks you through the QR-code setup.)
3. Click **Test agent path** — the app verifies VPS → this computer over SSH end-to-end.

The bot then has a `cua_alans_way` tool that opens tabs you can watch.
The plugin's `workspace-setup` skill teaches installed agents the same playbook.

## Upgrading

Fresh installs and upgrades follow the same path: pull the repo, `cd desktop && npm ci`, restart Alan's Way app. On the VPS, update the plugin checkout and restart the gateway through Hermes' normal lifecycle — a running gateway keeps old code until restarted. Then send one Telegram message and watch a bounded browser action to confirm both ends still work. See [deployment](docs/deployment.md) and the [multi-profile fleet guide](docs/agent-setup.md) for details.

## Honest boundaries

- **Alpha software.** Tested on the author's setup; yours may differ. Bugs → [issues](https://github.com/capthvnsen/alans-way/issues).
- Agents think on the VPS. On your computer they can drive a background app or a browser tab. They do not take the app you are currently using, and they do not move your cursor. On Windows, elevated apps (Task Manager, UAC, the lock screen) are unreachable by design.
- Browser input goes through Chromium's debugger into one tab. Other apps are read as buttons and text first; a click uses that control and does not move your cursor. Keychain and password fields are refused.
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

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request and [SECURITY.md](SECURITY.md) to report a vulnerability. Design docs live in [`docs/`](docs/) — [setup for agents](docs/setup-for-agents.md), [multi-profile fleets](docs/agent-setup.md), [security model](docs/mac-security.md), [integration](desktop/docs/integration.md).

## License

Desktop app: [GPL-3.0](desktop/LICENSE) · Companion CLI: [MIT](LICENSE) · Agent plugin: [MIT](https://github.com/capthvnsen/alans-way-agents/blob/main/LICENSE)

Independent community project. Not affiliated with Nous Research.

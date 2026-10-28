# Alan's Workspace

**The open-source Grokbot killer.** A companion app and plugin for stock Hermes. Your bots live on a VM or VPS and work on your Mac or PC, on your terms.

> **Join the [Alan's Way Discord](https://discord.gg/jBQCPUsVE)** to get help, report bugs and shape what ships next.

[**Download for Mac**](https://openalan.com/download/mac) · [**Download for Windows**](https://openalan.com/download/windows) · [**Discord**](https://discord.gg/jBQCPUsVE) · [openalan.com](https://openalan.com) · [X @alexhvnsen](https://x.com/alexhvnsen)

[![Discord](https://img.shields.io/badge/Discord-Alan%27s%20Way-5865F2?logo=discord&logoColor=white)](https://discord.gg/jBQCPUsVE) [![GitHub stars](https://img.shields.io/github/stars/capthvnsen/alans-way?style=social)](https://github.com/capthvnsen/alans-way)

Latest release: **[v0.21.13](https://github.com/capthvnsen/alans-way/releases/tag/v0.21.13)** (Oct 27, 2026). Star the repo if this is useful. It's the cheapest way to help.

A desktop app for people running [Hermes Agent](https://github.com/NousResearch/hermes-agent) on a server (Linux VPS, or a macOS VM via [Tart](https://tart.run)) who want to watch, steer, and lend their agents a local browser, without giving up the keyboard. The app runs on macOS (Apple Silicon), Windows 10/11 x64 or Linux x64.

**Tailscale is required.** It is the backbone: your computer, your server and any remote agent talk over your Tailscale network and nothing else. Install Tailscale on your computer and your server and sign in to the same account. SSH addresses must be Tailscale names (`*.ts.net`) or Tailscale IPs (`100.64.0.0/10`); the setup scripts refuse public addresses, and the server's SSH key can log in to your computer only from the tailnet.

## Core features

1. **A simple chat with a real browser.** Your Telegram bot chats sit on the left and real Chromium tabs on the right, like the browser in the ChatGPT desktop app. Each bot gets a colored, named cursor in its own tabs, so you can watch it click around. "Take over" a tab and every queued agent action on it is cancelled. Bots only see tabs you own or grant. [Desktop guide](desktop/README.md)
2. **Fast computer use over MCP.** Agents get browser tools (`cua_alans_way_*`) for the Workspace browser and desktop tools (`workspace_computer_*`) for apps on your Mac or PC, built to match Codex-level computer use and to stay fast when the agent runs on a remote server. Agents drive background apps and tabs without moving your cursor. [Integration](desktop/docs/integration.md) · [Parity with Hermes](docs/remote-agent-cu-parity.md)
3. **Close the lid, keep working.** With the [agent plugin](https://github.com/capthvnsen/alans-way-agents), *new* browser and desktop work goes to the VM when your computer is unreachable, and work already running on the VM continues. **Not shipped yet:** moving in-flight work. An action that is running on your computer when it sleeps fails visibly; its tab stays there and can be inspected or resumed after you reconnect. There is no "Move to VM" button yet. [VM browser](desktop/docs/vps-browser.md) · [Handoff status](desktop/docs/integration.md#browser-task-handoff)
4. **A live view of the VM desktop.** A mini preview of your server's desktop floats in the corner. Drag it anywhere, expand it, hide it, or switch to **Take control** to drive it yourself. Linux servers use a noVNC viewer you already run; macOS guest VMs use `scripts/mac-vm-preview.sh`. [macOS guest VM](docs/mac-vm-guest.md)
5. **The same threads on any device.** Telegram stays stock: your Hermes gateway owns the bot conversation and the app embeds the official Telegram Web client, so the same chat is on your phone. Other agents keep their threads in their own app. Grok Bot, for example, uses the Workspace tools from the Grok Bot app. An iOS app is in development in [`ios/`](ios/README.md).
6. **Add-on tools for production Hermes and Grok Bot, no forks.** The Hermes side is a stock plugin, [alans-way-agents](https://github.com/capthvnsen/alans-way-agents), installed into your existing gateway. Grok Bot and other MCP clients connect through a custom connector, over SSH through Tailscale. [Remote agents](desktop/docs/remote-agents.md)
7. **Proactivity.** With the plugin, when the chat with your primary bot has been quiet for two hours it checks in once: it does one safe, reversible thing toward your goals and reports it, suggests something, asks one useful question, or stays silent. Check-ins land only between 08:00 and 22:00 in your timezone and never mid-task. Each unanswered one doubles the wait, and any reply resets it. Consequential actions (external messages, purchases, credential or permission changes, production changes, destructive operations) always need your approval.

The app works without the plugin (manual tab sharing), and the plugin falls back to VM-only browsing when the app isn't running. Nothing here provisions email, calendar, Notion or similar accounts: those exist only if you install and authorize them in Hermes yourself.

| Repo | What it is | Who installs it |
|---|---|---|
| **alans-way** (this one) | The desktop app (macOS/Windows/Linux) + companion CLI | You, on your computer |
| [alans-way-agents](https://github.com/capthvnsen/alans-way-agents) | The plugin: idle check-ins, workspace skill, auto-routing, remote-agent router | Your Hermes gateway (VPS or macOS VM) |

## Requirements

This is not a standalone app. It pairs with a Hermes setup you already have running. Before installing:

- **A [Hermes Agent](https://github.com/NousResearch/hermes-agent) gateway already running** on a server (Linux VPS, or a macOS VM via [Tart](https://tart.run)), with Telegram (or another supported platform) already connected to it.
- **[Tailscale](https://tailscale.com)**, installed and signed into the same account on both your computer and that server.
- **Your computer**: macOS (Apple Silicon), Windows 10/11 x64, or Linux x64 with a desktop session (systemd, Node 22.12+ and git for the build-from-source step). Mac and Windows get signed, one-click installers; Linux currently builds from source, x86_64 only.
- SSH access from the server to your computer (Remote Login on Mac, an SSH server on Linux; the setup wizard tests it).

If you don't have a Hermes gateway yet, set that up first, then come back here.

## Quick start

**Download Alan's Workspace:** [Mac (Apple Silicon)](https://openalan.com/download/mac) or [Windows 10/11 x64](https://openalan.com/download/windows). The Mac build is signed and notarized, so it opens like any other app. Open it, sign in to Telegram, and the setup wizard hands you one prompt for your Hermes agent. The app updates itself after that.

**Or from a terminal.** On your Mac:

```sh
curl -fsSL https://openalan.com/install-mac | sh
```

It builds and opens the app, then asks to connect your Hermes server. Type the server's SSH address (for example `root@hermes-vps`) and it does the rest from your computer: trusts both machines' keys, installs the agent plugin on the server, restarts the gateway and checks SSH both ways. The plugin's setup asks its own questions as it goes. It ends with the steps still left for you, in order. Re-run it any time to upgrade or reconnect.

On Linux (x64, systemd, desktop session, Node 22.12+ and git), the same flow builds the app too:

```sh
curl -fsSL https://raw.githubusercontent.com/capthvnsen/alans-way/main/scripts/connect-server.sh | sh
```

Alan's Workspace for Linux is x86_64 only; 64-bit ARM Linux is not supported yet.

No Telegram bot on your Hermes server yet? Run `hermes gateway setup` there first. On Windows, or with no SSH access to the server, use [Connect your agents](#connect-your-agents) instead.

## Install the app

**Setting this up with an AI agent?** Point it at [docs/setup-for-agents.md](docs/setup-for-agents.md): one page covering the desktop app, the server and the Hermes plugin, with a check after every stage and the exact steps that need you.

**Download it:** [Mac (Apple Silicon)](https://openalan.com/download/mac) ·
[Windows 10/11 x64](https://openalan.com/download/windows). Both links always
serve the newest release. Open it and the setup wizard walks you through
Telegram sign-in and hands you one prompt for your Hermes agent. The app
updates itself after that.

Mac release builds are Developer ID signed and notarized, so they open like any other app. Windows builds are unsigned: if SmartScreen appears, click **More info → Run anyway**.

**Or build from source.** On a Mac one command builds the app, installs it to `/Applications` and opens it; re-run it to upgrade. Without git or Node it downloads the source and a private, checksum-verified Node for the build. In a terminal it then offers to connect your server (see [Quick start](#quick-start)):

```sh
curl -fsSL https://openalan.com/install-mac | sh
```

On Windows, same idea in PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -c "irm https://openalan.com/install-windows | iex"
```

It builds the app into `%LOCALAPPDATA%\Programs\alans-way-localapp` and opens it. Or run `scripts/install-windows.ps1` from a clone of this repo. Local and fork builds are ad-hoc signed (Mac) or unsigned (Windows), but they are built on your machine, so they skip the Gatekeeper and SmartScreen prompts.

On Linux (x64, systemd, with a desktop session), run the [Quick start](#quick-start) command, or `scripts/connect-linux.sh` from the command in [docs/setup-prompt.md](docs/setup-prompt.md). It checks Tailscale and the SSH server, builds the app with `npm run package:linux` into `~/.local/share/alans-way-localapp`, and starts it. It needs Node 22.12+ and git.

Sign into Telegram inside the app, and your existing bots appear in the sidebar.

**Mac permissions (once, on the Mac itself).** Controlling other desktop apps needs two macOS permissions for the Alan's Workspace app:

1. Open System Settings, Privacy & Security, Accessibility, and turn on **Alan's Workspace (listed as alans-way-localapp)**. If it is not listed, click +, choose `/Applications/alans-way-localapp.app`, and turn it on.
2. In Privacy & Security, Screen Recording (named Screen & System Audio Recording on macOS 15 and later), turn on **Alan's Workspace** the same way.

Do this at the Mac itself: macOS only creates these entries from a real login session. Grant the app, not Terminal, `sshd` or Node. The agent's SSH session only relays requests to the app, and the app runs the helper (built from `desktop/scripts/mac-computer.swift`) that reads other apps, so remote SSH sessions need no grant of their own. The first time an agent is refused, macOS shows its own prompt for the app; Settings in the app also shows both statuses with buttons that open the right System Settings panes. After you reinstall or upgrade, macOS can treat the rebuilt app as new: if desktop control stops working, switch both entries off and on again. Browser tabs need neither permission. A macOS VM guest is different: grant `mac-computer` inside the VM, as described in [macOS guest VM](docs/mac-vm-guest.md).

On Windows and Linux, closing the window keeps the app running in the system tray so your bots keep their browser, as it does on a Mac. Use the tray icon's **Quit** to stop it. GNOME needs the AppIndicator extension to show a tray icon.

For development, run from source instead: `cd desktop && npm ci && npm start`
(see the [desktop guide](desktop/README.md)).

## Connect your agents

**Let your cloud agent do it (recommended).** The app's setup wizard (or **Settings → Agent setup → Copy setup prompt**) gives you a prompt to paste to your Hermes bot. It points at [docs/setup-prompt.md](docs/setup-prompt.md) through `openalan.com/agent-prompt`, so it stays current as setup changes. Without the app open, this works too:

```text
Set up Alan's Workspace. Repo: https://github.com/capthvnsen/alans-way
Fetch https://raw.githubusercontent.com/capthvnsen/alans-way/main/docs/setup-prompt.md and follow the text block in it exactly. Do not modify Hermes. Never print secrets.
```

**Updating your agent.** After the app updates, send your bot the prompt from **Settings → Agent setup → Copy agent update prompt**. It follows [docs/update-for-agents.md](docs/update-for-agents.md): pull the plugin, re-run its setup with the same values, verify, restart.

**Or by hand, in the app:** **Settings → Agent setup**: the checklist shows what's already done.

1. Fill in both SSH addresses (your VPS, and how the VPS reaches this computer, Tailscale name or IP).
2. Click **Copy setup command** and paste it in a terminal on the VPS: one bootstrap installs the plugin, wires the browser, restarts the gateway, and offers to bind your primary bot. (Never configured Telegram on Hermes? The bootstrap walks you through the QR-code setup.)
3. Click **Test agent path**: the app verifies VPS → this computer over SSH end-to-end.

The bot then has browser tools (`cua_alans_way_*`) that open tabs you can watch, and desktop tools (`workspace_computer_*`) for background apps.
The plugin's `workspace-setup` skill teaches installed agents the same playbook.

**Other agents (Grok Bot or any MCP client):** the client's computer joins your tailnet and reaches the VM over SSH, where a restricted key can start the workspace router and nothing else. See [remote agents](desktop/docs/remote-agents.md) for setup, the HTTP fallback and desktop approval.

## Upgrading

Release installs update themselves. When an update is ready, the popup updates every saved VM over SSH first (Hermes plugins per profile, one gateway restart if plugin code changed), then the app. Any VM left behind gets a retry banner until it catches up.

`git pull` + `cd desktop && npm ci` applies only to source installs. On the VPS, a manual update means pulling the plugin checkout and restarting the gateway through Hermes' normal lifecycle: a running gateway keeps old code until restarted. Then send one Telegram message and watch a bounded browser action to confirm both ends still work. See [deployment](docs/deployment.md) and the [multi-profile fleet guide](docs/agent-setup.md).

## Honest boundaries

- **Alpha software.** Bugs → [issues](https://github.com/capthvnsen/alans-way/issues).
- Agents think on the VPS. On your computer they can drive a background app or a browser tab. They do not take the app you are currently using, and they do not move your cursor. On Windows, elevated apps (Task Manager, UAC, the lock screen) are unreachable by design.
- Browser input goes through Chromium's debugger into one tab. Other apps are read as buttons and text first; a click uses that control and does not move your cursor. Keychain and password fields are refused.
- One exception: in the VPS preview, "Take control" mode *does* send your clicks to the remote desktop. That's the point of it.
- Telegram sending rides the embedded Telegram Web client. If sends stall, Settings → **Sync Telegram bots** reloads the session.

## Development

An iOS development app now lives in [`ios/`](ios/README.md), with a native Telegram bot chat interface, an embedded Telegram voice Mini App host, and a configurable desktop viewer. The Mini App and Hermes voice plugin are in [`mobile/`](mobile/README.md). See the iOS guide for Xcode builds, Telegram application credentials, and the live gateway/device checks still needed before release.

```sh
# Desktop app
cd desktop && npm ci && npm run check && npm start

# Companion CLI (optional: file tools + diagnostics)
python3 -m venv .venv && .venv/bin/pip install -e '.[mcp]'
.venv/bin/python -m unittest discover -s tests -v
```

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request and [SECURITY.md](SECURITY.md) to report a vulnerability. Design docs live in [`docs/`](docs/): [setup for agents](docs/setup-for-agents.md), [multi-profile fleets](docs/agent-setup.md), [security model](docs/mac-security.md), [integration](desktop/docs/integration.md), [remote agents](desktop/docs/remote-agents.md). Questions or ideas: [Discord](https://discord.gg/jBQCPUsVE).

## License

Desktop app: [GPL-3.0](desktop/LICENSE) · Companion CLI: [MIT](LICENSE) · Agent plugin: [MIT](https://github.com/capthvnsen/alans-way-agents/blob/main/LICENSE)

Independent community project. Not affiliated with Nous Research.

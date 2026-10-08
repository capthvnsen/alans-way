# Hermes Alan's Way

**The open-source Grokbot killer.** A companion app and plugin for stock Hermes. Your bots live on a VM or VPS and work on your Mac or PC, on your terms.

The app is called **OpenAlan**.

[**Download for Mac**](https://openalan.com/download/mac) · [**Download for Windows**](https://openalan.com/download/windows) · [openalan.com](https://openalan.com) · [Discord](https://discord.gg/jBQCPUsVE) · [X @alexhvnsen](https://x.com/alexhvnsen)

[![GitHub stars](https://img.shields.io/github/stars/capthvnsen/alans-way?style=social)](https://github.com/capthvnsen/alans-way)

Star the repo if this is useful. It's the cheapest way to help.

Join the Discord to contribute or report bugs. Follow and DM the creator on X.

A desktop app for people running [Hermes Agent](https://github.com/NousResearch/hermes-agent) on a server (Linux VPS, or a macOS VM via [Tart](https://tart.run)) who want to watch, steer, and lend their agents a local browser, without giving up the keyboard. The app itself runs on macOS (Apple Silicon), Windows 10/11 x64 or Linux x64.

**Tailscale is required.** Your computer and your server talk over your Tailscale network and nothing else. Install Tailscale on both and sign in to the same account. SSH addresses must be Tailscale names (`*.ts.net`) or Tailscale IPs (`100.64.0.0/10`); the setup scripts refuse public addresses, and the server's SSH key can log in to your computer only from the tailnet.

## Quick start

On your Mac, in Terminal:

```sh
curl -fsSL https://openalan.com/install-mac | sh
```

It builds and opens the app, then asks to connect your Hermes server. Type the server's SSH address (for example `root@hermes-vps`) and it does the rest from your computer: trusts both machines' keys, installs the plugin on the server, restarts the gateway and checks SSH both ways. The plugin's setup asks its own questions as it goes. Re-run it any time to upgrade or reconnect.

On Linux (x64, systemd, desktop session, Node 22.12+ and git), the same flow builds the app too:

```sh
curl -fsSL https://raw.githubusercontent.com/capthvnsen/alans-way/main/scripts/connect-server.sh | sh
```

Before you start: Tailscale on both machines with the same account, Remote Login on (Mac: System Settings, General, Sharing) or an SSH server (Linux), and `ssh <server>` working from this terminal. On Windows, or with no SSH access to the server, use [Connect your agents](#connect-your-agents) instead.

## What you get

- **See every bot's cursor.** Each agent gets a colored, named cursor in its tabs. You can literally watch it click around.
- **Agents get their own browser, not yours.** Bot tabs are separate Chromium views. Your mouse, keyboard, clipboard, and other apps are never touched.
- **Grab the wheel anytime.** "Take over" a tab and every queued agent action on it is cancelled instantly.
- **A window into the VPS.** A mini preview of your server's desktop floats in the corner. Drag it anywhere, hide it, or click to take control.
- **Shut your laptop, keep working.** With the [agent plugin](https://github.com/capthvnsen/alans-way-agents), *new* browser work routes to the VPS when your computer is unreachable. An in-flight host action fails visibly; its live tab stays on the host and can be inspected or resumed after reconnecting. Work already running on the VPS continues. (Backend checkpoint/restore plumbing exists, but the app exposes no cross-host handoff button yet.)
- **Explicit permissions.** Bots only see tabs you own or grant. Extension account pages are human-only. Nothing is shared unless you share it.

## The two repos

| Repo | What it is | Who installs it |
|---|---|---|
| **alans-way** (this one) | The desktop app (macOS/Windows/Linux) + companion CLI | You, on your computer |
| [alans-way-agents](https://github.com/capthvnsen/alans-way-agents) | The plugin: idle check-ins, workspace skill, auto-routing | Your Hermes gateway (VPS or macOS VM) |

The app works without the plugin (manual tab sharing), and the plugin falls back to VPS-only browsing when the app isn't running.

## How the pieces fit

- **Telegram stays stock.** Your existing Hermes gateway on the VPS keeps owning the bot conversation end to end. This app embeds the official Telegram Web client so you can chat and watch. It is not a second gateway and never polls the bot token.
- **Host browser.** The app's own Chromium tabs are the bots' window into your computer, driven per-tab through Chromium's debugger by a loopback-only connector.
- **VPS browser.** A separate managed Chromium on the server handles cloud work and is the fallback for *new* tasks when your computer is asleep. It does not absorb in-flight host tabs: those block and resume.
- **Remote desktop preview.** Optional. On a Linux server it needs a VNC server plus a noVNC (WebSocket) viewer you already run, the app only embeds the viewer URL you paste in. On a macOS guest VM, `scripts/mac-vm-preview.sh` bridges Tart's VNC display into the same view. Its **Take control** mode is the one place your input is forwarded to the remote desktop.
- **Plugin proactivity is idle check-ins.** When the chat with the optional primary bot has been quiet for two hours, it checks in once: it does one safe, reversible thing toward your goals and reports it, suggests something it could do, or asks one useful question, or stays silent. Check-ins land only between 08:00 and 22:00 in your timezone and never mid-task; each one left unanswered doubles the wait (toward roughly weekly) and any reply resets it. Consequential actions (external messages, purchases, credential or permission changes, production changes, destructive operations) always require your approval.
- **No bundled account connections.** Email, calendar, Notion and similar tools exist only if you install and authorize them separately in Hermes, nothing here provisions them.

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

**Mac permissions (once, on the Mac itself).** Controlling other desktop apps needs two macOS permissions for the Alan's Way app:

1. Open System Settings, Privacy & Security, Accessibility, and turn on **alans-way-localapp**. If it is not listed, click +, choose `/Applications/alans-way-localapp.app`, and turn it on.
2. In Privacy & Security, Screen Recording (named Screen & System Audio Recording on macOS 15 and later), turn on **alans-way-localapp** the same way.

Do this at the Mac itself: macOS only creates these entries from a real login session. Grant the app, not Terminal, `sshd` or Node. The agent's SSH session only relays requests to the app, and the app runs the helper (built from `desktop/scripts/mac-computer.swift`) that reads other apps, so remote SSH sessions need no grant of their own. The first time an agent is refused, macOS shows its own prompt for the app; Settings in the app also shows both statuses with buttons that open the right System Settings panes. After you reinstall or upgrade, macOS can treat the rebuilt app as new: if desktop control stops working, switch both entries off and on again. Browser tabs need neither permission. A macOS VM guest is different: grant `mac-computer` inside the VM, as described in [macOS guest VM](docs/mac-vm-guest.md).

On Windows and Linux, closing the window keeps the app running in the system tray so your bots keep their browser, as it does on a Mac. Use the tray icon's **Quit** to stop it. GNOME needs the AppIndicator extension to show a tray icon.

For development, run from source instead: `cd desktop && npm ci && npm start`
(see the [desktop guide](desktop/README.md)).

## Connect your agents

**Let your cloud agent do it (recommended).** The app's setup wizard (or **Settings → Agent setup → Copy setup prompt**) gives you a prompt to paste to your Hermes bot. It points at [docs/setup-prompt.md](docs/setup-prompt.md) through `openalan.com/agent-prompt`, so it stays current as setup changes. Without the app open, this works too:

```text
Set up Alan's Way. Repo: https://github.com/capthvnsen/alans-way
Fetch https://raw.githubusercontent.com/capthvnsen/alans-way/main/docs/setup-prompt.md and follow the text block in it exactly. Do not modify Hermes. Never print secrets.
```

**Updating your agent.** After the app updates, send your bot the prompt from **Settings → Agent setup → Copy agent update prompt**. It follows [docs/update-for-agents.md](docs/update-for-agents.md): pull the plugin, re-run its setup with the same values, verify, restart.

**Or by hand, in the app:** **Settings → Agent setup**: the checklist shows what's already done.

1. Fill in both SSH addresses (your VPS, and how the VPS reaches this computer, Tailscale name or IP).
2. Click **Copy setup command** and paste it in a terminal on the VPS: one bootstrap installs the plugin, wires the browser, restarts the gateway, and offers to bind your primary bot. (Never configured Telegram on Hermes? The bootstrap walks you through the QR-code setup.)
3. Click **Test agent path**: the app verifies VPS → this computer over SSH end-to-end.

The bot then has browser tools (`cua_alans_way_*`) that open tabs you can watch, and desktop tools (`workspace_computer_*`) for background apps.
The plugin's `workspace-setup` skill teaches installed agents the same playbook.

## Upgrading

Release installs update themselves. When an update is ready, the popup updates every saved VM over SSH first (Hermes plugins per profile, one gateway restart if plugin code changed), then the app. Any VM left behind gets a retry banner until it catches up.

`git pull` + `cd desktop && npm ci` applies only to source installs. On the VPS, a manual update means pulling the plugin checkout and restarting the gateway through Hermes' normal lifecycle: a running gateway keeps old code until restarted. Then send one Telegram message and watch a bounded browser action to confirm both ends still work. See [deployment](docs/deployment.md) and the [multi-profile fleet guide](docs/agent-setup.md).

## Roadmap

The roadmap lives in the [GitHub project](https://github.com/users/capthvnsen/projects/5) for this repo. The fastest updates are on X: [@alexhvnsen](https://x.com/alexhvnsen).

Short-term themes, all in progress or planned:

- Make v0.3 rock solid on Mac and PC: remote computer polish, proactivity, smoother handoff.
- Network routing of remote tasks through your primary machine.
- Faster and cheaper runs (optional).
- Phone your agent with local voice models, without interrupting Telegram.

## Hosting

DIY is free. Host Hermes on Orgo and get 25% off the first 3 months: [orgo.ai/?r=alan](https://orgo.ai/?r=alan).

Or take the $79.95/mo Support Plan: your own Orgo cloud computer (up to 8GB RAM), seamless automated setup, 1:1 support, 2,000+ fast browser and scraping tasks a month and 250 voice minutes. You can bring your existing agent. Details at [openalan.com/#pricing](https://openalan.com/#pricing).

## Honest boundaries

- **Alpha software.** Tested on the author's setup; yours may differ. Bugs → [issues](https://github.com/capthvnsen/alans-way/issues).
- Agents think on the VPS. On your computer they can drive a background app or a browser tab. They do not take the app you are currently using, and they do not move your cursor. On Windows, elevated apps (Task Manager, UAC, the lock screen) are unreachable by design.
- Browser input goes through Chromium's debugger into one tab. Other apps are read as buttons and text first; a click uses that control and does not move your cursor. Keychain and password fields are refused.
- One exception: in the VPS preview, "Take control" mode *does* send your clicks to the remote desktop. That's the point of it.
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

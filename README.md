# Hermes — Alan's Way

**Your AI agents live on a VPS. This gives them a window into your Mac — on your terms.**

JOIN THE DISCORD TO CONTRIBUTE OR SUBMIT BUGS: https://discord.gg/jBQCPUsVE
Follow and DM the creator here: https://x.com/alexhvnsen

A desktop app for people running [Hermes Agent](https://github.com/NousResearch/hermes-agent) on a Linux server who want to watch, steer, and lend their agents a local mac browser — without giving up the keyboard.



## What you get

- **See every bot's cursor.** Each agent gets a colored, named cursor in its tabs. You can literally watch it click around.
- **Agents get their own browser, not yours.** Bot tabs are separate Chromium views — your mouse, keyboard, clipboard, and other apps are never touched.
- **Grab the wheel anytime.** "Take over" a tab and every queued agent action on it is cancelled instantly.
- **A window into the VPS.** A mini preview of your server's desktop floats in the corner. Drag it anywhere, hide it, or click to take control.
- **Shut your laptop, keep working.** With the [agent plugin](https://github.com/capthvnsen/alans-way-agents), *new* browser work routes to the VPS when the Mac is unreachable. An in-flight Mac action fails visibly; its live tab stays on the Mac and can be inspected or resumed after reconnecting. Work already running on the VPS continues. (Backend checkpoint/restore plumbing exists, but the app exposes no cross-host handoff button yet.)
- **Explicit permissions.** Bots only see tabs you own or grant. Extension account pages are human-only. Nothing is shared unless you share it.

## The two repos

| Repo | What it is | Who installs it |
|---|---|---|
| **alans-way** (this one) | The Mac desktop app + companion CLI | You, on your Mac |
| [alans-way-agents](https://github.com/capthvnsen/alans-way-agents) | The plugin: proactivity, workspace skill, auto-routing | Your Hermes gateway (VPS) |

The app works without the plugin (manual tab sharing), and the plugin falls back to VPS-only browsing when the app isn't running.

## How the pieces fit

- **Telegram stays stock.** Your existing Hermes gateway on the VPS keeps owning the bot conversation end to end. This app embeds the official Telegram Web client so you can chat and watch — it is not a second gateway and never polls the bot token.
- **Mac browser.** The app's own Chromium tabs are the bots' window into your Mac, driven per-tab through Chromium's debugger by a loopback-only connector.
- **VPS browser.** A separate managed Chromium on the server handles cloud work and is the fallback for *new* tasks when the Mac is asleep. It does not absorb in-flight Mac tabs — those block and resume.
- **VPS desktop preview.** Optional, and it needs a VNC server plus a noVNC (WebSocket) viewer you already run on the VPS — the app only embeds the viewer URL you paste in. Its **Take control** mode is the one place your input is forwarded to the remote desktop.
- **Plugin proactivity is read/research/draft by default.** The optional primary bot reviews its own work and drafts suggestions on a bounded budget; consequential actions (external messages, purchases, credential or permission changes, production changes, destructive operations) always require your approval.
- **No bundled account connections.** Email, calendar, Notion and similar tools exist only if you install and authorize them separately in Hermes — nothing here provisions them.

## Install the app

**Setting this up with an AI agent?** Point it at [docs/setup-for-agents.md](docs/setup-for-agents.md) — one page covering the Mac app, the VPS and the Hermes plugin, with a check after every stage and the exact steps that need you.

Requires an Apple Silicon Mac. One command builds the app, installs it to
`/Applications` and opens it; re-run it to upgrade. Without git or Node it
downloads the source and a private, checksum-verified Node for the build:

```sh
curl -fsSL https://openalan.com/install-mac | sh
```

Sign into Telegram inside the app, and your existing bots appear in the sidebar.

For development, run from source instead: `cd desktop && npm ci && npm start`
(see the [desktop guide](desktop/README.md)).

## Connect your agents

**Let your cloud agent do it (recommended).** Paste this prompt to the agent
that has a terminal on the server running your Hermes gateway — your Hermes
bot itself works. It connects the server and your Mac over Tailscale, installs
the app and the [Hermes plugin](https://github.com/capthvnsen/alans-way-agents),
and proves both ends work. It asks you for four things on the Mac and never
for a secret. ([Same prompt, with notes](docs/setup-prompt.md).)

```text
Set up Alan's Way for me. This server runs my Hermes gateway; connect it to my
Mac over Tailscale, install the Alan's Way app on the Mac and the alans-way
Hermes plugin here, and prove it works. Do not modify Hermes itself.
Reference: https://github.com/capthvnsen/alans-way/blob/main/docs/setup-for-agents.md

Rules for the whole job:
- Never print, paste or ask me for secrets (bot tokens, auth keys, passwords).
  Only public keys, addresses and names go in chat.
- Do everything you can yourself. When a step needs me, give me short numbered
  instructions, then wait for my reply.
- Run each step's check. Do not continue past a failing check; fix it or tell
  me exactly what failed.
- Commands here run without a terminal, so pass --non-interactive to setup.sh
  and ask me any question it would have asked.

1. Preflight, on this server. Confirm Linux, `hermes --version` (0.21 or
   newer), `node -v` (22 or newer), git and python3. Install whatever is
   missing except Hermes. Find the Hermes home ($HERMES_HOME, default
   ~/.hermes) and which profile this bot is (`hermes profile list`). The
   default profile's files are in the Hermes home; others are in
   <home>/profiles/<name>/. Note BOT_ID, the digits before ":" in that
   profile's TELEGRAM_BOT_TOKEN, read without printing the token:
     sed -n 's/^TELEGRAM_BOT_TOKEN=\([0-9]*\):.*/\1/p' <profile dir>/.env
   If there is no token yet, tell me; we will run `hermes gateway setup`
   together first.

2. Tailscale, on this server. If `tailscale status` does not show it
   connected: install it (curl -fsSL https://tailscale.com/install.sh | sh),
   run `nohup tailscale up --hostname=hermes-vps > /tmp/tailscale-up.log 2>&1 &`,
   send me the login URL from that log to open, and poll `tailscale status`
   until it is connected. Do not ask me for an auth key. Then note
   VPS_SSH = <this user>@<first line of `tailscale ip -4`>.

3. SSH keys, on this server. Create ~/.ssh/id_ed25519 (no passphrase) if it is
   missing, and make sure sshd is running and accepts key logins. Note
   VPS_KEY = `cut -d' ' -f1,2 ~/.ssh/id_ed25519.pub` plus " <this user>@vps",
   and VPS_HOST_KEY = `cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub`.

4. My Mac. Send me these steps with the command filled in, then wait:
   1. Install Tailscale from https://tailscale.com/download and sign in with
      the same account as this server.
   2. Open System Settings → General → Sharing and turn on Remote Login.
   3. Open Terminal, paste this line and press Return. The first run builds
      the app and takes a few minutes:
      curl -fsSL https://raw.githubusercontent.com/capthvnsen/alans-way/main/scripts/connect-mac.sh | sh -s -- --vps '<VPS_SSH>' --vps-host-key '<VPS_HOST_KEY>' --vps-key '<VPS_KEY>'
   4. Copy the lines it prints between the ===== markers and send them to me.
   5. In the Alan's Way app that opened, sign in to Telegram with the QR code
      (on your phone: Telegram → Settings → Devices → Link Desktop Device).
   If the script stops, it says why in one line; tell me that line.

5. Trust both ways, on this server, using MAC_SSH, MAC_HOST_KEY and MAC_KEY
   from my reply. Append "<host part of MAC_SSH> <MAC_HOST_KEY>" to
   ~/.ssh/known_hosts and MAC_KEY to ~/.ssh/authorized_keys, each only if not
   already there. Check both directions:
     ssh -o BatchMode=yes -o StrictHostKeyChecking=yes '<MAC_SSH>' 'test -x /Applications/alans-way-localapp.app/Contents/MacOS/alans-way-localapp && echo MAC_OK'
     ssh -o BatchMode=yes -o StrictHostKeyChecking=yes '<MAC_SSH>' "ssh -o BatchMode=yes -o StrictHostKeyChecking=yes '<VPS_SSH>' echo VPS_OK"
   Expect MAC_OK, then VPS_OK.

6. Ask me first: "Should your bot be allowed to message you first, with
   check-ins and follow-ups (at most a few a day, never 22:00–08:00)?" Then
   install the plugin:
     git clone https://github.com/capthvnsen/alans-way-agents ~/alans-way-agents 2>/dev/null || git -C ~/alans-way-agents pull --ff-only
     ~/alans-way-agents/setup.sh --non-interactive --bot-id <BOT_ID> --mac-ssh '<MAC_SSH>' --timezone '<MAC_TZ>' --bind --proactive <yes|no> [--profile <profile> unless it is default]
   If it says there are no Telegram DM sessions yet, ask me to message the bot
   once, then run the same command again. If it prints an apt-get line for a
   display stack, show me that line and ask before installing anything.
   Then restart the gateway so it loads the plugin. If you are this Hermes
   bot, first tell me "Restarting now; send me any message in a minute to
   continue", then run `hermes gateway restart`. Otherwise run it and wait
   until `hermes gateway status` reports it running.

7. Verify: `~/alans-way-agents/setup.sh --verify [--profile <profile>]` must
   end with "setup: all required checks passed". Then ask me to:
   1. In the Alan's Way app open Settings → Agent setup, enter '<VPS_SSH>' as
      the VPS address and '<MAC_SSH>' as this Mac's address, click Save
      addresses, then Test agent path. It should say "VPS reaches this Mac over
      ssh".
   2. Message the bot in the app: "Open example.com in the workspace browser
      and tell me the page title." A tab with the bot's cursor should appear
      and the reply should say "Example Domain".

Finish with a short report: what passed, every warning from setup.sh, and
anything you skipped or that still needs me.
```

**Or by hand, in the app:** **Settings → Agent setup** — the checklist shows what's already done.

1. Fill in both SSH addresses (your VPS, and how the VPS reaches this Mac — Tailscale name or IP).
2. Click **Copy setup command** and paste it in a terminal on the VPS — one bootstrap installs the plugin, wires the browser, restarts the gateway, and offers to bind your primary bot. (Never configured Telegram on Hermes? The bootstrap walks you through the QR-code setup.)
3. Click **Test agent path** — the app verifies VPS → Mac SSH end-to-end.

The bot then has a `workspace_browser` tool that opens tabs you can watch.
The plugin's `workspace-setup` skill teaches installed agents the same playbook.

## Upgrading

Fresh installs and upgrades follow the same path: pull the repo, `cd desktop && npm ci`, restart the app. On the VPS, update the plugin checkout and restart the gateway through Hermes' normal lifecycle — a running gateway keeps old code until restarted. Then send one Telegram message and watch a bounded browser action to confirm both ends still work. See [deployment](docs/deployment.md) and the [multi-profile fleet guide](docs/agent-setup.md) for details.

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

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request and [SECURITY.md](SECURITY.md) to report a vulnerability. Design docs live in [`docs/`](docs/) — [setup for agents](docs/setup-for-agents.md), [multi-profile fleets](docs/agent-setup.md), [security model](docs/mac-security.md), [integration](desktop/docs/integration.md).

## License

Desktop app: [GPL-3.0](desktop/LICENSE) · Companion CLI: [MIT](LICENSE) · Agent plugin: [MIT](https://github.com/capthvnsen/alans-way-agents/blob/main/LICENSE)

Independent community project. Not affiliated with Nous Research.

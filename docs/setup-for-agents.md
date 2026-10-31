# Set up Alan's Workspace (instructions for an AI agent)

This is the **Hermes installation path** through [Alan's Way's four products](../README.md#what-to-install): **Alan's Workspace** on the person's computer, **Alan's CU MCP** (`workspace-mcp`, the Node server at `desktop/scripts/browser-mcp.cjs`) on the tool host, and **Alan's Plugin for Hermes** (`alans-way` and its provider from `alans-way-agents`) on the existing gateway/VM. The VM is infrastructure, not another product. The server stays in this repo.

For **Alan's Plugin for Grok Bot**, use the [Grok package status](../README.md#4-alans-plugin-for-grok-bot) and [remote-agent connector guide](../desktop/docs/remote-agents.md) instead. Grok Bot cannot load Hermes plugins. Both plugin products read one shared persona/voice/proactivity/identity config spec in the agents repo; its canonical path and the Grok package install path remain [TODOs](products.md#shared-config-contract). This guide does not install that package or a new shared config implementation.

Work through the Hermes stages in order. Each stage ends
with a check; do not continue past a failing check.

This guide is written for a Mac as the user's computer. When it is a Windows
PC instead (Windows 10/11 x64), substitute per stage: `install-windows.ps1`
for stage 1, `connect-windows.ps1` for stage 2 (elevated PowerShell — it
installs OpenSSH Server itself), `--host-os windows` on `setup.sh` in stage 3,
and the PC-side check commands noted inline. When it is a Linux computer
(x64, systemd, desktop session), skip the stage 1 installer, run
`connect-linux.sh` in stage 2 (it builds and installs the app), and pass
`--host-os linux` in stage 3. Everything else is identical.

Everything runs over the user's Tailscale network. The VPS and the user's
computer must be signed in to the same tailnet, and every SSH address you pass
is a Tailscale name (`*.ts.net`) or IP (`100.64.0.0/10`). The connect scripts
refuse any other address.
When Hermes runs on a macOS VM instead of a Linux VPS, see
[macOS guest VM](mac-vm-guest.md) for the guest-side differences.

Some steps need the human. When you reach one, stop, tell them exactly what to
do using the wording given, and wait for them to confirm.

Working only from the VPS, with no shell on the user's computer? Use the
[setup prompt](setup-prompt.md) instead: it covers the same stages with one
command the human pastes on their computer.

## What you need before starting

Ask the human for anything here you cannot discover yourself:

| Item | How to get it |
|---|---|
| Shell on the user's computer | You are running on it, or have SSH to it |
| Shell on the VPS | `ssh <vps>` works, or you are running on it |
| Numeric Telegram bot ID | Digits only. The part before `:` in the bot token, or `getMe` on the token |
| User's computer | Mac: Apple Silicon (`uname -m` prints `arm64`), Windows 10/11 x64, or Linux x64 with systemd (needs Node 22.12+ and git). On Mac and Windows git and Node are optional: the installers fetch what they need |
| VPS | Linux, Hermes 0.21+ (`hermes --version`), Node 22+, python3, git — or a macOS VM (see [mac-vm-guest.md](mac-vm-guest.md)) |

Optional: the human's Telegram bot already answers messages through Hermes. If
not, stage 3 offers to set that up.

## Stage 1 — Desktop app

If the person downloaded the app from https://openalan.com (Mac:
`/download/mac`, Windows: `/download/windows`) and it is open, skip this
stage and pass `--skip-install` / `-SkipInstall` to the connect script.
Otherwise build it on their computer:

On a Mac:

```sh
curl -fsSL https://openalan.com/install-mac | sh
```

On a Windows PC (**human step** — in an elevated PowerShell, from a clone of
this repo):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1
```

The Mac installer clones the repo into `~/alans-way`, builds the app, installs
it to `/Applications/alans-way-localapp.app`, opens it, and ends with
`install-mac: running — local browser API answers (mac <version>)`. Without
git it downloads the source as a tarball; without Node 22.12+ it downloads a
checksum-verified Node 22 into `~/.alans-way/node` for the build. A locally
built app is not quarantined, so macOS shows no Gatekeeper
warning. On Windows the script builds with `npm run package:win` and installs
under `%LOCALAPPDATA%\Programs\alans-way-localapp` — a local build needs no
code signature or SmartScreen bypass. Re-run the same command to upgrade;
sign-ins and settings live outside the app bundle and are kept on both OSes.

**Human step — tell them:** "The Alan's Workspace app is open. Sign in to Telegram in
the left pane with the QR code (Telegram on your phone → Settings → Devices →
Link Desktop Device). Tell me when your bots appear in the sidebar."

**Human step, Mac only, at the Mac itself and not over SSH. Tell them:**
"Open System Settings → Privacy & Security → Accessibility and turn on
**Alan's Workspace** (listed as `alans-way-localapp`). Then open Screen
Recording (called Screen & System Audio Recording on macOS 15 and later) and
turn it on there too. If it is not
listed, click + and choose `/Applications/alans-way-localapp.app`." These two
grants are what let the agent read and operate other apps. They belong to the
app, not to Terminal, `sshd` or Node: the SSH connector only relays, and the
app starts the helper (`mac-computer`) that macOS credits to it. If a prompt
names `mac-computer`, allow that too. After an upgrade macOS can treat the
rebuilt app as new; if desktop control stops, switch both entries off and on
again. Browser tabs work without either grant. On a macOS guest VM the grants
go to `mac-computer` inside the VM, see [macOS guest VM](mac-vm-guest.md).

**Check:** the app's local browser API answers. This runs the app's own
runtime, so it works without Node:

```sh
# macOS
ELECTRON_RUN_AS_NODE=1 /Applications/alans-way-localapp.app/Contents/MacOS/alans-way-localapp -e 'const c=require(process.env.HOME+"/Library/Application Support/Hermes Workspace/connection.json");fetch(c.url+"/v1/status",{headers:{Authorization:"Bearer "+c.token}}).then(r=>r.json()).then(s=>console.log(s.host,s.version))'
```

```powershell
# Windows
$env:ELECTRON_RUN_AS_NODE='1'; & "$env:LOCALAPPDATA\Programs\alans-way-localapp\alans-way-localapp.exe" -e "const c=require(process.env.APPDATA+'/Hermes Workspace/connection.json');fetch(c.url+'/v1/status',{headers:{Authorization:'Bearer '+c.token}}).then(r=>r.json()).then(s=>console.log(s.host,s.version))"
```

Expect `mac` or `windows` and a version number.

## Stage 2 — Let the VPS reach your computer over SSH

The VPS drives the host browser through SSH, so the user's computer needs an
SSH server — Remote Login on a Mac; the connect script installs OpenSSH Server
on Windows — and a private network address the VPS can reach (Tailscale
required: every SSH address is a tailnet name or IP).

**Human step — tell them:**
1. On a Mac: "Open System Settings → General → Sharing and turn on **Remote
   Login**." (On Windows the connect script below does this part itself.)
2. "Install Tailscale on your computer from tailscale.com/download and sign in
   with the same account the VPS uses." (Skip if `tailscale status` already
   works on both machines.)

SSH account setup is now an administrator task. Never collect a bot/agent
account's public key and install it into the human account: that grants access
to broker credentials regardless of API token binding. The combined
`connect-server.sh` wizard refuses this legacy flow.

Create mutually untrusted bots as separate non-root OS users without sudo.
Provision their identity-bound MCP exports as described in
[bot-auth.md](../desktop/docs/bot-auth.md). Configure the app's separate broker
SSH login and provision its access manually. **Check saved path** now tests
broker-to-computer SSH; it does not grant or prove bot access.

The platform connect scripts accept `--broker-key` (`-BrokerKey` on Windows)
only for a public key controlled by that trusted broker account. They still
grant shell access to the target human account, so never supply an agent key.
The old `--vps-key`/`-VpsKey` arguments are refused. Review existing authorized
keys and revoke old agent/shared keys separately; the app does not remove keys
without provenance. No key should be copied from a bot account.

Native control of a human GUI (including Terminal) is privileged human-account
access. Use a separate controlled desktop/session for untrusted bots; a token
boundary alone cannot isolate an app that runs in the broker's session.

## Stage 3 — VPS: Hermes plugin and cloud browser

Before continuing, an administrator must provision this bot's own non-root
SSH account on the controlled computer, with its identity-bound connection
file. Set `MAC_SSH` to that bot account's literal tailnet login and `MAC_TZ` to
the computer's timezone. It must not be the human/broker login from the saved
broker-path check. Use a plugin version that passes the per-bot connection
file explicitly; if that migration is not available, stop here rather than
falling back to a shared broker credential or human SSH account.

On the VPS:

```sh
git clone https://github.com/capthvnsen/alans-way-agents ~/alans-way-agents || git -C ~/alans-way-agents pull
~/alans-way-agents/setup.sh --bot-id <BOT_ID> --mac-ssh "$MAC_SSH" --timezone "$MAC_TZ" --restart
# add `--host-os windows` when the user's computer is a PC, `--host-os linux` for Linux
```

The script is safe to re-run. If `hermes plugins list` already shows
`alans-way`, add `--skip-plugin` so that catalogue copy stays. In a shell
without a terminal (most agents), add `--non-interactive --bind --proactive
<yes|no>` after asking the human the proactivity question below; add
`--profile <name>` for any profile other than `default`. It installs the
plugin and removes the old gateway startup hook, clones
this repository for the cloud browser, writes the browser services, configures
the `workspace_browser` MCP server (browser tools named `cua_alans_way_*`,
desktop tools named `workspace_computer_*`), restarts the gateway and offers to bind the
primary bot. Answer its prompts:

- "Run 'hermes gateway setup' now?" appears only when no Telegram bot token is
  configured. Say yes, then **human step — tell them:** "Scan the QR code shown
  in the terminal with Telegram to create or link the bot."
- "Bind a primary route?" — pick the bot this setup is for. If it says there
  are no Telegram DM sessions yet, ask the human to send the bot one message,
  then run `~/alans-way-agents/setup.sh --bind --timezone "$MAC_TZ"`.
- "Turn proactive messages on now?" — do not answer this yourself.
  **Human step — ask them:** "Should your bot be allowed to message you first,
  with an occasional check-in while the chat is idle (only 08:00–22:00 your
  time, backing off when unanswered)?" Answer
  with their choice. If they say no, they can send `/proactivity resume` later.

If it prints `no Xvfb/x11vnc detected`, the cloud browser has no display yet.
Do not install a desktop stack on your own. **Human step — tell them:** the
exact `apt-get install` line it printed, and ask whether to install it. The
browser services start once a display on `:99` exists.

**VPS without systemd (supervisord, for example a cloud VM):** services run
under supervisord, not systemd. Restart the gateway through its supervisor
with `supervisorctl signal USR1 <program>`, where `<program>` is the
supervisor program that runs `hermes gateway run`; find its name in
`supervisorctl status` and its `command=` line in
`/etc/supervisor/conf.d/*.conf`. USR1 drains active turns before the
supervisor relaunches the program; `supervisorctl restart` escalates to a
force-kill that can corrupt gateway state, and `hermes gateway restart`
cannot see that supervisor. If the program is stopped, `supervisorctl start
<program>`. If the VM already serves
a desktop through noVNC or websockify, use its existing viewer URL in
**Settings → VPS desktop connection** instead of installing another display
stack.

Running the guest as a macOS VM on the user's Mac instead? Skip the Linux
display stack entirely and follow [macOS guest VM](mac-vm-guest.md).

**Check:**

```sh
~/alans-way-agents/setup.sh --verify
```

Expect `setup: all required checks passed`. Report every `warn` line to the
human.

## Stage 4 — Prove it end to end

1. In the app: **Settings → Agent setup**, save the separate non-root agent
   and broker SSH logins, plus the trusted computer login for the broker.
   Click **Test broker path**. This checks broker access only; do not use the
   bot-only `MAC_SSH` from Stage 3 for this field or grant that bot login access
   to the human account. Verify the bot connection file separately as in Stage 3.
2. **Human step — tell them:** "In the Alan's Workspace app, message your bot:
   *Open example.com in the workspace browser and tell me the page title.*"
   Expect a tab with the bot's named cursor to appear on the right and the bot
   to reply "Example Domain".
3. **Human step — tell them:** "Send `/proactivity status` to the bot." Expect
   it to report the route as bound and show the next check-in time, or that
   check-ins are off if they declined proactive messages.

Report to the human: what passed, every warning, and anything you skipped.

## Optional — watch the remote desktop from the app

On a Linux VPS this needs the display stack from stage 3 plus a noVNC viewer
on the VPS that your computer can reach over Tailscale. On a macOS guest VM,
run `scripts/mac-vm-preview.sh` on the Mac running Tart — it bridges the VM's
VNC display to a noVNC URL. Paste the viewer URL into **Settings → VPS
desktop connection** in the app.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Stage 1 check: `Cannot find module …connection.json` | The app is not running or never started its API. Open it and retry. |
| Mac → VPS check prints `Tailscale SSH requires an additional check` or hangs | The VPS runs Tailscale SSH, so the tailnet's SSH rules (not keys) decide logins, and "check" mode needs a browser. Have the human change the rule for that user to "accept" in the Tailscale admin console → Access controls, or run `tailscale set --ssh=false` if they don't use Tailscale SSH. |
| `Host key verification failed` | A host key is not pinned on the side that connects. Re-run the stage 2 `connect-mac.sh` line (pins the VPS on the Mac) and the `known_hosts` line on the VPS. |
| Verify says `workspace_browser timeout …s is below 120s` | Long browser actions get cut off. Re-run stage 3 setup, or set `timeout: 120` on the block and restart the gateway. |
| Bot opens tabs on the VPS while the Mac is awake | The Mac app is closed, or SSH from the VPS fails. Re-run the stage 2 check. On Windows and Linux, closing the app window hides it to the tray; use the tray icon's Show, and Quit only when you want the app stopped. |
| A connect script says the address is not a Tailscale address | The VPS address must be a Tailscale name or `100.x.y.z` IP. On the VPS run `tailscale ip -4` and use that. |
| Desktop control fails on a Mac with "Accessibility is off" or "Screen Recording is off" | Grant both to Alan's Workspace (listed as `alans-way-localapp`) at the Mac itself, as in stage 1. After an app upgrade, switch them off and on again. |
| Browser tool errors right after setup | The gateway is still running old code. `hermes gateway restart` (on a VPS without systemd, `supervisorctl signal USR1 <program>` for the program running `hermes gateway run`). |
| `handoff_review_required` | A page moved between computers needs the human to check it, for example a login. Ask them. |

More detail: [deployment](deployment.md), [VPS browser](../desktop/docs/vps-browser.md),
[security model](mac-security.md), and the plugin's
[setup prompt](https://github.com/capthvnsen/alans-way-agents/blob/main/docs/setup-prompt.md).

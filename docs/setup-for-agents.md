# Set up Alan's Way (instructions for an AI agent)

You are setting up three pieces for a human: the **desktop app**
(alans-way-localapp) on their computer, the **VPS** that runs their Hermes
gateway and a cloud browser, and the **Hermes
plugin** (alans-way-agents). Work through the stages in order. Each stage ends
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

**Human step — tell them:** "The Alan's Way app is open. Sign in to Telegram in
the left pane with the QR code (Telegram on your phone → Settings → Devices →
Link Desktop Device). Tell me when your bots appear in the sidebar."

**Human step, Mac only, at the Mac itself and not over SSH. Tell them:**
"Open System Settings → Privacy & Security → Accessibility and turn on
**alans-way-localapp**. Then open Screen Recording (called Screen & System
Audio Recording on macOS 15 and later) and turn it on there too. If it is not
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

Both directions use pinned keys: the browser tools connect VPS → Mac, and the
app's **Test agent path** and VPS browser connect Mac → VPS, all with
`BatchMode=yes` and `StrictHostKeyChecking=yes`. On the VPS, collect its
address and public keys:

```sh
[ -f ~/.ssh/id_ed25519 ] || ssh-keygen -q -t ed25519 -N '' -f ~/.ssh/id_ed25519
VPS_SSH="$(whoami)@$(tailscale ip -4 | head -1)"
VPS_KEY="$(cut -d' ' -f1,2 ~/.ssh/id_ed25519.pub) $(whoami)@vps"
VPS_HOST_KEY="$(cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)"
```

On the user's computer (yourself, or **human step** — have them paste it into
Terminal on a Mac, or elevated PowerShell on Windows):

```sh
# macOS
curl -fsSL https://raw.githubusercontent.com/capthvnsen/alans-way/main/scripts/connect-mac.sh | sh -s -- \
  --vps "$VPS_SSH" --vps-host-key "$VPS_HOST_KEY" --vps-key "$VPS_KEY"
```

```powershell
# Windows (from a clone of this repo)
powershell -ExecutionPolicy Bypass -File scripts\connect-windows.ps1 `
  -Vps "$VPS_SSH" -VpsHostKey "$VPS_HOST_KEY" -VpsKey "$VPS_KEY"
```

```sh
# Linux (builds and installs the app itself; needs Node 22.12+ and git)
curl -fsSL https://raw.githubusercontent.com/capthvnsen/alans-way/main/scripts/connect-linux.sh | sh -s -- \
  --vps "$VPS_SSH" --vps-host-key "$VPS_HOST_KEY" --vps-key "$VPS_KEY"
```

Each script checks connectivity and its SSH server, installs or upgrades the
app (skip with `--skip-install`/`-SkipInstall` if stage 1 just ran),
authorizes the VPS key (only from your tailnet: the line in
`authorized_keys` carries `from="100.64.0.0/10,fd7a:115c:a1e0::/48"`), pins the
VPS host key and prints `MAC_SSH`, `MAC_TZ`, `MAC_HOST_KEY` and `MAC_KEY`. Back on
the VPS, trust the computer with those values:

```sh
grep -qxF "${MAC_SSH#*@} $MAC_HOST_KEY" ~/.ssh/known_hosts 2>/dev/null || echo "${MAC_SSH#*@} $MAC_HOST_KEY" >> ~/.ssh/known_hosts
grep -qxF "$MAC_KEY" ~/.ssh/authorized_keys 2>/dev/null || echo "$MAC_KEY" >> ~/.ssh/authorized_keys
```

**Check, from the VPS:**

```sh
# macOS target
timeout 30 ssh -o BatchMode=yes -o StrictHostKeyChecking=yes "$MAC_SSH" 'test -x /Applications/alans-way-localapp.app/Contents/MacOS/alans-way-localapp && echo MAC_OK'
# Linux target
timeout 30 ssh -o BatchMode=yes -o StrictHostKeyChecking=yes "$MAC_SSH" 'test -x "$HOME/.local/share/alans-way-localapp/alans-way-localapp" && echo MAC_OK'
# Windows target (PowerShell is the sshd default shell after connect-windows.ps1)
timeout 30 ssh -o BatchMode=yes -o StrictHostKeyChecking=yes "$MAC_SSH" 'if (Test-Path "$env:LOCALAPPDATA\Programs\alans-way-localapp\alans-way-localapp.exe") { "MAC_OK" }'
# either OS
timeout 30 ssh -o BatchMode=yes -o StrictHostKeyChecking=yes "$MAC_SSH" "ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=yes '$VPS_SSH' echo VPS_OK"
```

Expect `MAC_OK`, then `VPS_OK`. The VPS runs the browser connector with the
app's own runtime, so the host needs no Node on its SSH PATH. If `MAC_OK` is
missing, the app is not installed — repeat stage 1. On Windows, desktop
control additionally requires the app to be running: SSH sessions cannot
reach the interactive desktop, so `workspace_computer_*` calls go through the
app's loopback API.

## Stage 3 — VPS: Hermes plugin and cloud browser

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
plugin and gateway hook, clones
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
  with check-ins and follow-ups (at most a few a day, never 22:00–08:00)?" Answer
  with their choice. If they say no, they can send `/proactivity resume` later.

If it prints `no Xvfb/x11vnc detected`, the cloud browser has no display yet.
Do not install a desktop stack on your own. **Human step — tell them:** the
exact `apt-get install` line it printed, and ask whether to install it. The
browser services start once a display on `:99` exists.

Running the guest as a macOS VM on the user's Mac instead? Skip the Linux
display stack entirely and follow [macOS guest VM](mac-vm-guest.md).

**Check:**

```sh
~/alans-way-agents/setup.sh --verify
```

Expect `setup: all required checks passed`. Report every `warn` line to the
human.

## Stage 4 — Prove it end to end

1. In the app: **Settings → Agent setup**, enter the VPS SSH address and
   `MAC_SSH`, click **Save addresses**, then **Test agent path**. Success text
   is "VPS reaches this Mac over ssh" (or "this PC" on Windows).
2. **Human step — tell them:** "In the Alan's Way app, message your bot:
   *Open example.com in the workspace browser and tell me the page title.*"
   Expect a tab with the bot's named cursor to appear on the right and the bot
   to reply "Example Domain".
3. **Human step — tell them:** "Send `/proactivity status` to the bot." Expect
   it to report the route as bound, and on if they chose proactive messages.

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
| Desktop control fails on a Mac with "Accessibility is off" or "Screen Recording is off" | Grant both to `alans-way-localapp` at the Mac itself, as in stage 1. After an app upgrade, switch them off and on again. |
| Browser tool errors right after setup | The gateway is still running old code. `hermes gateway restart`. |
| `handoff_review_required` | A page moved between computers needs the human to check it, for example a login. Ask them. |

More detail: [deployment](deployment.md), [VPS browser](../desktop/docs/vps-browser.md),
[security model](mac-security.md), and the plugin's
[setup prompt](https://github.com/capthvnsen/alans-way-agents/blob/main/docs/setup-prompt.md).

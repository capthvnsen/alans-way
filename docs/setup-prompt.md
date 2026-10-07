# Setup prompt for your cloud agent

The short prompt in the [README](../README.md#connect-your-agents) points here.
An agent fetches this page and carries out the text block below. It connects
the server and the user's computer over Tailscale, installs the Alan's Way app
and Hermes plugin, and proves both ends work. The person does four things on
their computer; everything else is automatic.

```text
Set up Alan's Way for me. This server runs my Hermes gateway; connect it to my
<Mac | Windows PC | Linux computer> over Tailscale, install the Alan's Way app on it and the
alans-way Hermes plugin here, and prove it works. Do not modify Hermes itself.
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

1. Preflight, on this server. Confirm the OS: Linux (the usual case), or macOS
   if this is a Tart guest (then follow
   https://github.com/capthvnsen/alans-way/blob/main/docs/mac-vm-guest.md for
   the guest-side steps). Check `hermes --version` (0.21 or newer),
   `node -v` (22 or newer), git and python3. Install whatever is missing
   except Hermes. Find the Hermes home ($HERMES_HOME, default
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
   until it is connected. Do not ask me for an auth key. My computer must join
   the same tailnet; nothing here works over a public address. Then note
   VPS_SSH = <this user>@<first line of `tailscale ip -4`>.
   If `tailscale debug prefs` shows "RunSSH": true, Tailscale SSH answers
   port 22 on that address: my tailnet's SSH rules decide who may log in and
   SSH keys are ignored. Unattended logins need the rule for this user to be
   "accept", not "check"; the VPS_OK check in step 5 shows which.

3. SSH keys, on this server. Create ~/.ssh/id_ed25519 (no passphrase) if it is
   missing, and make sure sshd is running and accepts key logins. Note
   VPS_KEY = `cut -d' ' -f1,2 ~/.ssh/id_ed25519.pub` plus " <this user>@vps",
   and VPS_HOST_KEY = `cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub`.

4. My computer. If my message already says whether it is a Mac, a Windows PC
   or a Linux computer, use that; otherwise ask me first, because the steps
   differ. On a Mac it must be Apple Silicon; on Windows it must be Windows
   10/11 x64; on Linux it must be x64 with systemd and a desktop session,
   plus Node 22.12 or newer and git.
   If my message says the Open Alan app is already installed and open, it
   came from openalan.com: leave out the "builds the app" wording below and
   add --skip-install to the Mac or Linux command or -SkipInstall to the
   Windows command. If it says MAC_SSH, still run the connect script; it
   prints the keys you need.
   On a Mac send me these steps with the command filled in, then wait:
   1. Install Tailscale from https://tailscale.com/download and sign in with
      the same account as this server.
   2. Open System Settings → General → Sharing and turn on Remote Login.
   3. Open Terminal, paste this line and press Return. The first run builds
      the app and takes a few minutes:
      curl -fsSL https://raw.githubusercontent.com/capthvnsen/alans-way/main/scripts/connect-mac.sh | sh -s -- --vps '<VPS_SSH>' --vps-host-key '<VPS_HOST_KEY>' --vps-key '<VPS_KEY>'
   4. Copy the lines it prints between the ===== markers and send them to me.
   5. In the Alan's Way app that opened, sign in to Telegram with the QR code
      (on your phone: Telegram → Settings → Devices → Link Desktop Device).
   6. At the Mac itself (not over SSH), open System Settings → Privacy &
      Security. Under Accessibility, and again under Screen Recording, turn on
      alans-way-localapp. This lets your agent control other apps; browser
      tabs work without it.
   If the script stops, it says why in one line; tell me that line.
   On a Windows PC send me these steps instead:
   1. Install Tailscale from https://tailscale.com/download and sign in with
      the same account as this server.
   2. Open PowerShell **as Administrator**, then paste this line — it installs
      the OpenSSH Server Windows feature, sets PowerShell as the default SSH
      shell, builds the app with `npm run package:win`, and wires both key
      directions:
      irm https://raw.githubusercontent.com/capthvnsen/alans-way/main/scripts/connect-windows.ps1 -OutFile $env:TEMP\connect-windows.ps1; powershell -ExecutionPolicy Bypass -File $env:TEMP\connect-windows.ps1 -Vps '<VPS_SSH>' -VpsHostKey '<VPS_HOST_KEY>' -VpsKey '<VPS_KEY>'
   3. Copy the lines it prints between the ===== markers and send them to me.
   4. In the Alan's Way app that opened, sign in to Telegram as above.
   Note: on Windows the SSH session cannot drive the desktop — computer-use
   calls run through the app's local API, so the app must stay running.
   On a Linux computer send me these steps instead:
   1. Install Tailscale from https://tailscale.com/download and run
      `sudo tailscale up` with the same account as this server.
   2. Make sure an SSH server is installed (Ubuntu or Debian: `sudo apt-get
      install -y openssh-server`). The script starts it if it is stopped.
   3. Open a terminal in your desktop session, paste this line and press
      Return. The first run builds the app and takes a few minutes:
      curl -fsSL https://raw.githubusercontent.com/capthvnsen/alans-way/main/scripts/connect-linux.sh | sh -s -- --vps '<VPS_SSH>' --vps-host-key '<VPS_HOST_KEY>' --vps-key '<VPS_KEY>'
   4. Copy the lines it prints between the ===== markers and send them to me.
   5. In the Alan's Way app that opened, sign in to Telegram as above. Closing
      its window keeps it running in the tray; choose Quit there to stop it.

5. Trust both ways, on this server, using MAC_SSH, MAC_HOST_KEY and MAC_KEY
   from my reply (the same variable names are printed by both connect
   scripts). Append "<host part of MAC_SSH> <MAC_HOST_KEY>" to
   ~/.ssh/known_hosts and MAC_KEY to ~/.ssh/authorized_keys, each only if not
   already there. Check both directions:
   - Mac:  timeout 30 ssh -o BatchMode=yes -o StrictHostKeyChecking=yes '<MAC_SSH>' 'test -x /Applications/alans-way-localapp.app/Contents/MacOS/alans-way-localapp && echo MAC_OK'
   - PC:   timeout 30 ssh -o BatchMode=yes -o StrictHostKeyChecking=yes '<MAC_SSH>' 'if (Test-Path "$env:LOCALAPPDATA\Programs\alans-way-localapp\alans-way-localapp.exe") { "MAC_OK" }'
   - Linux: timeout 30 ssh -o BatchMode=yes -o StrictHostKeyChecking=yes '<MAC_SSH>' 'test -x "$HOME/.local/share/alans-way-localapp/alans-way-localapp" && echo MAC_OK'
   - then: timeout 30 ssh -o BatchMode=yes -o StrictHostKeyChecking=yes '<MAC_SSH>' "ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=yes '<VPS_SSH>' echo VPS_OK"
   Expect MAC_OK, then VPS_OK. If the second prints "Tailscale SSH requires an
   additional check" or times out, ask me to open the Tailscale admin console →
   Access controls and change the SSH rule that covers this server from
   "check" to "accept" for <this user>. Only if I say I don't use Tailscale SSH
   to reach this server, run `tailscale set --ssh=false` instead.

6. Ask me first: "Should your bot be allowed to message you first, with
   check-ins and follow-ups (at most a few a day, never 22:00–08:00)?" Then
   install the plugin:
     git clone https://github.com/capthvnsen/alans-way-agents ~/alans-way-agents 2>/dev/null || git -C ~/alans-way-agents pull --ff-only
     # If `hermes plugins list` already shows alans-way, add --skip-plugin so
     # that catalogue copy stays. If it does not, omit --skip-plugin and
     # setup.sh installs the plugin.
     ~/alans-way-agents/setup.sh --non-interactive --bot-id <BOT_ID> --mac-ssh '<MAC_SSH>' --host-os <mac|windows|linux> --timezone '<MAC_TZ>' --bind --proactive <yes|no> [--skip-plugin] [--profile <profile> unless it is default]
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
      ssh" (or "this PC" on Windows).
   2. Message the bot in the app: "Open example.com in the workspace browser
      and tell me the page title." A tab with the bot's cursor should appear
      and the reply should say "Example Domain".

Finish with a short report: what passed, every warning from setup.sh, and
anything you skipped or that still needs me.
```

## What it needs from you

1. Approve the Tailscale login link on the server, if Tailscale was not set up.
2. Install Tailscale on your computer and turn on its SSH server (Remote Login
   on a Mac; the connect script installs OpenSSH Server on Windows; the Linux
   script starts the one you have installed).
3. Paste one command into Terminal/PowerShell on your computer and send back
   what it prints.
4. Sign in to Telegram in the app, then answer whether the bot may message you
   first.

On a Mac, also turn on Accessibility and Screen Recording for the app, at the
Mac itself. The command in step 3 is
[scripts/connect-mac.sh](../scripts/connect-mac.sh) on a Mac,
[scripts/connect-windows.ps1](../scripts/connect-windows.ps1) on Windows or
[scripts/connect-linux.sh](../scripts/connect-linux.sh) on Linux. Each refuses a
server address that is not a Tailscale name or IP, adds the server's public key
to your computer allowed only from your tailnet, and pins the server's host key,
so neither side ever accepts an unknown key.

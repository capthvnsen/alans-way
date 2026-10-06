# Setup prompt for your cloud agent

Paste this whole block to the agent that has a terminal on the server running
your Hermes gateway: your Hermes bot itself, or any coding agent with SSH to
that server. It connects the server and your Mac over Tailscale, installs the
Alan's Way app and Hermes plugin, and proves both ends work. You will be asked
to do four things on your Mac; everything else is automatic.

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
   If `tailscale debug prefs` shows "RunSSH": true, Tailscale SSH answers
   port 22 on that address: my tailnet's SSH rules decide who may log in and
   SSH keys are ignored. Unattended logins need the rule for this user to be
   "accept", not "check"; the VPS_OK check in step 5 shows which.

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
     timeout 30 ssh -o BatchMode=yes -o StrictHostKeyChecking=yes '<MAC_SSH>' 'test -x /Applications/alans-way-localapp.app/Contents/MacOS/alans-way-localapp && echo MAC_OK'
     timeout 30 ssh -o BatchMode=yes -o StrictHostKeyChecking=yes '<MAC_SSH>' "ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=yes '<VPS_SSH>' echo VPS_OK"
   Expect MAC_OK, then VPS_OK. If the second prints "Tailscale SSH requires an
   additional check" or times out, ask me to open the Tailscale admin console →
   Access controls and change the SSH rule that covers this server from
   "check" to "accept" for <this user>. Only if I say I don't use Tailscale SSH
   to reach this server, run `tailscale set --ssh=false` instead.

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

## What it needs from you

1. Approve the Tailscale login link on the server, if Tailscale was not set up.
2. Install Tailscale on the Mac and turn on Remote Login.
3. Paste one command into Terminal on the Mac and send back what it prints.
4. Sign in to Telegram in the app, then answer whether the bot may message you
   first.

The command in step 3 is [scripts/connect-mac.sh](../scripts/connect-mac.sh).
It only adds the server's public key to the Mac and pins the server's host key,
so neither side ever accepts an unknown key.

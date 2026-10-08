# Update prompt for your cloud agent

The Open Alan app's **Copy agent update prompt** button points here (through
https://openalan.com/agent-update). An agent fetches this page and carries out
the text block below. It updates the alans-way Hermes plugin and the server
scripts it installs, refreshes the connector on the person's computer, and
proves everything still works. The person only answers questions.

```text
Update Open Alan on this server. This server runs my Hermes gateway with the
alans-way plugin; bring the plugin and its server scripts up to date and
prove they still work. Do not modify Hermes itself.

Rules for the whole job:
- Never print, paste or ask me for secrets (bot tokens, auth keys, passwords).
- Run each step's check. Do not continue past a failing check; fix it or tell
  me exactly what failed.
- Commands here run without a terminal, so pass --non-interactive to setup.sh.

1. Find the install. The plugin checkout is ~/alans-way-agents. If it is
   missing, this server was never set up: stop and tell me to send the setup
   prompt from the app instead (Settings → Agent setup → Copy setup prompt).
   Note OLD = `git -C ~/alans-way-agents rev-parse --short HEAD`.

2. Read back the values setup used, without printing any token. Find the
   Hermes home ($HERMES_HOME, default ~/.hermes) and the profile of this bot
   (`hermes profile list`; the default profile's config is
   <home>/config.yaml, others are <home>/profiles/<name>/config.yaml). In that
   config.yaml, the lines between ">>> alans-way workspace_browser managed
   block >>>" and its closing marker hold them: BOT_ID is the value after
   `--bot-id` in `args`, BOT_NAME the value after `--bot-name` (may be
   absent), and under `env:` MAC_SSH is HERMES_WORKSPACE_MAC_SSH and HOST_OS
   is HERMES_WORKSPACE_HOST_OS. These server values win; use my message only
   for values missing here. If my message names a different BOT_ID or
   MAC_SSH than the server has, ask me which is right before continuing.

3. Update the plugin checkout:
     git -C ~/alans-way-agents pull --ff-only
   Note NEW = `git -C ~/alans-way-agents rev-parse --short HEAD`. If the pull
   fails because of local changes, show me `git -C ~/alans-way-agents status
   --short` and stop.

4. Re-run setup with the same values. It updates the pinned server scripts,
   the browser services and the connector copy on my computer:
     ~/alans-way-agents/setup.sh --non-interactive --bot-id <BOT_ID> [--bot-name '<BOT_NAME>' if found] --mac-ssh '<MAC_SSH>' --host-os <HOST_OS> --timezone '<my timezone>' [--profile <profile> unless it is default]
   Do not pass --bind or --proactive; those choices are already made. If it
   prints an apt-get line for a display stack, show me that line and ask
   before installing anything.

5. Verify: `~/alans-way-agents/setup.sh --verify [--profile <profile>]` must
   end with "setup: all required checks passed". If my computer is a Mac,
   tell me: "Updates can switch off computer control on a Mac. If I can't
   use your Mac, open System Settings → Privacy & Security → Accessibility
   and Screen Recording, and turn Open Alan (alans-way-localapp) off and on
   again."

6. Restart the gateway so it loads the update. If you are this Hermes bot,
   first tell me "Restarting now; send me any message in a minute to
   continue", then run `hermes gateway restart`. Otherwise run it and wait
   until `hermes gateway status` reports it running. On a server without
   systemd (services under supervisord) `hermes gateway restart` cannot see
   the supervisor; instead run `supervisorctl restart <program>` for the
   program that runs `hermes gateway run` (find it via `supervisorctl status`
   and the `command=` lines in `/etc/supervisor/conf.d/*.conf`).

Finish with a short report: OLD → NEW (or "already up to date" if they are
equal), what passed, every warning from setup.sh, and anything that still
needs me.
```

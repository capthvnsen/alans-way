# Deploy Alan's Workspace and CU MCP with an existing Hermes instance

This guide covers three of [Alan's Way's four products](../README.md#what-to-install): **Alan's Workspace**, **Alan's CU MCP** (`workspace-mcp`, the Node server that stays in `desktop/`), and **Alan's Plugin for Hermes** from `alans-way-agents`. **Alan's Plugin for Grok Bot** is a separate skill + settings package in that agents repo; Grok Bot cannot load Hermes plugins. Use [remote-agent setup](../desktop/docs/remote-agents.md) for its CU MCP connection and [product boundaries](products.md) for Grok package/shared config publication TODOs. Both plugins read one persona/voice/proactivity/identity config spec; this deployment guide does not define a second spec.

This is a manual setup today, with a stock Hermes gateway and an optional Mac
profile. It does not require a Hermes fork. Desktop packaging targets Apple
Silicon Macs, Windows 10/11 x64 (`npm run package:win`) and Linux x64
(`npm run package:linux`, installed by `scripts/connect-linux.sh`); Intel Mac
distributions have not been verified. Your computer and the Hermes host must
share a Tailscale network: every SSH address in this guide is a Tailscale name
or IP. The Hermes side can also live
on a macOS VM (see [the macOS guest guide](mac-vm-guest.md)) instead of a
Linux VPS.

1. Install a supported stock Hermes release on the destination VPS. Create the
   primary profile and configure its model/provider through native setup.
2. Assign an existing or new Telegram bot through native messaging setup. Verify
   its numeric ID with `getMe` and keep a single active owner of its token. Follow
   [agent setup](agent-setup.md) for profile and connector identity rules.
3. Install [Alan's Plugin for Hermes](https://github.com/capthvnsen/alans-way-agents)
   on the gateway host using its documented configuration and native plugin
   registration. Start with manual status/handoff verification before enabling
   optional proactive behavior. Each installation has its own credentials and
   device trust; do not distribute a user's app data or Hermes state directory.
4. Install Alan's Workspace on your computer. Sign into Telegram locally and choose the bot
   visibility/order in Settings. App browser logins belong to that installation.
5. Configure a verified SSH route over Tailscale from the VPS to that computer (the connect scripts add the VPS key restricted to the tailnet). Launch
   `desktop/scripts/browser-mcp.cjs` on the Mac with this profile's numeric bot ID,
   using Node and the local connection file. Keep the app's HTTP endpoint on
   loopback. Set timeouts/lazy startup where supported so a sleeping Mac does not
   prevent the VPS gateway from starting.
6. If desktop viewing is wanted, run a Linux graphical session, its GUI browser,
   a VNC server and a WebSocket viewer (for example noVNC) on the VPS. Enter its
   reachable viewer URL in Workspace settings. A headless automation browser has
   no visible window; launch the GUI browser in the same display the VNC server
   shares. Snap Chromium needs a profile path allowed by its package confinement.
   On a VM that already serves a desktop through noVNC or websockify, skip this
   step and enter the existing viewer URL.
7. For managed cloud browser sessions, install the separate Chromium supervisor,
   tab broker and native MCP connector using the [VPS browser guide](../desktop/docs/vps-browser.md).
   Give each profile its own matching Telegram ID. The browser profile shares
   live logins; the broker restricts normal tools to assigned/granted tabs.
8. Verify a Telegram request and reply; bounded Mac and VPS tab actions; human
   **Take control**; and, if used, lid-close continuation and **Move to VM / Move back**
   following the [handoff guide](../desktop/docs/handoff.md). Handoff rebuilds pages;
   it does not migrate a live Chromium session. Review **Carry sign-ins** and
   its Tailscale-only cookie-transfer limits. This release has one shared VPS desktop.
   A managed tab takeover
   blocks its browser connector; generic desktop automation is coordinated
   separately.

With Hermes, SSH and noVNC already working, deployment is mostly configuration.
A fresh headless VPS also needs desktop provisioning, display/service lifecycle
and browser setup. The agents repo's `setup.sh` bootstrap covers the Hermes
side — plugin, connector config, browser host units, gateway restart,
and primary-route binding — and prints guided steps for the display/VNC stack
it can't safely automate.

On a VM without systemd (services under supervisord, for example a cloud VM),
restart the gateway through its supervisor instead of `hermes gateway restart`:
`supervisorctl signal USR1 <program>` for the program that runs `hermes
gateway run` (find it via `supervisorctl status` and the `command=` lines in
`/etc/supervisor/conf.d/*.conf`). USR1 drains active turns before the
supervisor relaunches the program; `supervisorctl restart` escalates to a
force-kill that can corrupt gateway state. If the program is stopped,
`supervisorctl start <program>`.

Chrome extensions are a separate browser capability. The current Electron app
has an extension installer and pinning controls; see the [desktop guide](../desktop/README.md).
Compatibility remains extension-dependent, and 1Password desktop pairing has its
own browser-signing requirements. Password-vault integration needs an actual
user-authorized test.

## Reboot resilience

A common failure in hosted bot products: the server reboots, the bot's
browser comes back without its logins (or doesn't come back at all), and a
person has to sign in again by hand before the bot can work. Alan's way avoids
that by design, and nothing here needs a person after a reboot:

- **Every long-running piece is a supervised service.** The agents repo's
  `setup.sh` installs the Chromium keeper (`vps-chromium-host.cjs`), the tab
  broker (`vps-browser-host.cjs serve`) and, with `--mac-ssh` (as root under
  systemd), the mac-watch router (`workspace-router.cjs --watch`) under whatever the host already uses:
  systemd units (`hermes-alans-way-chromium`, `hermes-alans-way-browser`,
  `mac-watch`, plus `hermes-alans-way-xvfb` when it provisions a display),
  supervisord programs, LaunchAgents on a macOS guest (`com.alans-way.chromium`,
  `com.alans-way.browser`, `com.alans-way.mac-watch`, all `KeepAlive` and
  `RunAtLoad`), or Windows Scheduled Tasks (`AlansWay_Chromium`,
  `AlansWay_Browser`, `AlansWay_MacWatch`, restarting on failure every minute).
  The reference units are in the agents repo's `deploy/` folder.
- **Logins live in an on-disk profile, not in a process.** The managed Chromium
  always runs with a fixed `--user-data-dir` under the browser data directory,
  so cookies and sessions survive a crash, a restart or a reboot. Nothing keeps
  login state only in memory.
- **The pieces recover in order on their own.** The keeper checks the browser's
  loopback CDP port every 3 seconds and relaunches Chromium on the same profile.
  The broker exits when its CDP connection drops, and its service manager starts
  a fresh broker that reconnects and rewrites `connection.json`. Under systemd
  and supervisord, a broker that can never bind its port exits 78 and is not
  restarted in a loop.
- **Telegram auth stays with Hermes.** The bot token belongs to Hermes' own
  gateway (set up by `hermes gateway setup`, run as Hermes' own service). The
  plugin and `setup.sh` only read it to check it is configured; they never hold
  a Telegram login of their own, so there is nothing for the plugin to re-login.

Two host caveats. Linux user units stop at logout unless the account lingers
(`setup.sh` runs `loginctl enable-linger`; as root the units are system units).
Windows starts the tasks at logon, not at boot, so turn on automatic sign-in
(`netplwiz`) and keep the PC awake.

### Smoke test

`scripts/reboot-smoke.sh` checks this on a running host. Run it on the Hermes
host (Linux, a macOS guest, or Git Bash on a Windows guest) as the account that
owns the browser data, from this repository's checkout there:

```sh
sh scripts/reboot-smoke.sh                # verify health only (same as --check; run after a real reboot)
sh scripts/reboot-smoke.sh --crash        # crash each service, verify it recovers (asks first)
sh scripts/reboot-smoke.sh --crash --yes  # the same without asking, for scripts
```

The default mode only checks health. `--crash` SIGKILLs, one at a time, every
Chromium process on the managed profile, the broker, the keeper and mac-watch
(skipped when not installed), after asking on the terminal. `--yes` skips the
question; without a terminal and without `--yes`, it refuses. It only matches
node and Chrome-family (Chrome, Chromium or Edge) processes, so an editor or
`tail` naming a service file is left alone. It waits for each service to come
back under a new process and for the broker's `/v1/status` to report
`browserUp: true`. It also fails if the profile is missing or sits under
`/tmp`, `/var/tmp` or `/private/tmp`, which a reboot can clear. Open VPS tabs
close; logins stay. Set `HERMES_VPS_BROWSER_DATA` if the data directory is not
the default, and `SMOKE_TIMEOUT` (seconds, default 90) to change how long each
step may take.

For the real thing, reboot the host (`sudo reboot`, or restart the Windows PC),
wait for it to come back without signing in to anything, then run
`sh scripts/reboot-smoke.sh --check` and send the bot a Telegram message that
opens a page on a site it was signed in to.

# macOS guest VM

An alternative to a Linux VPS for the managed side: a macOS VM on the same
Mac that runs the app, virtualized by [Tart](https://tart.run). The guest
plays the VPS role — it runs the managed Chromium host, the tab broker and
the desktop driver — so agents get a disposable macOS desktop without a
second machine. SSH reaches the guest on its NAT address; nothing has to
leave the Mac.

The pieces mirror the [VPS browser guide](../desktop/docs/vps-browser.md):

| Linux VPS | macOS guest |
|---|---|
| systemd units | LaunchAgents (`gui/<uid>` domain) |
| Xvfb `DISPLAY=:99` | The autologged-in console session — no DISPLAY |
| `vps-computer.py` (AT-SPI) | `mac-computer` Swift helper (AX + screencapture) |
| X11VNC → noVNC | `tart run --vnc-experimental` → websockify |
| `~/.local/share/hermes-alans-way/browser` | `~/Library/Application Support/hermes-alans-way/browser` |

## Provision the golden image

On the host Mac, with Tart installed (`brew install cirruslabs/cli/tart`):

```sh
sh scripts/mac-vm-setup.sh --name hermes-guest
```

The script clones `ghcr.io/cirruslabs/macos-sequoia-base`, boots it
suspendable, waits for SSH, pauses for the one manual step below, then runs
`tart suspend` and clones the suspended VM to `hermes-guest-golden`. The
Cirrus base image ships `admin`/`admin`, autologin, Remote Login (SSH) and
passwordless sudo — no first-boot configuration is needed. Re-run is safe:
the VM is reused, and an existing `-golden` clone is kept.

**Human step — the script prints it too:** in the VM window, grant the
desktop permissions. Automation cannot do this; TCC entries are
SIP-protected and only the GUI can create them.

1. Log in as admin if asked (password: `admin`) — the image usually signs in
   on its own.
2. Install the guest pieces, in the VM's Terminal or over SSH
   (`ssh admin@<guest-ip>`):
   `git clone https://github.com/capthvnsen/alans-way ~/alans-way && sh ~/alans-way/scripts/mac-guest-services.sh`
   If git or swiftc is missing, `xcode-select --install` first — the base
   image may carry only the CLT stub.
3. In the VM window — not over SSH — build the helper and run it once so
   macOS asks:
   `swiftc -O -o ~/alans-way/desktop/scripts/mac-computer ~/alans-way/desktop/scripts/mac-computer.swift`
   then `~/alans-way/desktop/scripts/mac-computer apps`
4. Approve **Accessibility** and **Screen Recording** for `mac-computer`
   (System Settings → Privacy & Security). Approve Terminal too if it asks.

Suspending and cloning afterwards preserves both grants in every clone. The
grant is recorded against the helper binary's signature, so rebuilding
`mac-computer` inside a clone can require granting again — keep the golden
binary stable.

## Install the guest services

`scripts/mac-guest-services.sh` runs **on the guest** from a repo checkout.
It discovers Node (`--node`, then `/opt/homebrew/bin/node`,
`/usr/local/bin/node`, then PATH), writes a default `config.json` with a
discovered `browserCommand` (`$CHROMIUM`, then `/Applications/Chromium.app`,
`/Applications/Google Chrome.app`, then `~/Applications` variants), and
installs two LaunchAgents into `~/Library/LaunchAgents/`:

- `com.alans-way.chromium` — `node vps-chromium-host.cjs`, `KeepAlive`; keeps
  the configured Chromium up on its loopback CDP port.
- `com.alans-way.browser` — `node vps-browser-host.cjs serve`, `KeepAlive`;
  the tab broker on `127.0.0.1:9465`.

They are bootstrapped into `gui/$(id -u)` (falling back to `launchctl
load`), so they join the console session — no DISPLAY exists or is needed.
The data dir, connection file and `config.json` permissions match the Linux
setup (`0700`/`0600`); logs land in `<data>/chromium.log` and
`browser.log`. Re-run after moving the checkout — the repo path is baked
into the plists. `--no-load` writes the files without touching launchd.

## Connect agents to the guest

SSH into the guest (`ssh admin@$(tart ip hermes-guest)`, password `admin`,
or install a key into `~/.ssh/authorized_keys`). The MCP connector is the
same `desktop/scripts/browser-mcp.cjs`; on darwin it already selects the
Swift driver (`computer.cjs` → `mac-computer`). Two macOS-only details:

- **Node is not on the sshd PATH.** Homebrew lives in `/opt/homebrew/bin`;
  use absolute paths in the MCP/Hermes command (`/opt/homebrew/bin/node`).
- **SSH lands outside the Aqua session.** A spawned process can exist as the
  right user yet still be denied AX and screen capture. Set
  `HERMES_COMPUTER_ASUSER=1` in the connector's environment; `computer.cjs`
  then wraps every helper call as `sudo -n launchctl asuser <uid> mac-computer
  …`, which re-enters the console session where the TCC grants live. The
  Cirrus image's passwordless sudo makes this non-interactive; `-n` fails
  fast if that ever changes. No wrapper is needed on the real Mac host —
  the app spawns the connector inside its own session.

Chromium is identical to the Linux path apart from the binary: point
`browserCommand` at the app binary directly
(`/Applications/Chromium.app/Contents/MacOS/Chromium`, a Google Chrome
equivalent, or a fetched Chrome for Testing build). Never use `open` — it
detaches the process from the supervisor. `--user-data-dir`,
`--remote-debugging-port` and loopback-only binding all apply unchanged.

## Watch the guest desktop

```sh
sh scripts/mac-vm-preview.sh --name hermes-guest      # --port 6080
```

It starts the VM with `--no-graphics --vnc-experimental --suspendable`,
reads the generated password and loopback port from tart's `VNC server is
running at vnc://:<password>@127.0.0.1:<port>` line, bridges it with
`websockify 127.0.0.1:<port> <vnc-addr>`, and prints the URL to paste into
**Settings → VPS desktop connection** (`ws://127.0.0.1:6080`) plus the
one-time VNC password. The VNC server lives inside the `tart run` process,
so the VM cannot already be running — the script always starts it. Ctrl+C
stops the bridge and asks the VM to shut down. This preview shows the real
console screen; it does not need the TCC grants, which gate the agent's own
reads.

## Golden image lifecycle

`tart suspend` writes the VM state into its directory; `tart clone` copies
it, so every clone of `<name>-golden` resumes into a signed-in desktop with
TCC already granted. Always run clones with `--suspendable` so suspend keeps
working (`mac-vm-preview.sh` does). `tart clone <name>-golden <copy>` is
cheap (APFS copy-on-write) — clone per environment rather than sharing one
live guest between profiles.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `workspace_computer_*` returns an empty AX tree or `not permitted` | The connector ran over SSH outside the Aqua session. Set `HERMES_COMPUTER_ASUSER=1` in its environment so helper calls go through `launchctl asuser`, or start the connector inside the GUI session. |
| `sudo: a password is required` in helper errors | The VM lost its NOPASSWD sudo rule. Re-image from the Cirrus base or add `admin ALL=(ALL) NOPASSWD: ALL` via `sudo visudo` in the GUI. |
| Preview shows a black screen or connects then drops | Screen Recording was never granted inside the VM, or you are watching a clone made before the grant. Re-do the human step on the VM and re-suspend/re-clone. |
| `mac-guest-services: node not found` over SSH | sshd PATH lacks Homebrew. Pass `--node /opt/homebrew/bin/node` (the script also checks `/usr/local/bin`). |
| `Managed Chromium did not become available` | `browserCommand` is unset or wrong in `<data>/config.json`. Point it at the binary inside the `.app` (`…/Contents/MacOS/Chromium`), not the bundle or `open`. |
| LaunchAgents never start the services | They must be in the `gui/<uid>` domain of a logged-in console user. Keep autologin on; check `<data>/browser.log` and `launchctl print gui/$(id -u)/com.alans-way.browser`. |
| `tart run` prints `Opening vnc://…` instead of `VNC server is running at` | `--no-graphics` (or `CI` set) is missing; without it tart opens Screen Sharing instead of printing the address. `mac-vm-preview.sh` already passes it. |
| `VM "…" is already running` from the preview script | A VM can only have one `tart run`. `tart stop <name>` the other instance, or reuse the viewer URL it printed. |
| Helper binary rebuilt, actions denied again | Ad-hoc signatures change the binary identity TCC granted. Re-run `mac-computer apps` in the GUI and approve again; avoid rebuilding inside golden clones. |

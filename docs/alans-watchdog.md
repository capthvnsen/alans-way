# Alan's Watchdog

Optional add-on that routes the VPS's egress through your computer. While your
computer is on the tailnet and reachable, **all**
of the VPS's outbound traffic — agent browsing, LLM and API calls, Telegram —
exits from your computer's internet address instead of the datacenter's. When
your computer sleeps, shuts or leaves the tailnet, a watchdog on the VPS
clears the route and the VPS returns to its own egress. Nothing else about the
setup changes: the agent path (VPS → computer SSH) and the app's checks already
ride the tailnet, which never crosses the exit node.

The pieces:

| Side | What | Mechanism |
|---|---|---|
| Your computer | `scripts/alans-watchdog-mac.sh` | Tailscale exit-node advertisement (`tailscale set --advertise-exit-node`) |
| Tailscale admin console | one human approval | approving the advertised `0.0.0.0/0` + `::/0` routes |
| VPS | `scripts/alans-watchdog-vps.sh` → systemd service | `scripts/alans-watchdog.sh` applies or clears `tailscale set --exit-node` based on live probes |

Tailscale itself never falls back to direct egress — a selected exit node that
goes offline simply stops forwarding. The watchdog exists because of that: it
is what makes "route through the main machine *as long as it's connected*"
true.

**The easy path is the app's toggle:** Settings → *Alan's Watchdog* advertises
this computer and installs the VPS-side watchdog over the SSH addresses you
already saved. The steps below are the same thing by hand — useful for
headless setups and for seeing exactly what the toggle does.

## Requirements

- Tailscale on the VPS and on your computer, same tailnet (already the
  recommended setup for agent reachability).
- A Linux VPS with systemd. The watchdog needs root; install with `sudo`.
- The VPS tailscaled must use kernel TUN (the default). Userspace-networking
  mode can't consume an exit node.
- On the computer side, exit-node support exists on macOS (all Tailscale
  variants — userspace routing, so throughput is modest) and on Windows.
- Access to the Tailscale admin console for the one-time route approval.

## Step 1 — advertise your computer

On a Mac:

```sh
curl -fsSL https://raw.githubusercontent.com/capthvnsen/alans-way/main/scripts/alans-watchdog-mac.sh | sh
```

It enables `--advertise-exit-node` and prints `MAC_EXIT_NODE` (this computer's
tailscale address) for the next step. `scripts/alans-watchdog-mac.sh --off` stops
the advertisement.

On Windows, in an elevated PowerShell: `tailscale up --advertise-exit-node`,
then read the address with `tailscale ip -4`.

**Human step:** approve the exit node in the
[admin console](https://login.tailscale.com/admin/machines) — your computer →
⋯ → **Edit route settings** → enable **Use as exit node**. Until then the
advertisement exists but the tailnet can't select it. (ACL `autoApprovers`
can pre-approve `0.0.0.0/0`/`::/0` if you manage routes there.)

## Step 2 — install the watchdog on the VPS

From this repository's checkout on the VPS (the plugin clones it to
`/opt/hermes-alans-way/browser`):

```sh
sudo sh scripts/alans-watchdog-vps.sh --exit-node <MAC_EXIT_NODE>
```

It checks tailscaled is usable, confirms the peer is on the tailnet (warning —
not failing — if approval is still pending or the computer is currently
offline), writes `hermes-alans-way-watchdog.service`, and starts it. Re-run to
change the peer or flags. Options: `--allow-lan` (the VPS keeps reaching its
own LAN, including provider link-local services like the metadata endpoint),
`--interval <s>`, `--no-start`, `--status`, `--uninstall`.

## How it behaves

- **Computer reachable:** after 2 consecutive checks where the peer reports
  Online in `tailscale status`, the watchdog sets `--exit-node` and logs the
  resulting egress address.
- **Computer gone:** after 3 consecutive failed checks (~45–60s at the default
  interval) it clears the exit node; the VPS's own egress returns. Expect
  roughly a minute of stalled VPS internet during the transition — that gap is
  the price of the fallback.
- **Reachable but not forwarding** (approval revoked, computer's own internet
  down): the egress probe catches it, the watchdog clears, then waits ~10
  minutes before retrying so a broken forwarder doesn't flap the routing.
- **Computer returns:** probes pass again, the exit node is re-applied.
- **Someone set a different exit node by hand:** the watchdog leaves a
  resolvable foreign choice alone while ours is down, and takes the setting
  back over once ours is healthy. The watchdog owns `--exit-node` while
  installed — uninstall it before choosing another permanent exit node.

## Honest boundaries

- **Everything egresses through the computer** — not just the browser. That is
  the point of this feature; if you want only the managed browser on the home
  address, this is the wrong tool.
- **The home connection is the ceiling.** macOS exit nodes forward in
  userspace, and all VPS traffic shares the computer's upload bandwidth and
  latency. Agent work is light; bulk traffic on the VPS is not free.
- **A sleeping Mac forwards nothing.** That's the intended fallback, not a bug
  — but if you want always-on routing, keep the computer awake (System
  Settings → Energy) or prefer a machine that doesn't sleep.
- **Link-local and LAN** on the VPS side are unreachable while routed unless
  `--allow-lan` was given; cloud metadata (`169.254.x`) lives there.
- **DNS follows the tailnet config** — with global tailnet resolvers they win;
  otherwise the VPS's local resolvers still work, just via the home path.
- The watchdog only manages `--exit-node`. Subnet routes, Mullvad exit nodes
  and other Tailscale prefs are untouched.
- `tailscale status --json` fields used (`Peer`, `ExitNodeStatus`, `TUN`) are
  read-only observations; the watchdog never writes anything but the one pref.

## Verify

```sh
# on the VPS, while the computer is up:
sh scripts/alans-watchdog-vps.sh --status          # watchdog active, exit node applied
curl -fsS https://checkip.amazonaws.com       # prints the computer's home IP, not the VPS's
journalctl -u hermes-alans-way-watchdog -f   # "exit node set to ... — egress now leaves as ..."
# sleep or shut the computer; within ~a minute:
#   journal shows "cleared the exit node", and checkip prints the VPS's own IP again
```

The agent path keeps working throughout: VPS → computer SSH is tailnet
traffic and bypasses the exit node in both directions.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Watchdog logs `tailscale set ... failed — is the node approved` | The computer advertises but the routes were never approved in the admin console. Do the step-1 human step. |
| `checkip` shows the VPS IP while the computer is up | Exit node not applied yet (needs ~30s of the peer showing Online) or banned after an egress failure — see `journalctl -u hermes-alans-way-watchdog`. |
| Everything stalls for ~a minute when the laptop closes | Expected: three failed probes before the clear. Lower `--interval` at install for a faster fallback. |
| VPS loses internet and never recovers | The watchdog or tailscaled died — `systemctl status hermes-alans-way-watchdog`, and as a manual escape hatch run `sudo tailscale set --exit-node=` on the VPS. |
| `TUN=false` error at install | tailscaled runs `--tun=userspace-networking` (common in containers). Exit nodes need kernel TUN; this can't run there. |
| VPS can't reach cloud metadata/local services while routed | By design without `--allow-lan`. Re-run step 2 with `--allow-lan`. |
| Mac advertises but never forwards | macOS exit nodes forward in userspace and need the Mac awake; also confirm Remote Login-era Tailscale is the same tailnet as the VPS. |

# Isolated browser egress on Linux

Run Chromium as a dedicated non-root OS user with no broker, human or bot
credentials. Run the broker as a different OS user. Keep code/configuration
owned by root or the broker, outside bot-writable directories. Never grant
agents generic sudo access, the browser's Xauthority, desktop bus, or CDP.

`scripts/browser_egress.py --browser-user alan-browser --broker-user alan-broker`
prints a dry-run nftables ruleset and systemd unit. Add `--apply` as root only
after reviewing it on the target Linux host. It installs its own `alan_browser`
table without flushing unrelated firewall rules. It blocks private, loopback,
link-local, tailnet, multicast and reserved IPv4 destinations, and non-global
IPv6 plus transition tunnels, for **all** traffic from the browser UID. This
covers DNS-resolved destinations, WebSockets, workers and UDP independently of
page interception. It also restricts loopback CDP to the broker UID; only CDP
replies to that broker are exempt from browser private-destination blocking.
Existing private connections are blocked too. The rules use the kernel's
[UID and connection-direction matching](https://netfilter.org/projects/nftables/manpage.html).

Use a public DNS resolver for the browser environment. A private/loopback DNS
stub is deliberately blocked. Browser and CDP ports must match the reviewed
configuration; CDP must bind loopback. The broker must connect to an already
running Chromium, without launching it as the broker user.

The browser's **system** service must include:

```ini
[Unit]
Requires=alan-browser-egress.service
After=alan-browser-egress.service

[Service]
User=alan-browser
Group=alan-browser
NoNewPrivileges=yes
CapabilityBoundingSet=
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
```

Run the provisioner from [bot-auth.md](bot-auth.md) for separate broker/bot users.
The egress installer does not create users, move profiles, configure DNS or
start Chromium. Its apply mode loads a firewall service; this has not been
run on a live workspace. Dry run never installs or changes anything.

CI exercises the real rules in a disposable Linux network namespace, including
IPv4/IPv6 private destinations, DNS-rebinding-equivalent IPs, WebSocket TCP,
an already-open private socket, public traffic, and broker-only CDP. It cannot
establish that a particular deployment uses the correct users or service unit.

This is for the standalone Linux browser. The integrated local Electron app
shares its OS identity between browser and broker and needs a separate process
boundary before applying this UID rule without breaking its viewer/SSH paths.

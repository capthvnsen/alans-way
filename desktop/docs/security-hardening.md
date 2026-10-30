# Workspace security hardening

Saved SSH targets, noVNC viewers and Hermes backend URLs require a literal
Tailscale IPv4 or IPv6 address. Find it with `tailscale ip` on the destination.
Use `user@Tailscale-IP` for SSH and bracket an IPv6 address in SSH targets and
URLs. DNS names, SSH aliases, public addresses and ordinary LAN addresses are
refused, including when old preferences are loaded.

SSH ignores configuration files, ProxyCommand, ProxyJump and canonicalization.
Default identity files and the SSH agent remain available; host-key checking
remains enabled. Re-enter any old saved alias as its tailnet address.

`HERMES_WORKSPACE_ALLOW_LOOPBACK=1` is an existing isolated-fixture opt-in.
Never set it in a workspace service or production launcher.

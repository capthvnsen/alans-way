# Workspace security hardening

Tailnet enforcement is an explicit service/launcher opt-in:
`HERMES_WORKSPACE_REQUIRE_TAILNET=1`. Nightly upgrades preserve existing SSH
aliases, configuration-based keys and saved viewers under a logged legacy
transport. This is migration compatibility, not hostile-agent isolation.
No failed strict connection retries through the legacy route.

Before enabling it, record the existing settings, replace SSH aliases and
backend/viewer names with operator-pinned literal Tailscale addresses, and
provision default identity files or an SSH agent with pinned host keys. Strict
SSH ignores configuration files, ProxyCommand, ProxyJump and canonicalization;
keys selected only by IdentityFile in SSH config will need explicit migration.
A denied viewer stays saved for repair in Settings and is not dialed.

Use `user@Tailscale-IP` for SSH and bracket IPv6 in SSH targets and URLs.
MagicDNS is not yet qualified for strict routing; retain the old labeled route
until its pinned IP is available. Tailscale device identity is reachability,
not the bot principal. Per-bot credentials in bot-auth.md implement that same
principal model from architecture PR #241, launch decision 5.

Sign-in transfer remains independently restricted to verified tailnet targets
and existing owner consent. Enabling legacy transport does not enable arbitrary
cookie transfer. Never set `HERMES_WORKSPACE_ALLOW_LOOPBACK=1` in production;
it exists for isolated fixtures only.

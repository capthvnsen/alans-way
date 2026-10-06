# Security policy

This is an alpha. Use synthetic or non-sensitive workspaces until you have reviewed the deployment boundary.

## Scope

This repository ships two things with different boundaries: the desktop app in `desktop/`, and the optional Companion CLI in `src/hermes_companion/`.

### Desktop app

The app gives your Hermes bots real browser control. Its API listens on `127.0.0.1` only and requires the bearer token in `~/Library/Application Support/Hermes Workspace/connection.json` (mode 0600, rotated on every app start). Anything that can read that file can drive agent tabs, including running page JavaScript through `eval` and allowlisted DevTools commands. Run the connector on the Mac over SSH; do not expose the API on Tailscale or a public interface.

Human control wins: a tab under human control is sealed to bots (snapshots and screenshots return 409), and every takeover invalidates queued agent actions. Per-tab ownership between bots is cooperative policy, not a cryptographic boundary. Agents never use OS input, the clipboard or your keyboard focus. See the [integration boundary](desktop/docs/integration.md) for the full contract.

### Companion CLI

The Companion's Mac endpoint is stdio-only and read-only. It listens on no public HTTP port and installs no service. The supported package never changes Hermes core or installs credentials. The MCP server exposes exactly three tools; unsupported writes, shell execution, browser control, password access and approvals are absent, not merely disabled by a caller-supplied flag.

The approved directory is a disclosure boundary, not a full secret detector. Filenames are filtered and reads are bounded, but innocently named UTF-8 files can still contain confidential content. Choose an isolated directory and do not expose a whole home or an existing Hermes profile.

## SSH and host identity

- Provision private connectivity and SSH credentials separately, with explicit consent.
- Verify the Mac host key before use. The generated command uses `StrictHostKeyChecking=yes`; do not disable it to work around a connection error.
- Use a dedicated low-privilege identity and restrict SSH where practical. Ordinary SSH login may still grant broad shell access even though the MCP tools themselves are narrow. A Tailscale connection does not fix that.
- Never share, commit or paste private keys, access tokens, session databases, transcripts, browser profiles, or raw diagnostic logs.
- Verification checks the declared Mac execution host, but device identity ultimately relies on your reviewed SSH destination and host key. A malicious server could lie about OS metadata.

## Protocol and approvals

Generated configuration uses conservative trust. Do not upgrade to full trust to conceal an SDK annotation or compatibility problem. Native Hermes' actual enforcement must be checked separately from the raw MCP handshake.

The keeper lives under `hermes_companion.experimental`, is not wired into the CLI, and must not be attached to live sessions. Its unsupported-request responses can withdraw pending approvals or clarifications. Caller-supplied profile labels are not server attestation. No component claims restart-durable prompt admission or exactly-once messaging.

## Reporting

For an exploitable vulnerability, use GitHub's private vulnerability reporting facility when enabled. If it is unavailable, open a minimal issue requesting a private reporting channel without exploit details, keys, raw logs, machine addresses or transcripts. Non-sensitive reproducible bugs may be reported publicly using synthetic fixtures.

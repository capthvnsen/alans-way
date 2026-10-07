# Security policy

This is an alpha. Use synthetic or non-sensitive workspaces until you have reviewed the deployment boundary.

## Scope

This repository ships two things with different boundaries: the desktop app in `desktop/`, and the optional Companion CLI in `src/hermes_companion/`.

### Desktop app

The app gives your Hermes bots real browser control. Its API listens on `127.0.0.1` only and requires the bearer token in `connection.json` in the app's data folder (`~/Library/Application Support/Hermes Workspace` on macOS, `%APPDATA%\Hermes Workspace` on Windows, `~/.config/Hermes Workspace` on Linux; mode 0600, rotated on every app start). Anything that can read that file can drive agent tabs, including running page JavaScript through `eval` and allowlisted DevTools commands. Requests must also carry a loopback `Host` header (`127.0.0.1`, `localhost` or `[::1]` on the app's port), so a web page cannot reach the API through DNS rebinding. Run the connector on the computer over SSH; do not expose the API on Tailscale or a public interface.

The app's own window cannot navigate away from its page or open other windows, and its IPC bridge answers only that exact page. Closing the window on Windows and Linux hides it to the system tray, so the connector keeps running until you choose Quit.

Human control wins: a tab under human control is sealed to bots (snapshots and screenshots return 409), and every takeover invalidates queued agent actions. Per-tab ownership between bots is cooperative policy, not a cryptographic boundary. Agents never use OS input, the clipboard or your keyboard focus. See the [integration boundary](desktop/docs/integration.md) for the full contract.

### Companion CLI

The Companion's Mac endpoint is stdio-only and read-only. It listens on no public HTTP port and installs no service. The supported package never changes Hermes core or installs credentials. The MCP server exposes exactly three tools; unsupported writes, shell execution, browser control, password access and approvals are absent, not merely disabled by a caller-supplied flag.

The approved directory is a disclosure boundary, not a full secret detector. Filenames are filtered and reads are bounded, but innocently named UTF-8 files can still contain confidential content. Choose an isolated directory and do not expose a whole home or an existing Hermes profile.

## SSH and host identity

- SSH runs over your Tailscale network only. The connect scripts refuse a server address that is not a Tailscale name (`*.ts.net` or a single-label MagicDNS name) or a Tailscale IP (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`), and they add the server's key to your computer's `authorized_keys` with `from="100.64.0.0/10,fd7a:115c:a1e0::/48"`, so that key is refused from anywhere else. The key keeps a full shell. Re-running a script replaces an older unrestricted line for the same key.
- Provision private connectivity and SSH credentials separately, with explicit consent.
- Verify the Mac host key before use. The generated command uses `StrictHostKeyChecking=yes`; do not disable it to work around a connection error.
- Use a dedicated low-privilege identity and restrict SSH where practical. Ordinary SSH login may still grant broad shell access even though the MCP tools themselves are narrow. The tailnet restriction limits where a key can be used from; it does not narrow what the key can do.
- Never share, commit or paste private keys, access tokens, session databases, transcripts, browser profiles, or raw diagnostic logs.
- Verification checks the declared Mac execution host, but device identity ultimately relies on your reviewed SSH destination and host key. A malicious server could lie about OS metadata.

## Protocol and approvals

Generated configuration uses conservative trust. Do not upgrade to full trust to conceal an SDK annotation or compatibility problem. Native Hermes' actual enforcement must be checked separately from the raw MCP handshake.

The keeper lives under `hermes_companion.experimental`, is not wired into the CLI, and must not be attached to live sessions. Its unsupported-request responses can withdraw pending approvals or clarifications. Caller-supplied profile labels are not server attestation. No component claims restart-durable prompt admission or exactly-once messaging.

## Reporting

For an exploitable vulnerability, use GitHub's private vulnerability reporting facility when enabled. If it is unavailable, open a minimal issue requesting a private reporting channel without exploit details, keys, raw logs, machine addresses or transcripts. Non-sensitive reproducible bugs may be reported publicly using synthetic fixtures.

# Compatibility and upgrade policy

## Supported operating-system arrangements

Two machines are involved and their OS choices are independent:

| Machine | OS | Status |
|---|---|---|
| User's computer (the app) | macOS, Apple Silicon | verified — `install-mac`/`connect-mac.sh`, Swift accessibility driver |
| User's computer (the app) | Windows 10/11 x64 | supported — `install-windows.ps1`/`connect-windows.ps1`, UI Automation driver; CI-verified on `windows-latest`, not yet exercised on owned hardware |
| User's computer (the app) | Linux x64, systemd | supported, new: `connect-linux.sh` (builds with `npm run package:linux`); not yet exercised on owned hardware. Closing the window hides it to the tray |
| Hermes' home (agent side) | Linux VPS | verified — primary target; systemd units, X11/VNC desktop |
| Hermes' home (agent side) | macOS VM via Tart | supported — `scripts/mac-vm-setup.sh` + `mac-guest-services.sh` (launchd); preview via `tart --vnc-experimental` + `mac-vm-preview.sh`; manual TCC grants required once |

Networking: every SSH address is a Tailscale name or IP. The connect scripts refuse anything else and authorize the VPS key only from `100.64.0.0/10` and `fd7a:115c:a1e0::/48`.

macOS notes: desktop-app control needs Accessibility and Screen Recording granted to Alan's Workspace (listed as `alans-way-localapp`) on the Mac itself (see the README). Remote SSH sessions need no grant, because computer use runs through the app's loopback API. Browser tabs need neither.

Windows notes: computer-use runs through the app's authenticated loopback API
(`/v1/computer/*`, as it does on macOS and Linux hosts) because an SSH session cannot reach the interactive desktop
— the app must be running for desktop control. Elevated apps are unreachable
by design (UIPI), matching the existing refusal policy. The file-workspace MCP
on Windows is `hermes-companion serve-windows`.

Linux host notes: desktop control needs an X11 session (Wayland is not
supported) and these packages: `python3 python3-gi gir1.2-atspi-2.0
at-spi2-core xdotool x11-utils` (on Debian or Ubuntu,
`sudo apt-get install -y python3 python3-gi gir1.2-atspi-2.0 at-spi2-core xdotool x11-utils`).
Screenshots use ImageMagick `import` when present and otherwise fall back
to `xwd` (converted through netpbm or Pillow), `scrot -a`, or `ffmpeg`
x11grab, so installing any one of `imagemagick`, `x11-apps`, `scrot`, or
`ffmpeg` covers them.
GTK apps expose their controls only when accessibility is on, so start them
with `GTK_A11Y=atspi` if a snapshot comes back empty. Browser tabs need none
of this. The Electron sandbox can be blocked by AppArmor on Ubuntu 24.04;
`connect-linux.sh` prints the `--no-sandbox` fallback when the app does not stay open.

macOS guest notes: accessibility and screen recording grants cannot be
scripted (SIP-protected); grant them once, suspend the VM and clone the image
— `scripts/mac-vm-setup.sh` walks that flow. Services run as LaunchAgents in
the console user's GUI session.

## Supported alpha boundary

- Python 3.11+ for configuration, diagnostics, and packaging.
- macOS for actual Mac tool execution; Linux hosts configure and verify the remote endpoint but cannot impersonate it.
- A separately installed `mcp==2.0.0` in the companion virtual environment for MCP serving and verification.
- SSH stdio transport with existing, verified host keys.
- Stock Hermes' documented `mcp_servers` configuration surface. No Hermes source or bundled dependency modifications.

The SDK pin is a reproducibility boundary for this alpha, not a promise that all later SDKs work or an indefinite pin of Hermes. Changes need protocol tests before widening it.

## Known Hermes SDK annotation caveat

During pre-release research, a stock Hermes build read camelCase `readOnlyHint` attributes while MCP SDK 2 exposes snake_case `read_only_hint` in its Python model. The canonical wire annotation may be correct while native classification is conservative or mismatched.

No workaround patch is shipped or applied here. Generated configuration remains untrusted. The raw verification command checks wire/tool behavior, **not** native Hermes enforcement. If the installed Hermes blocks a call or unexpectedly requests approval, stop and check official upstream compatibility; do not set full trust to conceal the issue. Confirm native tool filtering and approval behavior in an isolated, non-sensitive session before production use.

## After a Hermes or companion upgrade

1. Run `hermes-companion doctor` on both hosts.
2. Run `verify-mac` from the cloud host with a synthetic approved directory.
3. Verify the exact three-tool allowlist and no extra resources/prompts/sampling.
4. Exercise a permitted read and denied traversal/symlink paths through native Hermes.
5. If using experimental/public session protocols, check capability/identity epochs, event replay, open requests and reconnect behavior independently.
6. Do not retry an uncertain prompt or attach another writer to recover from an unsupported contract.

The current public docs are authoritative for upstream configuration; installed releases may differ. Future releases cannot be certified in advance.

## What test output means

- Unit tests: local policy/parser behavior and public-wire fixtures.
- Real Mac MCP tests: actual subprocess protocol exchange against synthetic local files.
- Real VPS → Mac verification: actual private transport and read-only endpoint, not a provider turn.
- Experimental keeper opt-in: a newly launched isolated stock runtime, not authenticated attachment to a live cloud/Desktop owner.
- CI: a clean checkout and package behavior on the recorded runners, not phone/Desktop integration or native Hermes upgrade certification.

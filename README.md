# Hermes Companion

**Cloud brain. Private Mac tools. Stock Hermes.**

An external, removable companion for people running [Hermes Agent](https://github.com/NousResearch/hermes-agent) on a Linux VPS and using a Mac locally. The VPS remains the primary conversation and execution host. The Mac exposes only explicitly scoped capabilities through a private connection.

> **Alpha — not a turnkey one-bot product yet.** This release provides an installable CLI, a read-only Mac MCP server, a private SSH configuration generator, and connection verification. Automatic phone ↔ Desktop conversation routing, live approval routing, and restart-safe task admission are **not implemented**. The experimental keeper is not safe to attach to your live assistant.

## What works in this alpha

- Installable `hermes-companion` CLI on Python 3.11+.
- `doctor`: check local components without changing configuration or disclosing credentials.
- `mcp-config`: print a reviewed configuration fragment for stock Hermes, rather than overwrite its configuration.
- `serve-mac`: expose exactly three read-only MCP tools from an approved directory, on macOS only.
- `verify-mac`: use the real MCP protocol over SSH to check the Mac endpoint. An optional explicitly requested file read is bounded and reports metadata, not its contents.
- Portable tests and Linux/macOS CI.

## Architecture

```text
Phone messaging interface ─┐
                          ├─> VPS Hermes — primary brain, transcript and cloud work
Mac Hermes Desktop ───────┘        |
                                  | private SSH / MCP
                                  v
                          Mac read-only companion
                          explicitly approved directory
```

**The diagram is the target architecture, not a claim that this alpha automatically binds those chat interfaces.** Use native Hermes to configure Desktop and messaging gateways. Keep one authoritative conversation owner; two independently running Hermes processes must not concurrently write the same conversation or synchronize live session databases.

When the Mac is offline, the VPS can continue cloud work independently. Mac tool calls fail visibly; they are not executed on the VPS. This alpha does **not** durably queue Mac jobs for later.

## Quick start

Requirements: a configured VPS Hermes installation, macOS for the tool endpoint, Python 3.11+, and a private VPS → Mac SSH connection you have already authorized. The companion does not install Hermes, create SSH keys, accept unknown host keys, open ports, or install background services.

### 1. Install on the Mac and VPS

```bash
git clone https://github.com/capthvnsen/hermes-companion.git
cd hermes-companion
python3 -m venv .venv
.venv/bin/python -m pip install '.[mcp]'
.venv/bin/hermes-companion --version
.venv/bin/hermes-companion doctor
```

The MCP extra pins the protocol SDK version tested for this alpha, **not your Hermes version**. Use a separate virtual environment; do not change Hermes' bundled dependencies. Without the extra, configuration generation and local diagnostics remain available. `doctor` prints a report and returns nonzero if the SDK, SSH, or native Hermes CLI is missing; this does not mean configuration generation is unavailable.

### 2. Approve a dedicated Mac directory

Create an existing, non-symlink directory containing only material you consent to expose. Use its absolute path. Do not point the server at your home directory, password store, browser profile, or Hermes state.

SSH must reach the Mac with verified host keys and without interactive password prompts. Prefer a private network and a dedicated restricted SSH identity. A private network alone does not narrow the authority of your SSH account. See [security](SECURITY.md).

### 3. Generate configuration on the VPS

Replace every example value with your own reviewed connection details. The paths below refer to the **Mac**, not the VPS.

```bash
hermes-companion mcp-config \
  --mac-host macuser@mac-private-host \
  --mac-python /opt/hermes-companion/.venv/bin/python \
  --workspace /opt/hermes-companion/approved-workspace
```

The command prints JSON containing `mcp_servers.mac_companion`. Review it and merge that entry into the **VPS primary profile's** Hermes `config.yaml` using Hermes' documented MCP configuration workflow. Do not replace the rest of your config, edit another profile, or create a second cloud brain. JSON is also valid YAML, but merge the entry rather than paste a second competing top-level `mcp_servers` block.

The generated remote command runs the **installed package**, not a hardcoded personal script. SSH is noninteractive, verifies existing host keys, and has a bounded connection timeout. Tool access is narrow and sampling is disabled.

### 4. Verify the actual route

```bash
hermes-companion verify-mac \
  --mac-host macuser@mac-private-host \
  --mac-python /opt/hermes-companion/.venv/bin/python \
  --workspace /opt/hermes-companion/approved-workspace
```

For an end-to-end file test, create a non-sensitive UTF-8 `proof.txt` in the approved Mac directory, then repeat with `--read proof.txt`. No file is read automatically by verification. A passing check establishes the MCP route and endpoint behavior, **not** a model turn, native Hermes approval handling, shared phone/Desktop identity, or reboot persistence.

## Mac tool surface

| Tool | Capability |
|---|---|
| `mac_device_status` | Minimal OS metadata, without hostname or username |
| `mac_workspace_list` | Bounded, filtered listing in the approved directory |
| `mac_workspace_read_file` | Bounded UTF-8 reads relative to that directory |

No shell, write, browser, email, payment, password, or OTP tool is exposed. Reads reject absolute paths, traversal, dotfiles, credential-like names, symlinks, multiple hardlinks, binary content, and oversized files. Filename filtering does **not** detect a secret inside an innocently named text file; the whole approved directory is your disclosure boundary. Details: [Mac security](docs/mac-security.md).

## How this differs from vanilla Hermes

Hermes already provides the agent loop, memory, tasks, messaging integrations, remote Desktop connections, MCP, and public session protocols. This project should not reimplement them.

The companion adds the scoped Mac endpoint, explicit device targeting, configuration/verification tooling, and a place to develop missing connection-lifecycle glue. The [experimental public-protocol keeper](docs/experimental-keeper.md) remains research, not production routing.

Official references:
- [Desktop remote connections](https://hermes-agent.nousresearch.com/docs/user-guide/desktop)
- [MCP integration](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp)
- [Public programmatic protocols](https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration)

## Compatibility and updates

No Hermes core patches, private runtime imports, session database manipulation, dependency replacement, or indefinite Hermes version pin are required by the supported CLI/Mac endpoint. Unknown future Hermes releases cannot be guaranteed. Run the checks after upgrades and fail visibly when contracts change.

Some tested Hermes builds misclassify MCP SDK 2 read-only annotations. Correct read-only wire metadata does not by itself prove how a particular Hermes version will enforce trust. Keep the conservative trust configuration; if your build blocks the calls or asks for additional approval, do not switch to full trust to hide the issue. See [compatibility](docs/compatibility.md).

## Development

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -e '.[mcp]'
.venv/bin/python -m unittest discover -s tests -v
.venv/bin/python -m pip install build
.venv/bin/python -m build
```

Tests use synthetic fixtures; no private transcripts or credentials are required. Real Mac success tests run only on macOS. Native Hermes keeper tests, where present, require explicit opt-in and isolated synthetic state; they never attach to your existing sessions by default. See [actual pre-release verification](docs/verification.md) for fresh-install, Linux VPS and real cloud-to-Mac results and their limits.

## Roadmap

- [ ] Validate authenticated two-client attachment to one cloud runtime.
- [ ] Preserve conversation identity across phone and Desktop entry points.
- [ ] Route live approval/clarification requests to the correct authorized interface.
- [ ] Exercise Mac-off → phone conversation → Mac-return continuity end to end.
- [ ] Add crash-safe admission, receipts, and explicit recovery of uncertain submissions.
- [ ] Make replaceable messaging adapters without retargeting queued replies.
- [ ] Add least-privilege installer/service management with explicit user approval.

See [the acceptance gates](docs/continuity.md) before calling the full system seamless.

## License and affiliation

MIT. Independent community project; not an official Nous Research product and not affiliated with other commercial assistants. No private research workspace, user-specific configuration, or Hermes source fork is included.

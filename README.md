# Alan's Way

Four products for working with your agents across your computer and a VM. Install the parts you need; Hermes is required for the Hermes plugin, not for every MCP client.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[**openalan.com**](https://openalan.com) · [**Discord: help and community**](https://discord.gg/jBQCPUsVE) · [Latest Workspace release](https://github.com/capthvnsen/alans-way/releases/latest)

## What to install

| Product | What it does | What to install / where |
| --- | --- | --- |
| **1. Alan's Workspace** | Mac desktop app with chat and a browser, iOS app, and lid-close VM handoff | [Mac download](https://openalan.com/download/mac) on your Mac; [iOS build/beta guide](ios/README.md) for your iPhone. Source: this repo, `desktop/`, `ios/`, and supporting `mobile/` code. [Install details](#1-alans-workspace) |
| **2. Alan's CU MCP** | Shared Node computer-use server (`workspace-mcp`) that any MCP-capable agent can connect to | Use the server bundled with Workspace or install from this repo's `desktop/` source. Connect your agent's MCP client. [Install details](#2-alans-cu-mcp) |
| **3. Alan's Plugin for Hermes** | Python plugin for stock Hermes, with Workspace integration and shared assistant settings | Install on the host running your Hermes gateway, from [alans-way-agents](https://github.com/capthvnsen/alans-way-agents). [Install details](#3-alans-plugin-for-hermes) |
| **4. Alan's Plugin for Grok Bot** | Grok Bot skill + settings package using the same CU MCP and shared config spec | The `alans-way-grok-bot/` scaffold is pending [agents PR #157](https://github.com/capthvnsen/alans-way-agents/pull/157); connect CU MCP separately. **Grok Bot cannot load Hermes plugins.** [Install details](#4-alans-plugin-for-grok-bot) |

The two plugins target **one shared config spec** for **persona, voice, proactivity, and identity**. That contract belongs in `alans-way-agents`; this repo supplies the app and computer-use service. The draft schema at `shared/config.schema.json` and Grok scaffold are pending [agents PR #157](https://github.com/capthvnsen/alans-way-agents/pull/157); see [product boundaries and shared config](docs/products.md) for implementation status. Existing Hermes package names (`alans-way`, `alans-way-computer`) are implementation components of product 3, not additional products.

**Setting up Workspace with a Hermes agent?** Paste this prompt so it reads the full setup instructions:

```text
Set up Alan's Workspace. Repo: https://github.com/capthvnsen/alans-way
Fetch https://raw.githubusercontent.com/capthvnsen/alans-way/main/docs/setup-prompt.md and follow the text block in it exactly. Do not modify Hermes. Never print secrets.
```

## 1. Alan's Workspace

Install the desktop app on the computer you want to use with your agents. Chat and real Chromium tabs share a workspace; agents have named cursors and assigned tabs, and you can take control. A remote desktop viewer lets you watch or control your VM. Telegram chat uses your existing bot conversation; other agents keep their own chat clients.

- **Mac (Apple Silicon):** [download](https://openalan.com/download/mac), open the signed/notarized app, and follow setup. The installed bundle is `/Applications/alans-way-localapp.app`. Source installation: `sh scripts/install-mac.sh` from a clone of this repo.
- **iOS:** follow [ios/README.md](ios/README.md) for Xcode builds or the [beta tester guide](docs/ios-beta-testers.md) for an invitation. This source tree does not provide a public App Store install link. Voice calls additionally need the [mobile voice bridge](mobile/README.md) on the existing Hermes gateway; normal chat and the viewer have their own setup.
- **Existing Windows/Linux support:** [Windows download](https://openalan.com/download/windows) (unsigned; SmartScreen may require **More info → Run anyway**), or build on Linux x64 with a desktop session, systemd, Node 22.12+ and git. [Desktop guide](desktop/README.md) · [installation paths](docs/products.md#installation-paths)

For a remote host, install Tailscale on both computers and use SSH over Tailscale. With the VM browser and router configured, lid-close handoff rebuilds browser work on the VM; waking retires the local copy, and **Move back** is manual. This does not migrate a live Chromium process. Sign-in transfer is controlled by **Carry sign-ins** and restricted to Tailscale; storage, upload, and approval limits are in the [handoff guide](desktop/docs/handoff.md).

For native Mac app control, grant **Alan's Workspace (`alans-way-localapp`)** Accessibility and Screen Recording in System Settings → Privacy & Security. Browser tabs need neither. Keep the app running for local computer use.

[Desktop usage and development](desktop/README.md) · [macOS VM guest](docs/mac-vm-guest.md) · [Hermes setup guide](docs/setup-for-agents.md)

## 2. Alan's CU MCP

`workspace-mcp` is the product name for the shared Node computer-use server. **It stays here**, at [`desktop/scripts/browser-mcp.cjs`](desktop/scripts/browser-mcp.cjs), using supporting code in `desktop/src/`. There is no separate `workspace-mcp/` directory or npm package to install in this tree.

Use the copy bundled in the Mac app:

```text
/Applications/alans-way-localapp.app/Contents/Resources/app/scripts/browser-mcp.cjs
```

Or prepare a source checkout with Node 24 (the development/CI version):

```sh
git clone https://github.com/capthvnsen/alans-way.git
cd alans-way/desktop
npm ci
```

Configure your client's stdio MCP server entry, replacing the absolute paths and agent ID:

```json
{
  "mcpServers": {
    "workspace-mcp": {
      "command": "/absolute/path/to/node",
      "args": [
        "/absolute/path/to/alans-way/desktop/scripts/browser-mcp.cjs",
        "--bot-id", "YOUR_AGENT_ID"
      ]
    }
  }
}
```

The outer configuration shape depends on your client; stock Hermes uses `mcp_servers`. The installed connector requires Node 22.12+; development and CI use Node 24. The app (or a configured VM browser host) must be running. Keep the whole checkout/bundle: the script imports sibling modules and the MCP SDK. Give each agent its own ID. The connector reads the local private connection file; do not copy its token into client JSON or share it in issues.

This exposes `cua_alans_way_*` browser tools and `workspace_computer_*` native tools. A generic MCP client can connect without loading a Hermes plugin. Remote routing, VM failover, and remote-agent provisioning currently use scripts in `alans-way-agents`; follow the [remote-agent guide](desktop/docs/remote-agents.md) for SSH over Tailscale and approvals. The optional Python companion CLI is a separate support tool, not this Node server.

## 3. Alan's Plugin for Hermes

Install on the server/VM running your **existing stock Hermes gateway**, not into the desktop app. Keep Hermes as the conversation owner. The Python plugin, computer-use provider, bundled skills, and setup scripts live in [capthvnsen/alans-way-agents](https://github.com/capthvnsen/alans-way-agents).

Start with its [installation guide](https://github.com/capthvnsen/alans-way-agents/blob/main/docs/install.md) or paste this repo's [setup prompt](docs/setup-prompt.md) to your Hermes agent. The existing checkout-based install is:

```sh
git clone https://github.com/capthvnsen/alans-way-agents.git
cd alans-way-agents
./setup.sh --bot-id YOUR_NUMERIC_BOT_ID --mac-ssh you@your-computer.YOUR_TAILNET.ts.net --restart
```

This configures the gateway and may install services/restart it; review the install guide first. The default plugin paths are `~/.hermes/plugins/alans-way/` and `~/.hermes/plugins/alans-way-computer/`; profiles may use a different `HERMES_HOME`. Install Workspace for a local browser and CU MCP for tools. The plugin supplies Hermes-specific hooks, check-ins, and routing; the shared spec defines persona, voice, proactivity, and identity for both plugin products.

[Agent setup](docs/setup-for-agents.md) · [multi-profile identity](docs/agent-setup.md) · [updates](docs/update-for-agents.md)

## 4. Alan's Plugin for Grok Bot

Use the **Grok Bot skill + settings package** in [capthvnsen/alans-way-agents](https://github.com/capthvnsen/alans-way-agents), plus a CU MCP connection to your Workspace/VM. **Do not run the Hermes plugin installer as a Grok Bot package installer:** Grok Bot cannot load Python Hermes plugins.

The existing connection path is documented in [remote agents](desktop/docs/remote-agents.md): provision the restricted SSH router on your VM, then in Grok Bot use **Settings → Add a custom connector** with the generated client JSON. That establishes computer use; it does not install the Grok skill/settings package.

**Pending [agents PR #157](https://github.com/capthvnsen/alans-way-agents/pull/157):** the Grok Bot scaffold is at [`alans-way-grok-bot/`](https://github.com/capthvnsen/alans-way-agents/tree/codex/hermes-shared-config-grok-scaffold/alans-way-grok-bot) and the shared draft schema is at [`shared/config.schema.json`](https://github.com/capthvnsen/alans-way-agents/blob/codex/hermes-shared-config-grok-scaffold/shared/config.schema.json). These are draft artifacts: native Grok Bot loading is unverified and the Hermes shared-config reader is not implemented. See [implementation status](docs/products.md#shared-config-contract).

## Contributing and support

Start with [CONTRIBUTING.md](CONTRIBUTING.md), the [directory/product map](docs/products.md), and [MIT licensing and dependency notices](docs/licensing.md). Issues and PRs identify one or more of the four products using the [product labels](.github/labels.yml). App and CU MCP changes belong here; plugin and shared config changes belong in `alans-way-agents`.

Get help on [Discord](https://discord.gg/jBQCPUsVE), visit [openalan.com](https://openalan.com), or open an [issue](https://github.com/capthvnsen/alans-way/issues). Report vulnerabilities privately via [SECURITY.md](SECURITY.md). Never post credentials, connection files, private addresses, or raw session logs.

## License

All four Alan's Way products—**Alan's Workspace**, **Alan's CU MCP**, **Alan's Plugin for Hermes**, and **Alan's Plugin for Grok Bot**—are licensed under the **[MIT License](LICENSE)**. Copyright (c) 2026 Alex Hansen. The shared config spec and supporting code use MIT too. Third-party software retains its own licenses; see [dependency notices and desktop distribution constraints](docs/licensing.md).

Independent community project. Not affiliated with Nous Research or xAI.

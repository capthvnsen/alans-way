# Four products: ownership, installation, and shared config

[Alan's Way](../README.md) has four products in two repositories. All four products and the shared config spec use the **[MIT License](../LICENSE)**, Copyright (c) 2026 Alex Hansen. Third-party software retains its own terms; see [licensing](licensing.md). This is the current product map; older plans and research may use the previous app/plugin naming. Community: [Discord](https://discord.gg/jBQCPUsVE) · [openalan.com](https://openalan.com).

## Source boundaries

| Product | Repository and directories | Owns | Does not own |
| --- | --- | --- | --- |
| Alan's Workspace | `capthvnsen/alans-way`: `desktop/`, `ios/`, `mobile/` | Mac chat/browser UI, iOS app, viewer, browser state and lid-close VM handoff; `mobile/miniapp/` and `mobile/voice/` support iOS voice | Agent persona or a replacement agent runtime |
| Alan's CU MCP (`workspace-mcp`) | `capthvnsen/alans-way`: `desktop/scripts/browser-mcp.cjs`, supporting `desktop/src/`, and VM browser hosts in `desktop/scripts/` | Shared Node MCP interface for browser/native computer use; host-side access and control policy | Hermes-only hooks or Grok Bot settings |
| Alan's Plugin for Hermes | `capthvnsen/alans-way-agents`: existing `alans-way/`, `alans-way-computer/`, root setup scripts and `deploy/` | Python Hermes integration, hooks, skills, routing/provisioning adapters and reading shared config | Workspace UI or ownership of the shared CU MCP implementation |
| Alan's Plugin for Grok Bot | `capthvnsen/alans-way-agents`: `alans-way-grok-bot/` scaffold, pending [PR #157](https://github.com/capthvnsen/alans-way-agents/pull/157) | Grok Bot skill/settings integration targeting the same shared config | Loading a Hermes Python plugin; Grok Bot cannot do that |

The app and CU MCP share a source directory and release bundle today. That is packaging, not a fifth product or a reason to move the server. CU MCP stays at its existing path; `workspace-mcp` is its product/client-entry name, not a new binary or package.

The VM router (`alans-way/scripts/workspace-router.cjs`), the repository-level operator tool `scripts/setup-remote-agent.sh` (outside the installed plugin), and optional HTTP bridge currently live in `alans-way-agents`. They adapt remote clients to this repo's CU MCP/host implementation. A generic MCP client does not need the Hermes Python runtime to speak MCP. Existing provisioning instructions may use a Hermes plugin installation path; that does not make the Grok package a Hermes plugin.

Supporting code in this repo is not another product: `src/hermes_companion/` is the optional Python file-tools/diagnostics CLI, `scripts/` contains install/connect/verification tools, `tests/` tests the Python/support tools, and `desktop/test/` and `ios/*Tests/` test Workspace/CU MCP. `mobile/voice/` is a separate installable Hermes voice bridge supporting Workspace iOS, not the main Alan's Plugin for Hermes product from the agents repo.

## Installation paths

Paths below are defaults, not instructions to copy user data or credentials between machines.

| Product / component | Install host and path | Instructions |
| --- | --- | --- |
| Workspace Mac | User's Mac: `/Applications/alans-way-localapp.app` | [README](../README.md#1-alans-workspace); `scripts/install-mac.sh` for a source build |
| Workspace iOS | iPhone through a beta invitation or Xcode; simulator build at `ios/.build/DerivedData/Build/Products/Debug-iphonesimulator/AlanWorkspace.app` | [iOS guide](../ios/README.md), [beta testing](ios-beta-testers.md); no public App Store link supplied here |
| Workspace Windows | User's PC: `%LOCALAPPDATA%\Programs\alans-way-localapp` for the source installer | [Desktop guide](../desktop/README.md); `scripts/install-windows.ps1` |
| Workspace Linux | User's desktop: `~/.local/share/alans-way-localapp` | `scripts/connect-linux.sh`; x64, systemd, desktop session, Node 22.12+ and git |
| CU MCP bundled on Mac | `/Applications/alans-way-localapp.app/Contents/Resources/app/scripts/browser-mcp.cjs` | [Generic client example](../README.md#2-alans-cu-mcp) |
| CU MCP from source | `<alans-way checkout>/desktop/scripts/browser-mcp.cjs`, with sibling modules and `desktop/node_modules/` | `cd desktop && npm ci`; Node 24 for development; connect over stdio locally or SSH |
| CU MCP VM browser host | VM's checkout of this repo, `desktop/scripts/vps-browser-host.cjs` and `vps-chromium-host.cjs` | [VM browser guide](../desktop/docs/vps-browser.md), [macOS guest](mac-vm-guest.md); provision once per host, keep private endpoints private |
| Hermes plugin components | Gateway host: `~/.hermes/plugins/alans-way/` and `~/.hermes/plugins/alans-way-computer/` by default | [Agents install guide](https://github.com/capthvnsen/alans-way-agents/blob/main/docs/install.md); native profiles can override `HERMES_HOME` |
| Grok Bot package | `alans-way-agents/alans-way-grok-bot/` scaffold, pending [PR #157](https://github.com/capthvnsen/alans-way-agents/pull/157) | Native Grok Bot install/loading is unverified; [existing connector setup](../desktop/docs/remote-agents.md) is a separate step |
| Shared config | `alans-way-agents/shared/config.schema.json`; proposed user file `~/.config/alans-way/config.json`, pending [PR #157](https://github.com/capthvnsen/alans-way-agents/pull/157) | Draft contract; no Hermes reader or automatic loader is implemented by that PR |
| Optional Python CLI | A Python virtual environment; `pip install -e '.[mcp]'` from this repo | [Contributing](../CONTRIBUTING.md#optional-python-companion-cli) |

A local CU MCP connection reads the host's private `Hermes Workspace/connection.json` under platform app data (for example `~/Library/Application Support/` on Mac). Use `--connection` only for an explicitly configured alternate host file. Do not put connection files in Git or move their tokens into issue reports. Agent IDs identify routing/tab ownership; they do not provide authentication between mutually hostile clients sharing a host account.

## Shared config contract

Alan's Plugin for Hermes and Alan's Plugin for Grok Bot target **one shared config spec** covering:

| Field area | Shared meaning |
| --- | --- |
| Persona | The assistant's character and conversational style |
| Voice | The assistant's voice settings; distinguish chat style from speech provider capabilities |
| Proactivity | When the assistant may initiate work/check-ins and the applicable limits |
| Identity | Stable assistant identity shared across supported agent integrations |

Keep one authoritative definition in `alans-way-agents`, with adapters for each agent's capabilities. Do not create competing Hermes/Grok specs here. Agent-specific runtime settings and secrets remain in their native stores; the shared identity does not merge transcripts, sessions, bot tokens, or approvals. The app and CU MCP enforce their own access policy regardless of persona/proactivity settings.

**Pending [agents PR #157](https://github.com/capthvnsen/alans-way-agents/pull/157):** [`alans-way-grok-bot/`](https://github.com/capthvnsen/alans-way-agents/tree/codex/hermes-shared-config-grok-scaffold/alans-way-grok-bot) contains the skill/settings scaffold, and [`shared/config.schema.json`](https://github.com/capthvnsen/alans-way-agents/blob/codex/hermes-shared-config-grok-scaffold/shared/config.schema.json) defines the draft v1 schema. The proposed user config is `~/.config/alans-way/config.json`. These paths are in that draft PR, not a claim that they ship on `main`.

The [Grok package README](https://github.com/capthvnsen/alans-way-agents/blob/codex/hermes-shared-config-grok-scaffold/alans-way-grok-bot/README.md) and [shared contract](https://github.com/capthvnsen/alans-way-agents/blob/codex/hermes-shared-config-grok-scaffold/shared/README.md) describe the remaining work: native Grok Bot loading/installation is unverified, and Hermes does not yet read this format. The PR adds no automatic loader or scheduler. A working MCP connector remains separate from installing the Grok scaffold. Both artifacts use the decided MIT license; see [licensing and dependency notices](licensing.md).

## Where to contribute or report issues

Workspace UI/iOS/handoff and CU MCP server bugs belong in [this repo](https://github.com/capthvnsen/alans-way/issues). Hermes plugin, Grok package, router adapters, and shared config changes belong in [alans-way-agents](https://github.com/capthvnsen/alans-way-agents/issues). For cross-product failures, link the related issues and name both products; do not copy credentials or user state into either repo.

The [issue forms](../.github/ISSUE_TEMPLATE/) collect product selection. Maintainers apply matching [product labels](../.github/labels.yml); dropdown selections do not auto-apply labels. PRs name all affected products and list unresolved choices under **Decisions for Alex**. See [CONTRIBUTING.md](../CONTRIBUTING.md).

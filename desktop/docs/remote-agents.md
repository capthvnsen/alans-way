# Connect any remote agent to Alan's CU MCP

**Alan's CU MCP** (`workspace-mcp`) is the shared Node computer-use product in `capthvnsen/alans-way`, with its server entry at `desktop/scripts/browser-mcp.cjs`. It stays there. **Alan's Workspace** is the app/host it controls. **Alan's Plugin for Hermes** and **Alan's Plugin for Grok Bot** live in [alans-way-agents](https://github.com/capthvnsen/alans-way-agents) and read one shared persona/voice/proactivity/identity config spec. Grok Bot's plugin is a skill + settings package; it cannot load Python Hermes plugins.

This guide installs/configures the **CU MCP connection**, not the Grok skill/settings package. The published agents tree still needs a canonical Grok package install path and shared spec path; see [product boundaries and TODOs](../../docs/products.md). The router and bridge ship under the agents repo's `alans-way/scripts/`; the operator-run SSH setup tool lives at repository-level `scripts/setup-remote-agent.sh`, outside the installed plugin. That packaging does not require a generic MCP client to load a Hermes plugin. For local clients, use the [direct stdio example](../../README.md#2-alans-cu-mcp). Community: [Discord](https://discord.gg/jBQCPUsVE) · [openalan.com](https://openalan.com).

Any MCP client can use the same Workspace browser (`cua_alans_way_*`) and the same computer use (`workspace_computer_*`) that Hermes uses, with the same failover to the VM browser when your computer sleeps. Grok Bot is the first non-Hermes client. Each agent gets its own bot ID, its own tabs and its own approval.

```
MCP client ──transport──▶ VM: workspace-router.cjs ──ssh──▶ your computer: browser-mcp.cjs ──▶ Alan's Workspace app
                                     └── computer offline ──▶ VM browser host (mirrored tabs)
```

Everything after the router is the Hermes path, unchanged. The router ships with the Alan's Way plugin; the SSH setup tool runs from a checkout of [`capthvnsen/alans-way-agents`](https://github.com/capthvnsen/alans-way-agents); the app enforces the desktop lease and the approval gate.

## Transport

| | SSH over Tailscale (primary) | HTTP bridge (fallback) |
| --- | --- | --- |
| Use when | The client's computer is on your tailnet and can run a local command | The client can't join your tailnet or hold an SSH session |
| How | Stdio over SSH to the VM's Tailscale name or `100.x` address. A dedicated key whose `authorized_keys` line is `restrict,command="<router>"` can start the router and nothing else | `remote-agent-bridge.cjs` on the VM serves MCP over HTTP at `/mcp`, one router per session, bearer token |
| Exposure | The VM's existing sshd, reached only through your tailnet | Loopback or private address only; you put a TLS proxy you control in front |
| Approval prompts in the client (browser `commit`) | Yes, if the client supports MCP elicitation | No: replies are plain JSON, so commit actions are refused |
| Desktop approval gate | Yes (enforced by the app) | Yes (enforced by the app) |

**SSH over Tailscale is primary**: no new server, no new port, no public exposure, smallest attack surface. Tailscale is already how your computer and the VM talk. **Grok Bot status (2026-10-27):** Grok Bot's computer reaches the VM over SSH through Tailscale, tested 2026-10-26 and 2026-10-27 with all 14 Workspace tools. Use the HTTP bridge only for a client that can't join your tailnet; it ships in the plugin and is off by default. Both transports start the same router with the same flags, so nothing below changes with the transport.

The key restriction is enforced by OpenSSH. If the VM has Tailscale's own SSH server turned on (`tailscale set --ssh`), it answers port 22 on the tailnet address and does not read `authorized_keys`, so the tailnet's SSH rules decide the login and the forced command does not apply. Turn it off on the VM with `tailscale set --ssh=false`; plain SSH over the tailnet still works.

## Setup (SSH)

On the VM, as the user Hermes runs as, from an `alans-way-agents` checkout:

1. Run `sh scripts/setup-remote-agent.sh --bot-id BOT_ID --bot-name "BOT NAME" --user VM_USER`. Pick a short `BOT_ID` such as `grok`. It must not be one of your Hermes bot IDs.
2. Copy the printed client JSON. Its shape is [`remote-agent-connector.example.json`](remote-agent-connector.example.json): replace the host (`HOST` in the printed JSON, `VM_HOST` in the example) with the VM's Tailscale name (`*.ts.net`) or `100.x` address, and `KEY_PATH` with where the private key lives on the client's computer.
3. Put the client's computer on your tailnet and check that it can reach that name. Give the client the private key through its own secret store. Never paste it into a chat.
4. Check without changing anything: `sh scripts/setup-remote-agent.sh --bot-id BOT_ID --print --probe` lists the tools through the forced command.

Remove an agent with `--remove --bot-id BOT_ID`; only its key line goes.

**Grok Bot CU MCP connection:** Settings → Add a custom connector → paste the JSON. Optional custom instruction: "Prefer the Alan's Workspace tools for the browser and for my Mac." To make Grok always use them, set Settings → Computer → Your computer → Never allow. Installing the separate [Grok Bot skill/settings package](../../README.md#4-alans-plugin-for-grok-bot) remains an additional step once its package/install path is published.

## Setup (HTTP bridge)

Only when the client can't join your tailnet or hold an SSH session. On the VM:

```sh
(umask 077; openssl rand -hex 32 > ~/.alans-way-bridge-token)
ALANS_WAY_REMOTE_BRIDGE=1 ALANS_WAY_REMOTE_BRIDGE_TOKEN_FILE=~/.alans-way-bridge-token \
  HERMES_WORKSPACE_MAC_SSH=YOU@YOUR_COMPUTER HERMES_WORKSPACE_ALLOW_DESKTOP_ACTIONS=1 \
  node ~/.hermes/plugins/alans-way/scripts/remote-agent-bridge.cjs --bot-id BOT_ID --bot-name "BOT NAME"
```

Client JSON: `{"url": "https://YOUR_PROXY/mcp", "headers": {"Authorization": "Bearer YOUR_TOKEN"}}`. Take the `HERMES_*` values from the forced command that `setup-remote-agent.sh --print` shows. The bridge listens on `127.0.0.1:8790` and refuses public addresses. A client whose connector runs in someone else's cloud must reach your proxy over the internet: decide that on purpose, keep TLS and the token, and never put the bridge itself on a public port.

## Desktop input approval

Desktop input from a remote agent needs your OK on your computer. The first `workspace_computer_launch` or `workspace_computer_action` from an agent you have not added to Alan's Workspace opens a prompt there:

> Let BOT NAME use the apps on this computer? **Deny** · **Allow** · **Always allow**

- **Allow** lasts until that agent has been idle for 30 minutes. **Always allow** remembers the bot ID.
- The prompt waits 40 seconds. Unanswered, the call fails with `desktop_approval_required` and nothing is sent; the agent is told to ask you and retry.
- **Deny** fails the call with `desktop_approval_denied`; the agent is told not to retry, and its calls for the next minute are refused without asking again.
- Reads (`workspace_computer_apps`, `_snapshot`, `_screenshot`, `_menu`) never ask.
- Hermes bots in your Workspace bot list and overseer bots (`HERMES_OVERSEER_BOTS`) never ask: Hermes asks you in its own chat before computer use.
- To undo **Always allow**: quit Alan's Workspace, remove the ID from `desktopTrustedBots` in `~/Library/Application Support/Hermes Workspace/preferences.json`, start it again.

The bot ID comes from the operator's forced command or bridge flags, not from the model, which is why the app can trust it. The gate protects you from connector agents; it is not a boundary against someone who can already read the app's local API token, which only your own user account and processes it starts can do. Browser actions keep their own approval: consequential ones carry `commit` and need MCP elicitation in the client.

Desktop input also needs the operator opt-in `HERMES_WORKSPACE_ALLOW_DESKTOP_ACTIONS=1`, which `setup-remote-agent.sh` sets; without it the router hides launch and action.

## One agent at a time on the desktop

Launch, menu and action take a desktop lease keyed by bot ID. A second agent gets `desktop_busy` with the holder's name and a retry time; reads stay open. The lease ends 20 seconds after the holder's last input. See [integration.md](integration.md#mac-desktop-input-lease).

## Custom instructions

For clients that support MCP images:

```text
Use Alan's Workspace: cua_alans_way_* for websites; workspace_computer_* for native apps. Omit browser host normally; use VM only if requested or reported unavailable. Skip status/tabs during working calls. Open with snapshot:true. Act from current refs; keep generation and windowId for native actions, and send expect_host from the observation you acted on. Reuse action effects and changed/removed/unchanged state; don't reread what the reply already shows. Batch short known sequences; add wait for readiness and read only for missing browser text. Use text/controls first; screenshots are attached MCP images. Native: apps -> snapshot(pid) -> action; type with a ref replaces text. In Save dialogs use cmd+shift+g for folders, then a bare filename. Retry a failed read once; never blindly repeat uncertain input. Follow the recovery advice in tool errors. Honor approvals, human holds, lock and off-limits errors; release login/CAPTCHA to the user.
```

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `desktop_approval_required` | Nobody answered the prompt on your computer within 40 s. Click **Allow** there and have the agent retry. |
| `desktop_approval_denied` | You clicked Deny. The agent stops; tell it what to do instead. |
| `desktop_busy: The Mac is being used by X` | Another agent holds the desktop. Wait the given seconds; take a fresh snapshot before acting. |
| Host mismatch refusal on launch/action | Desktop tools moved between your computer and the VM. Call `workspace_computer_apps` and snapshot again; old pids mean nothing on the other host. |
| `workspace_computer_action` missing from the tool list | The router was started without `HERMES_WORKSPACE_ALLOW_DESKTOP_ACTIONS=1`. Rerun `setup-remote-agent.sh`. |
| `Configured browser unavailable` | Alan's Workspace is not running on that machine, or the VM browser host is down. |
| `Permission denied (publickey)` | Wrong key path in the client JSON, or the key line was removed. Rerun setup. |
| SSH hangs or times out from the client | The client's computer is not on your tailnet, or the host is a public address. Check `tailscale status` there and use the VM's Tailscale name. If the client can't join the tailnet, use the HTTP bridge. |
| Commit actions return `approval_unavailable` | The client does not support MCP elicitation (always true over the HTTP bridge). Do those steps yourself. |
| A `type` refused in a Save dialog | A folder path in the name field becomes part of the file name: press cmd+shift+g, type the folder, return, then the bare name. |

Parity with Hermes, gap by gap: [docs/remote-agent-cu-parity.md](../../docs/remote-agent-cu-parity.md).

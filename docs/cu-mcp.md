# Install Alan's CU MCP on its own

Alan's CU MCP (`workspace-mcp`) gives any MCP client the `cua_alans_way_*` browser tools and `workspace_computer_*` computer tools over stdio. It needs Node 22.12+ and a running host on the same machine: Alan's Workspace or a [VM browser host](../desktop/docs/vps-browser.md). The server is a client of that host, so it does nothing useful without one.

## Install

```sh
npm install -g github:capthvnsen/alans-way
```

This installs only the server's files and the MCP SDK, not Electron. It adds a `workspace-mcp` command. Run the same command to update.

To check the install:

```sh
workspace-mcp --version
```

It prints `workspace-mcp 0.1.0`, or the installed version.

## Check the connection

Use the same arguments as your client config, plus `--health`:

```sh
workspace-mcp --bot-id YOUR_AGENT_ID --health
```

| Result | Exit code | Output |
| --- | --- | --- |
| The host answered | 0 | `{"ok":true,"version":"0.1.0","node":"v24.0.0","capabilities":[...]}` |
| No host, or a bad connection file or credential | 1 | `{"ok":false,"version":"0.1.0","node":"v24.0.0","error":"..."}` |

The check reads the host's status and changes nothing. It never prints the connection token.

## Configure your client

Give each agent its own ID. Don't copy the connection token into client config: the server reads it from the private connection file. Use `--connection PATH` only for a deliberately configured alternate host file.

If the client doesn't inherit your shell's `PATH`, replace `workspace-mcp` with the absolute path from `command -v workspace-mcp`. Its `node` must also be reachable; if it isn't, use your absolute Node path as the command and pass `"$(npm root -g)/alans-way-workspace-mcp/desktop/scripts/browser-mcp.cjs"` as the first argument.

### Hermes

Merge this into the profile's `config.yaml`:

```yaml
mcp_servers:
  workspace_browser:
    command: workspace-mcp
    args: [--bot-id, YOUR_BOT_ID]
    timeout: 120
```

The timeout is longer than the 90 seconds a browser action can take, so Hermes doesn't abandon a running action and retry on top of it.

**If this profile uses Alan's Plugin for Hermes, skip this entry.** The plugin already starts the server through its router and adds failover. A second server under another name would duplicate the tools, and the plugin's setup only removes duplicates that run `browser-mcp.cjs` under `node`. Nothing about the plugin changes when this package is installed.

### Grok Bot

In Grok Bot, open Settings → Add a custom connector and paste:

```json
{
  "mcpServers": {
    "workspace-mcp": {
      "command": "workspace-mcp",
      "args": ["--bot-id", "grok"]
    }
  }
}
```

This is for a Grok Bot computer that also runs the host. To reach a host elsewhere, use the tested [SSH connection](../desktop/docs/remote-agents.md) instead.

### Claude Code

```sh
claude mcp add workspace-mcp -- workspace-mcp --bot-id claude-code
```

## Other ways to run it

The server stays at `desktop/scripts/browser-mcp.cjs`. The copy in the Workspace app, a source checkout, and the plugin's connector copy all keep working by that path, and accept `--version` and `--health` too.

In a checkout or a global install, the server's version comes from the `VERSION` constant in `browser-mcp.cjs`. It is separate from the app version. When releasing a change to the server, bump the constant and the root `package.json` together; a test fails if they differ.

## Good to know

- The handshake's server name is still `hermes-cua-alans-way`, so existing clients see no change.
- `npm install -g` pins the MCP SDK exactly, but the SDK's own dependencies resolve at install time.
- The package is marked private and is not on the npm registry, so install it with the command above.
- On Mac, grant Accessibility and Screen Recording to Alan's Workspace, not to this command. Computer use goes through the app.

Design rationale: [design note](cu-mcp-standalone-design.md).

# Standalone CU MCP: design note

Goal: make Alan's CU MCP (`workspace-mcp`) installable on its own without moving it or changing how the Hermes plugin starts it.

## Today

- The server is `desktop/scripts/browser-mcp.cjs`. It runs from a `desktop/` checkout with a full `npm ci` (Electron included) or from the Workspace app bundle.
- It has no package, binary or version flag of its own. The MCP handshake reports a hardcoded `0.1.0`.
- `alans-way-agents` finds the script by path: `workspace-router.cjs` probes the app bundle, the connector copy, its sibling and `/opt/hermes-alans-way/browser/desktop/scripts/`. `setup.sh` copies `browser-mcp.cjs`, `src/*.cjs` and the native helper source into the connector directory.

So the path and the `src/` layout are a contract. Moving the server, or making it depend on a file those copies don't carry, would break installed plugins.

## Reuse

| What | How |
| --- | --- |
| `browser-mcp.cjs` | It is the `bin` entry, at its current path. It already has a shebang. No wrapper. |
| `requestOnce('/v1/status')` | `--health` takes the same path as a tool call: connection file, per-bot credential check, loopback request. |
| The `0.1.0` handshake version | It becomes the CU MCP version, so `--version` and the handshake cannot disagree. |
| `--bot-id`, `--connection`, `HERMES_WORKSPACE_CONNECTION` | `--health` takes the same arguments as the server, so a client's config can be checked by adding one flag. |
| Exact `@modelcontextprotocol/sdk` pin | Same version as `desktop/package.json`. |
| `node --test test/*.test.cjs` in `npm run check` | The new test file is picked up by CI automatically. |

## Add

| What | Why |
| --- | --- |
| Root `package.json` (`alans-way-workspace-mcp`, bin `workspace-mcp`) | npm can only install a Git dependency from the repository root. Its `files` list ships the server's modules and nothing from Electron. |
| `--version`, `--health` in `browser-mcp.cjs` | Checks that work before any client is configured. |
| `desktop/test/workspace-mcp-package.test.cjs` | Keeps the manifest and the server honest, and runs the server from only the shipped files. |
| `docs/cu-mcp.md` | Install command, client snippets, checks. |

## Decisions

- **No new module.** Everything goes inside `browser-mcp.cjs`, because connector copies and bundles have no root `package.json` to read a version from. A test keeps the constant and the manifest equal.
- **Own version number.** It starts at `0.1.0` and is independent of the app version in `desktop/package.json`. Tags would be `cu-mcp-vX.Y.Z`, which the release workflow's `v*` trigger ignores.
- **`private: true`.** This blocks an accidental `npm publish`. Installing from Git still works, and publishing to npm later means removing one line.
- **Server name unchanged.** The handshake still says `hermes-cua-alans-way`, and tool names are unchanged. The Hermes and router paths need no edits.

## Not doing

- Moving code into `packages/`, or a build or bundle step.
- npm registry publishing, tags or release automation.
- `npm-shrinkwrap.json`. The SDK is pinned, but its transitive dependencies resolve at install time.
- Changes to `alans-way-agents`. A future `setup.sh` could use the binary, but nothing needs it now.

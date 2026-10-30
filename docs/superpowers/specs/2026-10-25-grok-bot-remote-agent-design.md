# Alan's Workspace for any remote agent: Grok Bot first

Date: 2026-10-25. Owner: Alex. Author: [Claude].

## Intent

Grok Bot should use the same Alan's Workspace browser and the same Mac computer use that Hermes uses through Alan's Way, with the same Mac to VM failover when the laptop sleeps. No new repo: Alan's Workspace (`capthvnsen/alans-way`) and the router in `capthvnsen/alans-way-agents` become "works with any remote agent", and Grok Bot is the first non-Hermes agent. Hermes and Grok Bot can share one Workspace browser at the same time (optional, each with its own tabs).

Success, in Alex's words: the remote agent (Grok Bot) can perform any task on the Mac faster than, and as effectively as, Grok Bot's own built-in computer use.

## Goals

1. Grok Bot reaches the existing workspace tools (`cua_alans_way_*` browser, `workspace_computer_*` Mac computer use) as a Grok custom connector.
2. Mac awake: browser actions go to the Mac Workspace browser, computer use drives the Mac. Mac asleep or offline: browser actions fail over to the VM browser host with mirrored tabs, exactly as for Hermes today.
3. Hermes and Grok Bot can run against the same Workspace app at once without driving the Mac desktop at the same moment.
4. Measured: Grok Bot with our connector is faster than Grok Bot's built-in Mac computer use at equal or better success on the same tasks.

## Non-goals

- No new repo, no fork of the app, no HTTP MCP server, no new transport.
- No Telegram, voice, calls or iOS work. Grok Bot has its own chat.
- No handoff to Grok Bot's own cloud computer. xAI's docs say updates remove installed packages and idle computers hibernate. The handoff target is the user's own VM (Alex: Orgo).
- No change to Hermes itself, no plugin catalog re-pin required for Alex's setup.

## Anti-goals

- Anything Grok-specific or quoting Grok internals in public repos. The Grok reverse-engineering notes (`~/.hermes/notes/alans-way/research/grok-re/`) are private. Public docs may only describe Grok Bot's public UI ("Add a custom connector").
- A Grok key that can do more on the VM than run the router.
- Regressions for Hermes: the Hermes path, its tool exclusions and its config stay as they are.

## What exists (verified 2026-10-25)

- `desktop/scripts/browser-mcp.cjs`: stdio MCP server, `--bot-id`, talks to the app's loopback API. Tools: `cua_alans_way_{status,tabs,open,snapshot,screenshot,action,close,recordings}`, `workspace_computer_{apps,launch,snapshot,screenshot,menu,action}`.
- `alans-way-agents: alans-way/scripts/workspace-router.cjs`: stdio launcher on the VM. `ssh <mac> node browser-mcp.cjs` when the Mac is up, the VM browser host otherwise, in-session failover with mirror restore. Agent-agnostic, configured by flags/env. `HERMES_WORKSPACE_ALLOW_DESKTOP_ACTIONS=1` exposes `workspace_computer_action`.
- Tabs carry `botId`/`allowedBots`/`controller`/`epoch`. Several bot IDs already share one browser (`desktop/docs/integration.md`).
- Mirror to VM already covers every bot that owns agent tabs (`desktop/src/vps-browser.cjs` `createMirrorPusher`: `current.keys()`); `prefs.bots` only seeds the startup clear.
- Mac computer use has no per-agent arbitration (`desktop/src/computer.cjs`).
- Alex's Orgo VM: public IP, sshd on 0.0.0.0:22, router at `/root/.hermes/plugins/alans-way/scripts/workspace-router.cjs`, Hermes runs it with `--bot-id 8604177563` and excludes `workspace_computer_action` (Hermes drives desktop input through the `alans-way-computer` provider instead).
- Grok Bot 0.75.8 (installed): Settings has "Add a custom connector" taking MCP server JSON. HTTP/SSE servers run on xAI's backend; stdio servers run on the Bot's cloud computer. Per-server custom instructions exist.

## Design

### Transport: stdio over SSH, forced command

Grok Bot custom connector (stdio, runs on the Bot's computer):

```
ssh -i <key> -o StrictHostKeyChecking=accept-new <user>@<vm public host> 
```

On the VM, the key's `authorized_keys` entry is `restrict,command="<router command>"`, so the key can only start `workspace-router.cjs --bot-id <grok id> --bot-name "Grok Bot"` with the same Mac SSH/state flags Hermes uses, plus `HERMES_WORKSPACE_ALLOW_DESKTOP_ACTIONS=1`. Everything after SSH is the existing Hermes path. This is the same stdio-over-SSH pattern the router already uses VM to Mac.

Builder settles with a live check: how the private key reaches the Bot's computer (a Grok secret in the connector's env written to a 0600 file by an `sh -c` wrapper, or a file the bot creates once; files survive computer updates per xAI docs), and whether Grok's stdio JSON wants `command`/`args`/`env` (Cursor `mcp.json` shape is the expected one).

### Setup: one generic script

An operator-run script in `alans-way-agents` at `scripts/setup-remote-agent.sh` (outside the installed plugin), working for any remote agent, named generically (e.g. `sh scripts/setup-remote-agent.sh --bot-id grok --bot-name "Grok Bot"`):

1. Generate a dedicated ed25519 key for that bot ID.
2. Install the forced-command `authorized_keys` line for it. Mac SSH, host OS and state-file flags are copied from the existing Hermes `workspace_browser` block when present, else taken from flags.
3. Print the connector JSON to paste into Grok Bot's "Add a custom connector", the public host, and the custom instruction text.
4. `--remove` deletes that bot's key line. Re-running is idempotent.
5. `--probe` style self-check: runs the forced command locally and lists tools.

Hermes config is never modified.

### Desktop lease (app)

One agent drives Mac desktop input at a time. In the app's `/v1/computer` handlers: `launch`, `menu` and `action` take or refresh a lease for the calling bot ID; another bot gets a clear 409 (`desktop_busy`, holder's display name, retry-after seconds). Reads (`apps`, `snapshot`, `screenshot`) stay open. The lease expires after a short idle (builder's call, about 20 s) and is released on the holder's MCP disconnect if that is visible. The human is never blocked (native front policy unchanged). The lease applies to every bot, Hermes included, which is why this is generic.

### Parity of computer use

"Same computer use as Hermes" means Grok's calls hit the same app code. The Hermes `alans-way-computer` provider (`alans-way-agents`) may add behavior on top of the raw `workspace_computer_*` tools (batching, post-action observation, screenshot delivery, native front policy hooks). Builder audits the provider and moves anything that affects speed or success into the shared `browser-mcp.cjs` / app layer so both agents get it, or records why it is Hermes-only. Hermes behavior must not change.

Screenshot delivery: `browser-mcp.cjs` already returns MCP `type: 'image'` content for browser and computer screenshots; only the tool description talks about Hermes `MEDIA:<path>`. Make the description client-neutral and check the router passes image content through unchanged. No new code path.

### Docs

`desktop/docs/remote-agents.md` (or a section of `integration.md`, builder's call): generic "use Alan's Workspace from any remote agent", with a Grok Bot example limited to its public UI: Add a custom connector, paste JSON, optional custom instruction "Prefer the Alan's Workspace tools for the browser and for my Mac", and the option of Settings → Computer → Your computer → Never allow so Grok always uses ours. README gets one line linking it.

## Verification (evidence before "done")

1. Unit: lease (take, refresh, expire, other bot 409, reads unaffected); forced-command line generation and idempotent install/remove; image-content screenshot path. Existing desktop and plugin test suites pass.
2. Local end to end: router via the forced command on the VM lists tools and opens a tab in the Mac Workspace under the Grok bot ID, while Hermes still works.
3. Live with Alex's Grok Bot: add the connector; golden path (open a page in the Workspace, Mac app task via computer use); failover (Mac marked offline → same browser task continues on the VM with the mirrored tab); shared browser (Hermes and Grok tabs side by side; a Hermes desktop action during a Grok one gets `desktop_busy`).
4. A/B: the same 5 Mac tasks run by Grok Bot with its built-in computer use vs with our connector. Report seconds, tool calls and success per task. Takes over Alex's screen, so run when Alex says go.

## Decided by Alex

- Same Workspace browser as Hermes; sharing between Hermes and Grok Bot is optional.
- Handoff target: Grok's VM or the user's own VM, whichever is possible; Grok's is ruled out by its docs, so own VM.
- No new repo; open up Alan's Workspace and the CUA.
- Codex workers do the implementation.

## Settled after the builder check

- **Order:** a spike comes first. Add a throwaway connector in Alex's Grok Bot whose stdio command is a plain `ssh` to the VM, forced to run the router, and check that tools list and one call works. Everything else waits on it only for the transport; the lease and docs lanes start in parallel.
- **Fallback (Claude's call):** if Grok's computer cannot hold an outbound SSH stdio session, add the smallest HTTP MCP bridge on the VM (streamable HTTP wrapping the same router, bearer token, TLS via the existing tunnel setup). Running an SSH client on Grok's computer is fine: it is a connector, not a handoff target.
- **Hermes and the lease (Claude's call):** the lease keys on the bot ID (`X-Hermes-Bot`). The `alans-way-computer` provider waits and retries on `desktop_busy` (bounded by the lease's retry-after and a total cap of about 30 s), then reports "the Mac is busy with <bot>" plainly. That small provider change is in scope. With one agent, nothing changes. Idle expiry (about 20 s) stops a retry loop from holding the Mac forever.
- **Failover prerequisites:** `alans-way-mac-watch` already runs under supervisord on Orgo and writes `/var/lib/hermes-alans-way/mac-state.json`. The Grok router session reads the same file.
- **Key user and reach (Claude's call):** the forced command runs as the same user as Hermes (root on Orgo), reusing Hermes's Mac SSH settings. Grok driving the Mac through `workspace_computer_action` is the feature, so that is accepted. `restrict` blocks a PTY, forwarding and other commands.
- **A/B (Claude's call):** 5 Mac desktop tasks taken from the existing N4 head-to-head set (native apps plus the Mac browser). Wall time is measured from sending the prompt to the bot's final reply, model latency included, because that is what Alex feels. Claude judges success against each task's checkable end state and shows the evidence.
- **Launch is desktop input:** the router treats `workspace_computer_launch` as desktop input (`DESKTOP_INPUT_TOOLS`); the Grok router enables desktop actions, so launch and action are both exposed, and both take the lease.

## Claude's calls (check these)

- Stdio over SSH with a forced command instead of an HTTP MCP endpoint (no new server, no OAuth, smallest attack surface).
- Router stays in `alans-way-agents`; not moved to the app repo (avoids a catalog re-pin).
- Header names (`X-Hermes-Bot`) and `HERMES_*` env names stay; renaming would break existing installs.
- Lease covers Hermes too.

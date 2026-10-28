# Agent-agnostic simplification: assessment

Research date: 2026-10-27. Author: [Claude]. Source review only: no code, config, tests or CI were changed and nothing was run against a live machine. Citations:

- Paths with no prefix are in this repo (`capthvnsen/alans-way`, `origin/main` at `7e05d52`).
- `agents:` paths are in `capthvnsen/alans-way-agents` at `origin/main` `4da7c64`.
- **UNVERIFIED** marks a claim taken from web search snippets or from Hermes core, whose source is in neither repo.

## The question

Should Alan's Way become an agent-agnostic product with this shape?

1. **Alan's Workspace** (the desktop app) is only the chat, browser and approval surface.
2. **One MCP server** exposes `browser.*` and `computer.*` tool groups plus a lease/handoff tool. It hands the browser to the VM automatically when the lid closes, and it absorbs today's separate computer-use plugin.
3. **A per-bot profile file** sets voice, proactivity (ask-first vs act-then-report) and trusted tools. The approval gate reads the same file.

**Revised 2026-10-27 against Alex's authoritative core features.** This doc is judged against these:

1. **Workspace:** a very simple chat on the left, and a browser that feels like the ChatGPT desktop app's built-in browser.
2. **Computer use** (MCP/CUA) at the level of Codex's computer use, on the local Mac and inside the workspace browser. It must be extremely fast and accurate, even when remote agents drive it.
3. **Handoff:** when the lid closes, browser work hands off to the VM.
4. **A live window** into the VM's desktop.
5. **The same threads on any device**, through Telegram or the agent's own app (for example the Grok Bot app).
6. **Works with each agent's production version purely as added tools.** No forks.
7. **Proactivity.**

The targets are **Hermes and Grok Bot**, plus **Claude Duet** if it makes sense. Claude Code and Codex are dropped (note in 1.5). Tailscale is the backbone transport; section 1.9 confirms or challenges that.

**Short answer:** go-with-changes. Most of item 2 already exists. The new pieces are a real lease and a profile file, and both rest on bot identity, which today is a header the caller writes about itself. Fix identity first, or the profile's "trusted tools" list becomes a way around the approval gate. Keep the chat pane, but fill it per agent: there is no shared chat protocol, and feature 5 puts the threads in each agent's own app. Tailscale holds as the backbone for every machine we own. Grok Bot and Duet connect from their vendor's cloud, which is not on the tailnet, so they need one public HTTPS front door. See [Recommendation](#recommendation).

## 1. Current architecture map

### 1.1 Desktop app

The app is an Electron app. `desktop/src/main.cjs` alone is 3,625 lines. It is already more than a browser:

- **Chat.** An embedded Telegram Web client (`telegram-preload.cjs`, `telegram-open.cjs`). There is also a native Hermes chat over Hermes `serve` and the TUI gateway: `hermes-remote.cjs:2-14,141-153` refuses anything that is not Hermes, and `hermes-hub.cjs:220-276` and `hermes-conversation.cjs:235-276,654-760` speak Hermes's own JSON-RPC.
- **Agent browser.** Separate Chromium tabs, one cursor per tab, take-over and hand-back.
- **Computer-use host.** The native helpers run inside the app's GUI session, because a process started over SSH lacks macOS screen and accessibility (TCC) grants and lands in Windows Session 0 (`main.cjs:46-55`).
- **Desktop approval dialog.** See 1.6.
- **Other.** Updaters for the app, the VM and Hermes (`vm-update.cjs`, `update-all.cjs`, `scripts/hermes-update.sh`), cloud onboarding (`cloud-*.cjs`), a recorder, extensions and downloads.

### 1.2 Browser control

**The loopback API.**

- **Protocol.** Plain HTTP and JSON on `127.0.0.1:9464`, set by `HERMES_WORKSPACE_PORT` with a random port as fallback (`main.cjs:2994-3282`, `main.cjs:3274-3281`).
- **Request guards.** Requests carrying an `Origin` header are refused, and the host must be loopback (`main.cjs:3008-3010`, `shell-support.cjs:114-117`).
- **Token.** One bearer token, made fresh on every launch (`main.cjs:134`). It is written to `<userData>/connection.json` with mode 0600 (`main.cjs:3270`).
- **Endpoints.** `/v1/status`, `/v1/tabs[...]`, `/actions`, `/control`, `/v1/recordings`, `/v1/computer/*` (`main.cjs:3016-3263`, `desktop/docs/integration.md:13-25`).

**Who is calling.** The bot ID is the `X-Hermes-Bot` header, any string up to 100 characters. The only check is in `core.cjs:277-281` (read at `main.cjs:3014`). Every bot uses the same token, so anything that can read `connection.json` can claim any bot ID.

**Ownership.** Each tab carries `botId`, `allowedBots`, `controller` and `epoch` (`main.cjs:717`, `core.cjs:277-288`).

- **Epoch.** Each change of controller bumps the epoch and cancels queued input (`main.cjs:881-916`). A stale epoch gets 409 `stale_control_epoch`.
- **Auto take-back.** After the human has been idle for 3 s, an agent can take a tab back (`core.cjs:313-318`).
- **Hand-back.** An agent can hand a tab to the human with a reason such as `captcha` or `login`; the hold lasts 30 minutes (`core.cjs:190-212`).
- **Grants.** I found no renderer caller of the `grant-tab` IPC (`main.cjs:1926-1934`), so tab grants look API-only.

**One MCP server already exists.** `desktop/scripts/browser-mcp.cjs` is a stdio MCP server named `hermes-cua-alans-way` (`browser-mcp.cjs:31-36,384-386`). It requires `--bot-id` (`:38-42`) and exposes 14 tools (`:110-196`):

- **Browser:** `cua_alans_way_{status,tabs,open,snapshot,screenshot,action,close,recordings}`. `_action` with `claim` or `release` maps to the control endpoint (`:481-483`).
- **Computer:** `workspace_computer_{apps,launch,snapshot,screenshot,menu,action}`.

### 1.3 Lid-close handoff (Mac to VM)

Lid-close handoff lives in the plugin, not in the app. `agents:alans-way/scripts/workspace-router.cjs` (3,323 lines) is a stdio launcher on the VM.

**Choosing a host.**

- When the Mac is up, the router runs `ssh <mac> node browser-mcp.cjs`. Otherwise it uses the VM browser host (`router:371-417,1317-1342,3137-3154`).
- `mac-watch` probes every 30 s and needs two matching reads before it changes its verdict (`router:1217-1290`).

**When it fails over in mid-session** (`failOver`, `router:1553-1579`):

- The backend is silent for more than 8 s (`:1513-1525`).
- Two "unavailable" errors arrive in a row (`:3050`).
- A call passes its hard limit of 80 s, or 100 s for a batch (`:1493-1496`).
- mac-watch reports the Mac offline (`:3202-3205`).

**What happens to calls during failover.**

- Read-only calls, and calls that were never sent, are replayed on the VPS.
- A call that was already sent is reported as "may or may not have happened", never retried (`router:1688-1697`).
- Other calls wait up to 25 s while mirrored tabs are restored (`router:594-720,1640-1748`).

**The mirror.**

- Every 10 s the app pushes the URL, scroll position, drafts and cookies of each agent tab to the VM (`main.cjs:292-331,3477`, `vps-browser.cjs:64-108`). Password-like fields are excluded.
- `POST /v1/restore` reopens those tabs on the VM (`desktop/scripts/vps-browser-host.cjs:740-806`).

**Going back to the Mac.** The router waits until the session has been idle for 60 s and it sees two "online" reads. Then it exits and Hermes respawns it (`router:349-355,3227-3275`). VM tabs stay on the VM; nothing mirrors them back.

**What is missing.**

- **No lease or fencing between hosts.** Epochs are per host (`core.cjs:368-372`).
- **No cross-host handoff button in normal setups.** Manual handoff exists as `handoffTab` (`main.cjs:2617-2648`). Its "Move to VPS" button appears only when `prefs.vpsBrowser.sshHost` is set (`renderer.js:470-480`), and that setting is no longer in the UI (`desktop/docs/vps-browser.md:168-173`).
- **A conflict with an earlier promise.** `docs/continuity.md:14` says host-specific work "never executes on the VPS as a fallback". Automatic browser failover only fits that if browser work does not count as host-specific. Nothing written down settles which it is.

### 1.4 Computer use

**The request path for Hermes.**

1. Hermes `computer_use` calls the `alans-way-computer` provider.
2. The provider starts its own private router child (`agents:alans-way-computer/__init__.py:177-204`).
3. The router SSHes to the Mac and runs `browser-mcp.cjs`.
4. `browser-mcp.cjs` calls the `/v1/computer/*` HTTP routes in the app.
5. The app talks to the native helper: `mac-computer.swift`, `win-computer.cs`, or `vps-computer.py` with AT-SPI and xdotool (`main.cjs:51-55`).

**What the plugin really is.** `alans-way-computer` registers no tools. It registers only `ctx.register_computer_use_provider` (`agents:alans-way-computer/__init__.py:968-973`; `docs/catalog/alans-way-computer.yaml:29-33`). It translates Hermes's `ComputerUseBackend` into `workspace_computer_*` calls:

- Element-number cache.
- Choosing pixels or text for a capture.
- Host tracking.
- Retrying on `desktop_busy` (`__init__.py:326-350,357-831`).

It depends on private Hermes internals: `tools.mcp_tool_config._resolve_stdio_command` (`:91-133`). It also needs a Hermes newer than 0.21.5 (`plugin.yaml:7`).

**The desktop lease.** One bot ID at a time, kept for 20 s after its last action. Anyone else gets 409 `desktop_busy` (`desktop/src/computer.cjs:72-90`). The lease covers launch, menu and action only (`main.cjs:3092-3119`), and exists on macOS only (`main.cjs:2995`). Windows and Linux have none.

**Safety checks in the helper.**

- **Front-app policy.** The helper refuses the frontmost app while the user has been active within the last 2 s (`mac-computer.swift:58-80`).
- **Blocklist.** Keychain, password managers, UAC and similar (`computer-policy.cjs:7-45`). The list is sent to the helper in its `init` line (`computer-helper.cjs:86-87`), so the caller supplies it.
- **Fixed in the helper.** The password-field, locked-screen and user-idle checks are hard-coded (`mac-computer.swift:761-794`).

### 1.5 Remote-agent paths (SSH and MCP)

`desktop/docs/remote-agents.md:1-48` gives two paths for any MCP client:

- **SSH stdio (primary).** A dedicated key whose `authorized_keys` line is `restrict,command="<router>"`. `agents:alans-way/scripts/setup-remote-agent.sh:134-140` always sets `HERMES_WORKSPACE_ALLOW_DESKTOP_ACTIONS=1`.
- **HTTP bridge (fallback).** `agents:alans-way/scripts/remote-agent-bridge.cjs:1-29`. It is off unless `ALANS_WAY_REMOTE_BRIDGE=1`, serves `/mcp` behind a bearer token, binds loopback or a private address, and allows at most 4 sessions. Its replies are plain JSON, so browser `commit` actions return `approval_unavailable`.

**Hermes's own path.** Hermes uses the same router as `mcp_servers.workspace_browser`, written by `agents:setup-workspace.sh:284-322`. It excludes `workspace_computer_action`, because desktop input goes through the provider instead.

**The VM-to-Mac key is a full shell.** It is limited only to the tailnet: `from="100.64.0.0/10,fd7a:115c:a1e0::/48"`, with no `command=` (`scripts/connect-mac.sh:73-127`). Anything on the VM that can use that key has a shell on the Mac as the user. That includes Hermes's terminal tool and any other agent running as the same VM user.

**Status of each target agent:**

| Agent | Status today | Evidence |
|---|---|---|
| **Hermes** | Full path: browser, computer, failover, proactivity, Telegram | Sections 1.2 to 1.4 |
| **Grok Bot** | Designed for, but not reachable: Grok's computer blocks outbound SSH, and the HTTP bridge "is still being finished" | `desktop/docs/remote-agents.md:22`; `docs/superpowers/specs/2026-10-25-grok-bot-remote-agent-design.md` |
| **Claude Duet** | **Exists.** It is an Anthropic research preview from 2026-10-21: a proactive agent on iOS, Android and claude.ai that runs in its own browser, US Pro/Max waitlist ([Introducing Claude Duet](https://claude.com/resources/articles/claude-duet), [Get started](https://support.claude.com/en/articles/17631495-get-started-with-claude-duet)). Whether it accepts custom MCP connectors is **UNVERIFIED**: I found no doc saying so. If it follows claude.ai connectors, they connect from Anthropic's cloud and need a publicly reachable HTTPS server ([remote MCP connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)). That clashes with this product's Tailscale-only rule (`README.md:19`). | |

**Claude Code and Codex** are no longer targets. If they ever become worth supporting, the cheapest route is a thin CLI wrapper. On the VM, or on any tailnet machine, it would run the same SSH stdio connector over Tailscale (`desktop/docs/remote-agent-connector.example.json`), with its own bot ID. Both are standard MCP clients, so they need no new server code. The client-side config is **UNVERIFIED**, from search snippets: Claude Code uses `claude mcp add` or `.mcp.json`; Codex uses `[mcp_servers.<name>]` in `~/.codex/config.toml`. Codex stays the speed and accuracy bar for feature 2 (`docs/agent-eval.md:3,62`).

### 1.6 Approval gate

There are four separate layers. Only one of them is enforced by the app.

| Layer | Where | Enforced? | Covers |
|---|---|---|---|
| **(a) Hermes `computer_use` approval** | Hermes core: Telegram buttons, skipped by `command_allowlist` keys `cua:<action>:background`, which `agents:setup.sh:2964-2990` writes when given `--allow-desktop-actions` | Inside the Hermes process (**UNVERIFIED** details, since Hermes core source is in neither repo) | Hermes desktop input only |
| **(b) Router opt-in** | `HERMES_WORKSPACE_ALLOW_DESKTOP_ACTIONS` hides or allows `workspace_computer_{launch,action}` (`agents:workspace-router.cjs:338-347,1118-1120,2957-2965`) | An environment variable | Every MCP client |
| **(c) App desktop dialog** | `desktop-approval.cjs:13-33`, wired at `main.cjs:2996-3007` | **Yes, in the app.** Deny / Allow / Always allow. The prompt waits 40 s; an Allow lasts until the bot has been idle 30 min; a Deny blocks new prompts for 60 s. | Launch and action, on every OS. Skipped for `prefs.bots` (all Telegram bots in the list), overseers and `desktopTrustedBots` (`main.cjs:2997`). |
| **(d) Browser commit gate** | MCP elicitation in the router (`router:2770-2845`). The app checks a receipt (`agent-input.cjs:22-33,596-629`). | Partly. I found no signature on the receipt, so a direct API caller can make one up (inferred, not tested). | Browser `commit` actions only |

**Known ways around the gate** (inferred from the code, not exercised):

- Any process with a shell on the Mac can read the token from `connection.json` and send a trusted bot ID, which skips (c).
- It can run the helper with an empty blocklist.
- It can make up a commit receipt.

The parity doc already says real gating belongs at the router/connector boundary, with the app validating it (`docs/remote-agent-cu-parity.md:87-91`).

### 1.7 Identity, soul and behavior files

**Persona.** `SOUL.md` and `agent.system_prompt` belong to Hermes and the user. The plugin never writes them (`agents:alans-way/voice.py:1-5`, `agents:docs/voice.md:14-16`). `migrate.sh` copies `SOUL.md`, `MEMORY.md` and `USER.md` (`agents:README.md:366-368`).

**Voice.** One hard-coded style (`voice.py:20-66`), switched per profile between `texting` and `default` via `/tone` (`voice.py:177-204`).

**Proactivity.** Per-bot `Settings` holds timezone, wait time, active hours, pause and morning brief, with levels less/normal/more (`agents:alans-way/proactivity.py:15-29`). Only the primary bot checks in (`__init__.py:146-147`). The model's own tool can only make check-ins quieter; widening them needs an operator command (`proactivity.py:130-153`).

**Ask-first vs act-then-report is not configurable.** The check-in prompt always offers three things: do one safe, reversible thing; offer something; or ask (`proactivity.py:427-432`).

**"Trusted tools" lives in four places:**

1. Hermes `command_allowlist` (`agents:setup.sh:2964-2988`).
2. The MCP `tools.exclude` list (`agents:setup-workspace.sh:296-297`).
3. The cross-bot read-only allowlist (`agents:alans-way/cross_bot.py:1673-1679`).
4. The app's `desktopTrustedBots` and overseer list (`main.cjs:184,2997`).

**Overseer variables disagree.** The app reads `HERMES_OVERSEER_BOTS` (`main.cjs:184`). The VM broker reads `HERMES_OVERSEER_BOT_IDS` (`vps-browser-host.cjs:74-79`).

**How a bot is identified differs by layer:**

- **App:** the Telegram user record and avatar (`telegram-preload.cjs:255-265`, `avatar-store.cjs:31-56`).
- **Plugin:** the Hermes profile name (`cross_bot.py:1208-1231`).
- **Non-Hermes agents:** an operator-chosen ID such as `grok`.
- **Colour:** every cursor uses the same hue, 152 (`agent-input.cjs:380-386`), although `desktop/README.md:65` says each bot gets its own colour.

### 1.8 Where the code is tied to Hermes

| Area | Coupling | Portable? |
|---|---|---|
| Plugin runtime | `ctx.register_hook` and its hooks, `register_tool`, `register_command`, `register_platform_handler("telegram")` (`agents:alans-way/__init__.py:117-193`) | Hermes-only |
| Idle check-ins | `ctx.inject_message(..., session_key=...)`, keys shaped like `agent:<ns>:telegram:dm:<id>`, starts when Telegram connects (`proactivity.py:230-240,329-403,576-617`) | Hermes and Telegram only. **This is the core proactivity dependency.** |
| Gateway internals | `gateway.session_context.get_session_env` (`proactivity.py:168-174`, `voice.py:153-158`), `gateway.profile_routes` (`cross_bot.py:36-46`), silence words such as `[SILENT]` (`cross_bot.py:49-59`) | Hermes-only |
| Computer provider | `register_computer_use_provider`, `tools.computer_use.backend` (`agents:alans-way-computer/__init__.py:3,28-34`) | Hermes-only |
| Skills | `SKILL.md` frontmatter with only `name` and `description`; the same layout Claude Code uses | **Format portable**, but the content names Hermes tools (`cronjob_manage`, `clarify`, `skill_view`) |
| Router and MCP | `--bot-id`/`--bot-name`, `X-Hermes-Bot`, `HERMES_WORKSPACE_*` | **Portable.** Only the names say Hermes. |
| Router install path | `~/.hermes/plugins/alans-way/scripts/workspace-router.cjs` (`remote-agents.md:26`) | Ties non-Hermes agents to a Hermes plugin install |
| App chat | Hermes `serve` and the TUI gateway protocol (`hermes-remote.cjs`, `hermes-hub.cjs`, `hermes-conversation.cjs`); Telegram embed | Hermes and Telegram only |
| App setup and updates | `hermes gateway setup` and the `alans-way-computer` check (`setup-check.cjs:12-154`), `hermes plugins update` (`vm-update.cjs:213-233`), profile marker files (`scripts/hermes-update.sh`) | Hermes-only |

### 1.9 Is Tailscale the backbone? Confirmed for our machines, challenged for vendor clouds

**Confirmed for every machine we own.**

- **Mac to VM.** Tailscale is required. Setup refuses public SSH addresses (`README.md:17-19`), and the VM key can log in to the Mac only from the tailnet (`scripts/connect-mac.sh:73-127`).
- **Everything that runs between them uses that link:** the router's SSH to the Mac, the app's SSH to the VM broker (`vps-browser.cjs:36-50,113-160`), the VM desktop preview, and the VM updater.
- **This is the right backbone.** There are no open ports, WireGuard keys are tied to devices, and NAT traversal comes free. It covers the Mac, the VM and the phone.

**Challenged for Grok Bot and Claude Duet.** Neither runs on a machine we own:

- **Grok Bot.** HTTP/SSE connectors run on xAI's backend, and stdio connectors run on the Bot's own cloud computer (`docs/superpowers/specs/2026-10-25-grok-bot-remote-agent-design.md:39`).
- **Claude Duet.** claude.ai connectors call from Anthropic's cloud (1.5), and Duet would presumably do the same (**UNVERIFIED**).
- **Neither side is on the tailnet.** Installing Tailscale on Grok's cloud computer is **UNVERIFIED** and fragile: xAI's docs say updates remove installed packages and idle computers hibernate (`design doc:18-20`).

**The reality on Alex's VM already breaks "Tailscale-only".** The Grok design connects to the VM's public SSH (`design doc:38,48`, "sshd on 0.0.0.0:22").

**Proposed rule:** Tailscale for everything between our own machines, plus **exactly one public HTTPS front door per VM** for vendor-cloud agents.

- **How:** **Tailscale Funnel** in front of `remote-agent-bridge.cjs`, which already binds loopback only (`remote-agents.md:15-18`). Tailscale stays the only thing listening on the network, and it supplies the TLS. The public sshd can then close. Funnel's current ports and limits are **UNVERIFIED** here; check Tailscale's docs before building on them.
- **Authentication:** bearer token today. OAuth is needed for Duet if it follows claude.ai connectors.
- **The app's approval gate stays the real check**, since the front door is public.

### 1.10 Fit against the 7 core features

| # | Feature | Today | Gap the proposal must close |
|---|---|---|---|
| 1 | Simple chat left, ChatGPT-style browser | Hermes chat exists twice: the Telegram embed and native Hermes chat (`hermes-hub.cjs`, `hermes-conversation.cjs`). The browser is Chromium tabs with cursor, take-over and hand-back (1.2). | **Grok Bot has no chat in the app.** No Grok thread API is known here (**UNVERIFIED**). The left pane needs a per-agent provider: Hermes native; Grok = open or deep-link the Grok Bot app until an API exists. The "feels like ChatGPT's browser" quality is a UI question and not assessed here. |
| 2 | Codex-level computer use, Mac + workspace browser, fast for remote agents | **Mac:** `computer_*` via the AX helper (1.4). **Workspace browser:** CDP-driven `cua_alans_way_*` (1.2). The app blocks native computer use on itself (`computer-policy.cjs:16-17`), so browser work always goes over CDP. An eval harness with a Codex baseline exists (`docs/agent-eval.md:3,62`). | **Keep CDP for the workspace browser.** It is the fast, accurate path; pixel computer use on our own window would be slower. **Remote latency is hop count.** Grok: xAI cloud → Funnel → bridge → router → SSH → Mac app. Keep each hop warm: one router per session already exists (`remote-agent-bridge.cjs:27-29`), and the router's SSH child is long-lived. Measure Grok's path with the same harness before claiming parity. Internal notes say Hermes's warm path beats Codex on Mac apps and the VM browser and ties on the Mac browser; **UNVERIFIED** here, as those results are not in this repo. |
| 3 | Lid-close handoff to the VM | Automatic failover in the router, with mirror restore (1.3). No fencing, no way back for VM tabs. | Lease plus fence (2.3). Grok sessions go through the same router, so they inherit failover once they can connect. |
| 4 | Live VM desktop window | Exists. The app embeds a noVNC viewer URL; Tart guests via `scripts/mac-vm-preview.sh` (`README.md:57,75`). | None. It is agent-agnostic already. The viewer URL should be a tailnet address (1.9). |
| 5 | Same threads on any device (Telegram or the agent's own app) | **Hermes:** Telegram is the thread. The full cloud/desktop continuity lifecycle is not implemented (`docs/continuity.md:5,17-27`). **Grok Bot:** its own Mac and iPhone apps own its threads. | **Don't copy threads.** Each agent's own app is the source of truth. The Workspace only shows or links them. For Hermes, finish the `continuity.md` gates. |
| 6 | Production agents, added tools only, no forks | **Hermes:** plugins + `mcp_servers` (no fork), but `alans-way-computer` uses a private Hermes function (`agents:alans-way-computer/__init__.py:91-133`). **Grok Bot:** custom connector + per-server custom instructions (`design doc:39`). | Replace the private-function use with a public Hermes API or an upstream request. Everything else already fits. |
| 7 | Proactivity | **Hermes:** idle check-ins via `ctx.inject_message` (`proactivity.py:329-403`). **Grok Bot and Duet:** both are proactive products of their own (Duet: [Introducing Claude Duet](https://claude.com/resources/articles/claude-duet); Grok Bot's scheduling is **UNVERIFIED**). | We cannot inject turns into Grok or Duet. For them the profile's `proactivity` becomes guidance only: connector custom instructions plus the `workspace_profile` tool. Only Hermes gets enforced check-ins. |

## 2. Proposed design

### 2.1 Desktop app scope

The layout is simple chat on the left and the browser on the right (feature 1). The app is also the approval surface for every agent and holds the VM window (feature 4). The chat pane is **one pane with a provider per agent**, not one universal protocol:

- **Hermes:** the existing native Hermes chat (`hermes-hub.cjs`, `hermes-conversation.cjs`), with Telegram as the cross-device thread. Collapse the Telegram embed and the native chat into one simple pane rather than keeping both visible.
- **Grok Bot:** threads live in the Grok Bot app (feature 5). Until xAI exposes a thread API (**UNVERIFIED**), the pane shows the agent's live activity from the MCP server (what it holds, recent actions, approvals waiting) and an "Open in Grok Bot" link. It does not show a copied transcript.
- **Duet, if adopted:** same as Grok Bot.

The activity view comes from the MCP server, so it works for any agent at no per-agent cost.

### 2.2 One MCP server

One package, `workspace-mcp` (today's `workspace-router.cjs` + `remote-agent-bridge.cjs` + `browser-mcp.cjs`):

- **Release.** Shipped with the app and installed on the VM by the app's VM updater (`vm-update.cjs`), not only as a Hermes plugin file. This takes the Hermes plugin catalog off the critical path for non-Hermes agents.
- **Legacy paths stay.** `~/.hermes/plugins/alans-way/scripts/workspace-router.cjs` and the inner `browser-mcp.cjs` remain as thin shims.

**Tool names.** Use underscores, not dots: `browser_*`, `computer_*`, `workspace_*`. The MCP spec allows dots (SEP-986), but some clients filter them ([Cursor forum](https://forum.cursor.com/t/cursor-incorrectly-filters-out-mcp-tool-names-containing-dots-and-hyphens-despite-being-valid-per-mcp-spec/157635)). The Anthropic and OpenAI function-name patterns have historically been `[a-zA-Z0-9_-]` (**UNVERIFIED** for today). Keep the old names as aliases for at least two releases, because Hermes `tools.exclude` lists and agent prompts refer to them (`agents:alans-way/__init__.py:58-80`).

| Group | Tools | Today |
|---|---|---|
| `browser_` | `status`, `tabs`, `open`, `snapshot`, `screenshot`, `action`, `close`, `recordings` | `cua_alans_way_*`, renamed |
| `computer_` | `apps`, `launch`, `snapshot`, `screenshot`, `menu`, `action` | `workspace_computer_*`, renamed |
| `workspace_` | `lease` (see 2.3), `profile` (read-only: the caller's own profile, so a non-Hermes agent can follow voice and proactivity), `handback` (tab to the human, with a reason) | New, except `handback`, which exists today inside `action` |

Which tools appear in `tools/list` comes from the caller's profile `tools` list (2.4), which replaces `HERMES_WORKSPACE_ALLOW_DESKTOP_ACTIONS` and `tools.exclude`.

### 2.3 Lease semantics

One lease per resource. The resources are `desktop:<host>` and `tab:<tabId>`.

```
workspace_lease {op: "acquire"|"renew"|"release"|"status", resource, ttl_s?}
 -> {holder, resource, host, fence, expires_at}
```

- **Owner.** The app keeps the lease table. Holders are keyed by the **authenticated** bot ID (2.5), never by a header.
- **TTL.** Default 20 s, which matches today's desktop lease (`computer.cjs:72-90`). An action renews it. `status` never takes it.
- **Fence.** `fence` is a number that only goes up for each resource across both hosts. It replaces the per-host epoch for writes. Every write carries the fence, and an older fence gets 409 `stale_fence`. This closes the split-brain case in 1.3, where the VM restores a tab while the Mac copy is still held by an agent.
- **Handoff.** This is a lease move, not a copy:
  1. On failover the router asks the VM broker for `tab:<id>` with `fence+1`.
  2. When the Mac comes back, it sees the higher fence and turns its copy to `handed_off` (the `core.cjs:296-300` behaviour that already exists). It does not keep serving it.
  3. Returning to the Mac is the same move in reverse, after a VM-to-Mac checkpoint, which does not exist today.
- **Humans first.** A human take-over always wins and bumps the fence (today's epoch rule, `main.cjs:881-916`).
- **Desktop lease on every OS.** Today only macOS has one (`main.cjs:2995`).
- **Automatic is the default.** Agents never have to call `workspace_lease`; `browser_action` and `computer_action` take and renew implicitly. The explicit tool is for long holds, for checking who holds what, and for handing a lease to another bot.

### 2.4 Profile schema (draft)

One file per bot in the app's user-data folder, `profiles/<bot-id>.yaml`, owned by the app (see risk R1 for why the app, not the VM):

```yaml
version: 1
id: grok                 # must match the authenticated identity (2.5)
name: Grok Bot
color: "#E8590C"         # fixes the single-hue cursor (agent-input.cjs:380-386)
kind: remote             # hermes | remote | overseer
voice:
  tone: texting          # texting | default  (maps to voice.py modes)
  style_note: ""         # appended to prompts; never overrides SOUL.md
proactivity:
  mode: ask_first        # ask_first | act_then_report | off
  level: normal          # less | normal | more (proactivity.py:15)
  active_hours: "08:00-22:00"
tools:                   # allow-list; absent = defaults below
  browser: [read, act]   # read | act | commit
  computer: [read]       # read | act | launch
approval:
  desktop_act: ask       # ask | session | always_allow | deny
  browser_commit: ask    # ask | deny  (never always_allow)
  surface: app           # app | agent  (agent = trust the agent's own prompt, Hermes only)
```

**Defaults when there is no file:**

- **Hermes bots in `prefs.bots`** get today's behaviour: computer `[read, act]` and `approval.surface: agent`. This is why the app dialog is skipped for them today.
- **Everyone else** gets browser `[read, act]`, computer `[read]` and `desktop_act: ask`.

**Rules:**

- **Widening needs the human.** Any change that widens trust needs a human click in the app: adding `computer: act`, `always_allow`, or `surface: agent`. An agent may only narrow its own profile. This is the same rule as `proactivity.py:130-153`.
- **Never trusted:** `browser_commit: always_allow`, any edit to the blocklist, and any `kind: overseer`. These stay hard-coded or can only be set in the UI.
- **Hermes stays the owner of persona.** `voice` and `proactivity` are read by the Hermes plugin as input. `SOUL.md` stays the user's (`voice.py:1-5`).

### 2.5 How the approval gate uses the profile

1. **Identity.** The bot ID comes from the credential, not from `X-Hermes-Bot`. On the Mac this means one SSH key per bot with `restrict,command="workspace-mcp --bot-id <id>"`, the same forced-command pattern `setup-remote-agent.sh` already uses on the VM, so sshd binds the ID. Grok Bot and Duet arrive through the VM's HTTP front door (1.9); there the bridge maps each bearer token to one bot ID and starts the router with it, so the ID is still bound before the Mac. The header is accepted only from the legacy shared token, behind a "legacy" flag that the app shows.
2. **Lookup.** At `main.cjs:2996-3007`, `trusted()` stops reading `prefs.bots`, `desktopTrustedBots` and overseers, and reads `profile.approval` instead. The current lists move into the profile defaults.
3. **Per action:** `tools` decides whether the action is allowed at all. `approval` then decides whether to prompt, and the lease decides whether the bot may act right now. A `deny` comes back to the client in plain words (the `remote-agents.md:84-92` error table already does this).
4. **Commit receipts** are signed by the app (HMAC with a key that never leaves the app process), and the app checks the signature. This fixes the forgeable receipt in 1.6(d).
5. **Blocklist.** The app keeps its own copy instead of trusting the one passed in `init` (`computer-helper.cjs:86-87`). The helper refuses to run without a policy hash the app signs.

## 3. Deleted, merged or kept, by module

| Module | Verdict | Notes |
|---|---|---|
| `desktop/scripts/browser-mcp.cjs` | **Merge** into `workspace-mcp` | Keep as a shim for one release |
| `agents:alans-way/scripts/workspace-router.cjs` | **Merge** (move to this repo) | The 3,323 lines of failover logic stay; tests move with them |
| `agents:alans-way/scripts/remote-agent-bridge.cjs` | **Merge** | Finishing it unblocks Grok Bot |
| `agents:alans-way-computer/` | **Keep, shrink** | Hermes's `computer_use` tool needs a provider; MCP alone cannot plug into it. Keep a thin adapter: element numbering, choice of pixels or text. Busy-retry and host tracking move into the lease. Delete it only if Hermes users accept `computer_*` MCP tools instead of native `computer_use` (open question). |
| `desktop/src/desktop-approval.cjs` | **Keep, extend** | Reads the profile instead of `trusted()` lists |
| `desktop/src/computer.cjs` lease | **Merge** into the lease table | Plus a desktop lease on Windows and Linux |
| `prefs.desktopTrustedBots`, overseer lists | **Delete after migration** | Become profile fields. One overseer variable instead of `HERMES_OVERSEER_BOTS` and `HERMES_OVERSEER_BOT_IDS`. |
| `HERMES_WORKSPACE_ALLOW_DESKTOP_ACTIONS`, `tools.exclude` | **Deprecate** | Replaced by profile `tools`; still honoured as a further limit |
| `agents:alans-way/voice.py`, `proactivity.py` | **Keep** (Hermes-only) | Read `voice` and `proactivity` from the profile; the constants become defaults. Check-ins need `ctx.inject_message`, and no other target exposes an equivalent we can call. |
| `agents:alans-way/cross_bot.py` | **Keep** | Its storage layer is portable; the Hermes hooks are not. Out of scope. |
| Skills (`agents:alans-way/skills/*`) | **Keep**; later split out a portable `workspace-operations` | The format is portable, the content is Hermes-heavy |
| Telegram embed, `hermes-hub`/`hermes-remote`/`hermes-conversation` | **Keep** | Hermes users' chat. Not generalised (2.1). |
| `cloud-*.cjs`, updaters, recorder, extensions | **Keep, untouched** | Not part of this change |
| `src/hermes_companion` (Python CLI) | **Keep** | Read-only file tools over SSH (`mac_server.py:150-197`). Not part of computer use. |

## 4. Risks

**R1. Security: a shell on the Mac beats every gate.**

- The VM-to-Mac key is a full shell limited only to the tailnet (`scripts/connect-mac.sh:73`). Any agent that can use it can read the token, edit `profiles/*.yaml`, edit prefs, or run the helper directly.
- Any local process running as the user can do the same.
- A profile file therefore only protects against agents **without** a shell on that computer.
- **Mitigations:** move the Mac key to a forced command (this breaks anything else that uses that key: setup, `mac_server.py` file tools; check those first), keep profiles in a folder only the app writes, and say the limit plainly in the docs.

**R2. Approval bypass through the profile.**

- `tools` and `always_allow` in a file are a new attack surface. A prompt-injected agent with file access could widen its own trust.
- **Mitigations:** the "widen only in the UI" rule (2.4), the app keeping a hash of the last approved profile and refusing edits made outside its UI, and no `always_allow` for `commit`, ever.

**R3. Lease races.**

- **Split brain on failover.** The VM restores a tab while the Mac copy is still agent-held: "unreachable from the VM" does not mean "Mac is off".
- **State loss.** Up to 10 s of page state can be lost from the mirror.
- **Rejected work.** Fences fix double writes, but valid work gets rejected after a late-arriving fence. That needs clear `stale_fence` recovery text.
- **Two agents on one tab.** A Hermes bot and Grok Bot can both hold `allowedBots` on one tab. The lease must be per tab, not per bot.

**R4. Regressions.**

- The router's failover logic is large and finely tuned (`router:1493-1748`, 3,050-3,275). Moving it between repos risks breaking its tests and its catalog pin.
- Renaming tools breaks Hermes `tools.exclude`, the prompt notes (`__init__.py:58-80`), the skills, and benchmark harnesses (`desktop/scripts/browser-bench.cjs`).
- The per-tab epoch already ships. The fence must sit beside it, not replace it, until clients are migrated.

**R5. Hermes users.**

- The plugin catalog re-pin is slow (days), so plugin-side changes land late.
- Hermes users must see no new prompts. Default Hermes profiles reproduce today's `prefs.bots` skip.
- Fresh installs must keep working with the plugin alone, without the app updater on the VM. Keep the plugin's copy of the router as a fallback until the app updater has installed `workspace-mcp` everywhere.

**R6. Target agents that may never connect.**

- **Grok Bot** needs the HTTP bridge, which is unfinished.
- **Claude Duet's** connector support is unknown. If it is like claude.ai, it needs a public HTTPS endpoint, which breaks the tailnet-only rule.
- **The public HTTPS front door** (1.9) is new exposure. It must stay one endpoint, authenticated, with the app's gate behind it.
- **Grok Bot's remote path has more hops than Hermes's** and may miss the speed bar for feature 2 until measured.
- **Mitigation:** don't sell "works with Grok Bot" until it passes the `docs/agent-eval.md` harness in phase 6.

## 5. Migration phases (backward compatible)

| Phase | Work | Compatibility |
|---|---|---|
| **P0 Decide** | Settle the open questions below. Decide on the conflict with `docs/continuity.md:14`. | Docs only |
| **P1 Identity** | Per-bot forced-command keys to the Mac; one bearer token per bot on the bridge; the app binds the bot ID from the credential. Unify the overseer variable. | The shared token and `X-Hermes-Bot` still work, flagged "legacy" in Settings |
| **P2 Profile v1** | Schema, loader, a Settings UI to edit it, the approval gate reads it, signed commit receipts, a policy copy held by the app. Migrate `prefs.bots`, `desktopTrustedBots` and overseers into generated profiles. | No file means today's behaviour |
| **P3 One MCP package** | `workspace-mcp` in this repo, combining router, bridge and connector; shipped by the app and VM updater; `browser_`/`computer_`/`workspace_` names plus old aliases; `tools/list` filtered by profile. | The old paths are shims; the plugin keeps its own router copy for one release |
| **P4 Lease and fence** | Lease table, `workspace_lease`, fence on writes, handoff as a lease move, desktop lease on Windows and Linux, VM-to-Mac checkpoint for going back. | The epoch is kept; the fence is optional until P6 |
| **P5 Behaviour from the profile** | The Hermes plugin reads `voice` and `proactivity` (adds act-then-report and ask-first variants of the check-in prompt). Non-Hermes agents get the `workspace_profile` tool and a short connector instruction. Shrink `alans-way-computer`. | Plugin default = current constants |
| **P6 Agents** | Finish the HTTP bridge and put it behind Tailscale Funnel; close the VM's public sshd. Connect Grok Bot and run the `docs/agent-eval.md` harness on its path against the Codex bar. Investigate Duet's connector support. Chat pane providers: Hermes native, Grok Bot activity plus deep link. Make the fence required and drop the old tool-name aliases two releases after P3. | Aliases removed only after a release note |

## 6. Effort estimate

"Agent-days" means one implementer agent plus review, with the existing test suites. The plugin catalog wait comes on top of these numbers.

| Phase | Size | Agent-days |
|---|---|---|
| P0 | S | 0.5 |
| P1 | M | 3-4 |
| P2 | M | 4-5 |
| P3 | L | 6-8 (moving the router and its tests, packaging, updater, aliases) |
| P4 | L | 5-7 (fencing and the reverse checkpoint are new) |
| P5 | M | 3-4 |
| P6 | M | 4-6 (bridge, Funnel, Grok eval, chat pane), plus the Duet investigation (unknown) |
| **Total** | | **≈26-35 agent-days**, about 6-8 calendar weeks with live-hardware checks |

P1 and P2 can ship alone and are worth doing even if P3 onward never happens.

## Recommendation

**Go-with-changes**, judged against the 7 core features:

- **Do now: P1 (identity) and P2 (profile plus approval).** They fix a real bypass today, where any holder of the token can claim a trusted bot ID. They are also the precondition for letting Grok Bot reach the Mac at all (features 2 and 6).
- **Then P3 and P4.** Most of "one MCP server" exists already, so this is a move and rename, not a rewrite. The lease with fencing is the genuinely new and risky part, and it is what makes feature 3 safe. Don't automate lid-close handoff any further without it.
- **Feature 1:** keep the simple chat pane with a provider per agent. It is Hermes native chat for Hermes, and activity plus a deep link for Grok Bot. Don't copy threads: feature 5 says each agent's own app owns them.
- **Feature 2:** keep CDP tools for the workspace browser and the AX helper for Mac apps, and measure Grok Bot's longer remote path with the existing eval harness before claiming Codex parity.
- **Feature 6:** keep `alans-way-computer` as a thin Hermes adapter, because Hermes's `computer_use` needs a provider, and replace its private-function use. Grok Bot stays a pure custom connector.
- **Feature 7:** proactivity is enforced for Hermes only. Grok Bot and Duet get the profile as guidance.
- **Tailscale:** confirmed as the backbone for every machine we own. Challenged for vendor-cloud agents, which need one Funnel'd HTTPS front door per VM. Close the VM's public sshd.
- **Tool names:** `browser_`/`computer_`/`workspace_`, not dots.
- **Claude Duet:** park it. It exists, but nothing shows it accepts custom MCP servers, and its proactivity duplicates Hermes's. Revisit if Anthropic documents connector support for Duet.
- **Claude Code and Codex:** dropped. If they are ever wanted, a thin CLI wrapper running the SSH connector over Tailscale costs no server work.

## Open questions for Alex

1. Is browser failover "host-specific work"? `docs/continuity.md:14` says host work never falls back to the VPS, and the router does exactly that for browser tabs. Feature 3 says it should, so `continuity.md` likely needs updating.
2. May the VM-to-Mac SSH key become a forced command? That is the cheapest strong fix for R1, but it removes the VM's general shell on the Mac. What else depends on that shell?
3. Do you accept one public HTTPS endpoint per VM, through Tailscale Funnel, for Grok Bot (and Duet)? Without it Grok Bot cannot connect: its outbound SSH is blocked, and xAI-side connectors are off-tailnet.
4. Should Hermes desktop input keep going through native `computer_use` (keep the adapter), or move to the `computer_*` MCP tools gated by the app (delete the plugin, lose Hermes's own approval prompts)?
5. Should the router move into this repo, released by the app's updater? That is faster than catalog pins, but it is a release-ownership change.
6. For Grok Bot in the left chat pane, is "activity plus Open in Grok Bot" enough, or must the actual Grok thread appear in the Workspace? The second needs an xAI thread API that I could not confirm.

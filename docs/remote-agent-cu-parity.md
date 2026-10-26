# Remote-agent computer-use parity

Audit date: 2026-10-25. Report only; no runtime changes or live desktop experiment.

## Sources and scope

Plugin anchors below use `plugin/` for `/Users/alex/alans-way-agents` at
`origin/release/plugin-0.21.10`, commit
`6dfac6c50ed5d9347414e42dc9ca5d8c4d1e5387`. All plugin source was read with
`git show`, not from the stale checkout. App anchors use repository-relative
paths at commit `666ec8bbee9b7fe8f3d9bc1bc57702aa121d034a`. Line ranges identify
the audited versions, not future edits. The requested design was read first:
`docs/superpowers/specs/2026-10-25-grok-bot-remote-agent-design.md` in the
`seapen` worktree. No private notes, installed app, Hermes profile, or remote
host was accessed.

Hermes's path is `computer_use` → provider → a private router child → the same
`browser-mcp.cjs` → app computer service/native helper. The provider reuses the
profile's router configuration and enables desktop input for its child;
it does not implement a second Mac driver. A plain MCP client gets the shared
path, provided the operator enables desktop input. Sources:
`plugin/alans-way-computer/__init__.py:81-116`,
`plugin/alans-way-computer/__init__.py:176-207`,
`desktop/scripts/browser-mcp.cjs:6-14`,
`desktop/scripts/browser-mcp.cjs:411-448`, `desktop/src/computer.cjs:94`.

## Gaps ranked by impact

The ranking is an engineering assessment of correctness and avoided round
trips, not a measured model-speed comparison. Detailed evidence and the
smallest proposed remedy follow each rank.

| Rank | Difference | Speed / success impact | Smallest proposed remedy |
| --- | --- | --- | --- |
| 1 | Hermes has an approval gate above desktop input; raw MCP desktop opt-in does not. | Critical safety difference; disabled input prevents task completion. | Keep desktop opt-in explicit; require client approval integration or add a shared approval gate before claiming safety parity. See §1. |
| 2 | Provider binds native actions to the observed host and clears stale app/window state. | High success: prevents an old Mac PID becoming input on the VM. | Publish the existing `expect_host` field in MCP schemas; instruct clients to retain it with their target. See §2. |
| 3 | Skill tells the model to consume the returned state, batch short sequences, and avoid redundant reads. | High speed: fewer model/tool round trips. | Short generic connector instructions; keep existing shared observations and batching. See §3. |
| 4 | Provider maintains a validated element cache and formats compact action changes. | High success, medium speed: fewer stale targets and repeated trees. | Raw clients use refs/generations directly; document delta merging and recovery. Shared structured guidance can replace prose supplied only by the provider. See §4. |
| 5 | Provider automatically decides when pixels are necessary and translates coordinates. | Medium speed/success: saves image calls/tokens and avoids scaled-coordinate misses. | Keep existing image delivery; document geometry and text-first use. Optional capture convenience belongs in the shared connector. See §5. |
| 6 | Provider adds read recovery and actionable error messages over shared timeouts. | Medium success: avoids replaying uncertain writes; handles child restarts. | Client timeout/reconnect settings plus a short read-once recovery instruction; preserve shared budgets. See §6. |
| 7 | Provider offers app-name resolution, foreground convenience, and a Save-dialog guard. | Medium success, low-to-medium speed. | Document launch/activate and native dialog shortcuts; move the Save-name validation into the shared service if enforced parity is required. See §7. |
| 8 | Some exposed descriptions still assume Hermes. | Medium success: a raw client may look for nonexistent tools or mishandle images. | Make descriptions conditional/client-neutral in the router and `browser-mcp.cjs`. See §8. |

### 1. Separate desktop permission from browser approval

The router hides **both launch and action** and refuses direct calls unless
`HERMES_WORKSPACE_ALLOW_DESKTOP_ACTIONS` is enabled. The provider sets that
environment variable for its private child because Hermes's `computer_use`
approval gate sits above it. The provider's `permission_mode` does not itself
enforce an approval policy. Thus raw desktop input with opt-in is functional
parity, not Hermes approval parity. Sources:
`plugin/alans-way/scripts/workspace-router.cjs:338-347`,
`plugin/alans-way/scripts/workspace-router.cjs:2954-2961`,
`plugin/alans-way-computer/__init__.py:186-190`,
`plugin/alans-way-computer/__init__.py:287-290`,
`plugin/alans-way-computer/README.md:49-67`.

Browser approval is already generic: the router gates `cua_alans_way_open`
and `cua_alans_way_action`, adds `commit` to their advertised schemas, and
uses MCP `elicitation/create`. A client must advertise form elicitation and
implement the human interaction; otherwise consequential operations return
`approval_unavailable`. Approval is bound to the observed document/targets;
the connector requires positive `approval-binding-v1` capability. Sources:
`plugin/alans-way/scripts/workspace-router.cjs:1007-1028`,
`plugin/alans-way/scripts/workspace-router.cjs:2469-2477`,
`plugin/alans-way/scripts/workspace-router.cjs:2639-2669`,
`plugin/alans-way/scripts/workspace-router.cjs:2731-2794`,
`desktop/scripts/browser-mcp.cjs:451-457`.

**Recommendation:** retain Hermes's user settings and UI in Hermes. For other
clients, document desktop opt-in and configure equivalent client approval
support. For an enforced gate available to every MCP client, add it at the
shared router/connector boundary, with the app validating the resulting
authorization; instruction text alone cannot supply enforcement. Do not
describe the browser `commit` gate as also protecting native app input:
`GATED_TOOLS` contains only the two browser tools
(`plugin/alans-way/scripts/workspace-router.cjs:1007`,
`desktop/src/main.cjs:3073-3090`).

### 2. Host failover is shared; native target invalidation is extra

The router already supplies host metadata, Mac-first routing, explicit VM
browser routing, browser mirror continuation, and no replay of sent writes.
It also fills current browser tab/epoch defaults for all clients. None is
Hermes-only. Sources:
`plugin/alans-way/scripts/workspace-router.cjs:1093-1121`,
`plugin/alans-way/scripts/workspace-router.cjs:1550-1583`,
`plugin/alans-way/scripts/workspace-router.cjs:1629-1655`,
`plugin/alans-way/scripts/workspace-router.cjs:2250-2273`,
`plugin/alans-way/scripts/workspace-router.cjs:2970-3000`.

The provider additionally tracks serving host, PID, selected window, tree and
screenshot geometry. A changed host resets that state; capture can re-resolve
an app name once, and actions carry `expect_host` before dispatch. The router
refuses a mismatch before input. This matters because browser tab migration
cannot migrate a native Mac app or make its PID meaningful on the VM. Sources:
`plugin/alans-way-computer/__init__.py:294-309`,
`plugin/alans-way-computer/__init__.py:387-410`,
`plugin/alans-way-computer/__init__.py:628-660`,
`plugin/alans-way/scripts/workspace-router.cjs:2980-2989`,
`plugin/alans-way/skills/workspace-operations/SKILL.md:320-323`.

**Recommendation:** add `expect_host: "computer" | "vm"` to launch/action
schemas in `browser-mcp.cjs` and teach clients to send the host of the observation
they used. The router already checks it, but neither schema advertises it and
the schemas disallow extra properties; prompt text cannot reliably enable
this protection today. For automatic protection without model bookkeeping,
bind native observations/actions in the router to their serving host and
reject drift. Cross-host binding needs router context, not just a Mac app
change. Current schema evidence:
`desktop/scripts/browser-mcp.cjs:51`,
`desktop/scripts/browser-mcp.cjs:101`,
`desktop/scripts/browser-mcp.cjs:113-134`.

The practical host instruction is already in the skill: omit browser `host`
normally; use VM only when requested or unavailable; login, CAPTCHA, approval
and uncertain outcomes are not outages. After a host change, reacquire apps
and controls; a Mac-only file/app task may need to wait. Source:
`plugin/alans-way/skills/workspace-operations/SKILL.md:179-200`,
`plugin/alans-way/skills/workspace-operations/SKILL.md:320-323`,
`plugin/alans-way/skills/workspace-operations/SKILL.md:558-561`.

### 3. Batching and post-action observation already reach every client

Native actions support up to 25 steps, stop at the first failure, and support
text waits within a 45-second step-start budget. The Mac helper settles after
successful input and reads the resulting tree; it preserves completed steps
if observation fails. The shared service emits full, changed/removed, or
unchanged state relative to the caller's generation. Sources:
`desktop/src/computer-helper.cjs:10-18`,
`desktop/src/computer-helper.cjs:299-381`,
`desktop/scripts/mac-computer.swift:1512-1559`,
`desktop/src/computer-snapshot.cjs:26-40`.

The provider has no general batch method here. Its special extra batch is
`activate` followed by input for foreground delivery. A raw client can already
express that same sequence. Source:
`plugin/alans-way-computer/__init__.py:628-646`;
shared schema: `desktop/scripts/browser-mcp.cjs:105-133`.

Browser batches likewise run up to 25 steps and return one final effect plus
per-step results. The effect includes bounded new visible text, changed
controls and optional input value/focus; missing observation is reported as
an error, not proof of success. `open(snapshot:true)` can include the first
observation. Sources: `desktop/src/main.cjs:2726-2785`,
`desktop/src/browser-page.cjs:1095-1169`,
`desktop/scripts/browser-mcp.cjs:378-406`.

**Actual gap:** the skill strongly tells Hermes to skip status/tabs during
working calls, use action effects rather than confirmatory snapshots, batch
short chunks, wait for necessary readiness, and read only when the effect
lacks the required text. Much of this is already in tool descriptions, but
loading the skill reinforces the strategy. Sources:
`plugin/alans-way/skills/workspace-operations/SKILL.md:216-221`,
`plugin/alans-way/skills/workspace-operations/SKILL.md:342-378`,
`plugin/alans-way/skills/workspace-operations/SKILL.md:532-559`,
`desktop/scripts/browser-mcp.cjs:105-111`,
`desktop/scripts/browser-mcp.cjs:135-150`.

**Recommendation:** connector instructions should say “act, consume the reply;
add one wait/read only if needed.” Do not unconditionally append another
snapshot after every action, or a browser `read` step to a desktop batch
(desktop supports `wait`, not browser `read`). Existing implementation already
provides the observation needed for this strategy
(`desktop/src/computer-helper.cjs:252-279`,
`desktop/src/main.cjs:2759-2785`).

### 4. Provider cache and concise results are an adapter benefit

The provider asks for delta captures, validates them, falls back to a full
capture if the baseline/window is inconsistent, and maps raw refs to stock
`computer_use` element numbers. On Mac/Windows it merges changes without
renumbering surviving elements; removed elements leave empty slots. It lists
up to 12 changed entries and marks an effect confirmed only for changes at
or near the target. Linux refs are positional, so it describes differences
and asks for another capture before numbered input. Sources:
`plugin/alans-way-computer/__init__.py:67-75`,
`plugin/alans-way-computer/__init__.py:437-468`,
`plugin/alans-way-computer/__init__.py:523-528`,
`plugin/alans-way-computer/__init__.py:576-626`,
`plugin/alans-way-computer/__init__.py:672-691`,
`plugin/alans-way-computer/__init__.py:810-827`,
`plugin/alans-way-computer/__init__.py:886-894`.

Raw MCP clients already receive native refs, generations, window IDs, delta
opt-in and per-bot baseline checks. They do not need Hermes's numeric adapter
to act. The shared service also inherits the window observed by that bot.
Sources: `desktop/scripts/browser-mcp.cjs:102-116`,
`desktop/src/computer-snapshot.cjs:11-42`,
`desktop/src/computer-helper.cjs:326-337`,
`desktop/src/computer-helper.cjs:395`.

**Recommendation:** keep Hermes element numbers and `ActionResult` formatting
in the provider. Generic clients should retain refs/generation/windowId, merge
`changed`/`removed`, and request a full snapshot if their baseline is lost.
They can use full snapshots instead of implementing a cache, at a token cost.
If stronger guidance is needed for every client, attach a short structured
next-step note to shared replies; do not copy the numeric-index layer.
The existing shared schema already documents the raw contract
(`desktop/scripts/browser-mcp.cjs:102`,
`desktop/scripts/browser-mcp.cjs:111-116`).

### 5. Screenshot delivery is shared; capture selection/scaling is extra

Both screenshot tools return MCP `type:"image"` content plus geometry text.
The router preserves image content, adding host metadata and notices; its
large-image fast path avoids parsing/re-serializing base64. There is no missing
image transport to add for other MCP clients. Sources:
`desktop/scripts/browser-mcp.cjs:394-406`,
`desktop/scripts/browser-mcp.cjs:425-437`,
`plugin/alans-way/scripts/workspace-router.cjs:1093-1121`,
`plugin/alans-way/scripts/workspace-router.cjs:1125-1147`.

The provider's default `som` capture attaches pixels only when named controls
cover less than 35% of the window, or coverage cannot be established. `ax`
omits pixels; `vision` requests them. It converts screenshot coordinates back
to screen coordinates and rescales element bounds for the stock interface.
This is automatic convenience/less image traffic, not an extra image source.
Sources: `plugin/alans-way-computer/__init__.py:74`,
`plugin/alans-way-computer/__init__.py:469-520`,
`plugin/alans-way-computer/__init__.py:530-542`.

**Recommendation:** retain raw text-first calls and the geometry formula already
documented in `desktop/scripts/browser-mcp.cjs:103`, and state that images are
attached MCP content. A client must support image content for pixel work;
instructions cannot create that capability. Only add a shared snapshot+image
convenience option if automatic selection is actually needed. Do not force
screenshots into action replies. Browser crops use viewport CSS coordinates,
whereas native clicks use screen points; follow each tool's returned mapping
(`desktop/scripts/browser-mcp.cjs:401-406`,
`desktop/scripts/browser-mcp.cjs:429-435`).

### 6. Budgets, retries and recovery

The provider uses 30 seconds for initialization and 110 seconds per call. It
kills a silent child, restarts on a later call, retries `list_apps` once after
transport death and allows one capture retry; actions do not opt into replay.
It appends recovery advice for stale refs/windows, active human input, lock,
permissions, timeout and unresponsive apps. Sources:
`plugin/alans-way-computer/__init__.py:36-65`,
`plugin/alans-way-computer/__init__.py:209-247`,
`plugin/alans-way-computer/__init__.py:325-342`,
`plugin/alans-way-computer/__init__.py:387-403`,
`plugin/alans-way-computer/__init__.py:646-656`.

Shared protections already include router soft/hard limits of 45/80 seconds
(batch 60/100), decreasing remaining budgets, and replay limited to reads or
never-sent requests. Connector action HTTP calls cap at 90 seconds; computer
reads have a 75-second budget. Helpers use 20-second requests, persistent
processes, a one-shot fallback after failed startup, and one brief retry for
an app not found just after launch. A lost action from an established helper
is not repeated. Sources:
`plugin/alans-way/scripts/workspace-router.cjs:1482-1500`,
`plugin/alans-way/scripts/workspace-router.cjs:1565-1575`,
`plugin/alans-way/scripts/workspace-router.cjs:1759-1774`,
`desktop/scripts/browser-mcp.cjs:195-224`,
`desktop/src/call-budget.cjs:6`,
`desktop/src/computer-helper.cjs:10-18`,
`desktop/src/computer-helper.cjs:131-163`.

**Recommendation:** configure the MCP client's timeout to leave room for router
results (Hermes's setup uses 120 seconds), reconnect after a normal connector
exit, retry a failed read once, and inspect current state before deciding
whether to repeat input. Do not add blind action retries in `browser-mcp.cjs`.
Hermes's session/child management can stay Hermes-specific; generic recovery
belongs in connector instructions. Timeout/reload evidence:
`plugin/alans-way/scripts/workspace-router.cjs:1483-1488`,
`desktop/scripts/browser-mcp.cjs:28-33`,
`plugin/alans-way/skills/workspace-operations/SKILL.md:258-279`.

No `desktop_busy` wait/retry loop exists in this audited provider: its action
call is a single dispatch with error handling, and its known-code set has no
`desktop_busy`. The current app computer handlers likewise dispatch without
a desktop lease. A lease and bounded busy retry are design work, not an
existing Hermes advantage. Sources:
`plugin/alans-way-computer/__init__.py:46-65`,
`plugin/alans-way-computer/__init__.py:628-691`,
`desktop/src/main.cjs:3063-3091`.

### 7. Native front policy is shared; provider adds convenience and advice

Mac frontmost reads are allowed; input in the front app and explicit activation
require at least two seconds without human input. The helper distinguishes
its own posted events from human events and checks policy per action step.
Locked screens, blocked apps, secure fields and unverified focus are host
boundaries, not provider privileges. Sources:
`desktop/scripts/mac-computer.swift:52-85`,
`desktop/scripts/mac-computer.swift:761-794`,
`desktop/scripts/mac-computer.swift:1533-1541`,
`desktop/src/computer-policy.cjs:3-44`.

The provider resolves an app name against `apps`, launches a missing name only
when advertised, can open an absolute document path, and translates foreground
delivery into `activate` + action. Raw tools already expose launch/path/menu
and activation. The extra provider Save-dialog check rejects a folder path in
a name field recognized by `Save As:`/`Where:`; the skill supplies the
`cmd+shift+g` → folder → bare filename sequence and final saved-path check.
Sources: `plugin/alans-way-computer/__init__.py:348-375`,
`plugin/alans-way-computer/__init__.py:639-641`,
`plugin/alans-way-computer/__init__.py:746-807`,
`desktop/scripts/browser-mcp.cjs:101-108`,
`plugin/alans-way/skills/workspace-operations/SKILL.md:238-252`.

**Recommendation:** use app PID/refs directly, launch only if needed, activate
the intended window when focus/Space/minimization requires it, then snapshot.
For `in_front`, wait briefly and retry once; do not request permission to read
the front app. Keep lock/off-limits refusals. Include dialog advice in connector
instructions; move the Save-name validation into the shared service if it must
protect all clients. The provider's convenience names can stay Hermes-only;
the native checks must remain shared. Advice source:
`plugin/alans-way-computer/__init__.py:54-65`.

### 8. Fix misleading client-facing wording

The browser screenshot description says “Hermes delivers it as MEDIA:<path>”
even though the implementation returns an MCP image. The router also appends
“Native input uses the stock computer_use tool” to desktop read descriptions
even when raw desktop input was enabled. The full skill explicitly tells a
Hermes without `computer_use` to stop instead of using raw native input; that
is correct for Hermes's gate, not generic connector guidance. Sources:
`desktop/scripts/browser-mcp.cjs:98`,
`desktop/scripts/browser-mcp.cjs:405-406`,
`plugin/alans-way/scripts/workspace-router.cjs:892-898`,
`plugin/alans-way/skills/workspace-operations/SKILL.md:544-565`.

**Recommendation:** change the screenshot description to “returns an attached
MCP image plus coordinate metadata.” Make the router's desktop guidance
conditional on opt-in: enabled clients use `workspace_computer_action`;
Hermes's default connector continues to direct input through `computer_use`.
Distribute the short text below rather than the entire Hermes skill. Deferred
tool names, `tool_call`, provider registration and Telegram delivery stay
Hermes-only because they are client APIs/UI, not computer capabilities
(`plugin/alans-way/skills/workspace-operations/SKILL.md:202-214`,
`plugin/alans-way/skills/workspace-operations/SKILL.md:454-458`,
`plugin/alans-way-computer/__init__.py:912-951`).

## Verification and limits

Only local fixture/unit suites were run. The selected desktop command was
`node --test test/browser-mcp.test.cjs test/computer-helper.test.cjs test/computer-policy.test.cjs test/computer-snapshot.test.cjs test/approval-binding-mcp.test.cjs test/screenshot-crop.test.cjs`
from `desktop/`: **228 passed, 0 failed, exit 0**. The initial run failed on
missing MCP dependencies; `npm ci --ignore-scripts --no-audit --no-fund`
installed the lockfile dependencies, and the final run above passed.

Plugin tests ran from a temporary source copy populated with `git show` at
the audited release, with no changes to the plugin checkout:

- `python3 -m unittest discover -s tests -p 'test_computer_provider.py'`:
  **50 passed, 42 skipped, exit 0** (92 discovered; skips require a separate
  Hermes checkout/interpreter).
- `python3 -m unittest discover -s tests -p 'test_workspace_operations_skill.py'`:
  **64 passed, exit 0**. Its first attempt lacked the extracted
  `setup-workspace.sh` fixture; extracting that file resolved it.
- `node --test tests/router-framing.test.cjs tests/router-reply-projection.test.cjs tests/router-replay.test.cjs tests/router-lifecycle.test.cjs tests/router-notice-efficiency.test.cjs`:
  **132 passed, 7 skipped, exit 0** (139 discovered; skips require a configured
  frozen real connector).

No full desktop suite, installed Hermes integration, live Mac/VM failover,
third-party client image/elicitation compatibility, or A/B speed benchmark was
run. The recommendations are unimplemented; custom instructions improve
tool use but do not add desktop approval, host-binding schemas, or leases.

## Ready-to-paste custom instructions

Use with desktop input explicitly enabled by the operator and a client that
supports MCP images and form elicitation. This text describes the current raw
tools, without depending on Hermes-only tool names. Basis:
`desktop/scripts/browser-mcp.cjs:100-150`,
`plugin/alans-way/skills/workspace-operations/SKILL.md:191-221`,
`plugin/alans-way/skills/workspace-operations/SKILL.md:238-267`,
`plugin/alans-way/skills/workspace-operations/SKILL.md:342-378`.

```text
Use Alan's Workspace: cua_alans_way_* for websites; workspace_computer_* for native apps. Omit browser host normally; use VM only if requested or reported unavailable. Skip status/tabs during working calls. Open with snapshot:true. Act from current refs; keep generation and windowId for native actions. Reuse action effects and changed/removed/unchanged state; don't reread what the reply already shows. Batch short known sequences; add wait for readiness and read only for missing browser text. Inspect every step's errors. Use text/controls first; screenshots are attached MCP images. Map image pixels with returned geometry. Native: apps -> snapshot(pid) -> action; type with a ref replaces text. Activate if focus/Space requires it, then snapshot. In Save dialogs use cmd+shift+g for folders, then a bare filename. On in_front wait briefly, retry once. Retry a failed read once; never blindly repeat uncertain input. After host/stale-state changes reacquire apps/controls. Honor approvals, human holds, lock and off-limits errors; release login/CAPTCHA to the user. Use commit for consequential browser actions; never invent approval or bypass a refusal.
```

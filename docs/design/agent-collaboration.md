# Hermes and Grok Bot in one Workspace room

Status: proposed, with an offline prototype. Updated: 2026-10-29.

Recommend an **opt-in, session-scoped Workspace room** for Alex, Hermes and Grok Bot. Alan's Workspace renders it as another conversation in the left chat pane; Alan's CU MCP owns the proposed VM authority (`workspace-mcp`) that admits room turns. Alan's Plugin for Hermes and Alan's Plugin for Grok Bot adapt their respective provider-owned threads and runtimes. A leading Alex `@mention` selects one bot, and that bot can explicitly hand the task to its peer. Six bot turns share one budget. Pause cancels pending room turns; Resume requires a new Alex instruction.

This is a design and simulation, not a connected chat integration. No production connector, credential, app preference, public listener or desktop driver changes. Live collaboration remains gated on authenticated identity, supported provider delivery and safe VM input arbitration.

## Four products and their boundaries

All four first-party products are **MIT-licensed**. The product split does not change third-party licenses or establish the licensing/self-hosting terms of a proposed OpenPod service. The two plugins and canonical shared config contract live in `capthvnsen/alans-way-agents`; Workspace and CU MCP live in this repository. This patch changes neither repository's licensing or plugin implementation.

| Product | Owns in this design | Boundary |
| --- | --- | --- |
| **Alan's Workspace** | Electron desktop and iOS app; shared room presentation, owner membership/content-sharing consent, leading-mention composer, Pause/Resume, VM viewer and handoff controls; main-process/native projection of CU MCP state | Desktop and iOS are clients of the same authority, not independent room schedulers. VM handoff changes the selected execution host/viewer, not the task's author, budget or permissions. iOS room UI is proposed, not implemented by the browser prototype. |
| **Alan's CU MCP** | Shared computer-use MCP server both bots use; authenticated principal registry, room admission/sequence, six-turn budget, deadlines, delivery ledger, Pause/supersede fencing, approvals and existing host-scoped desktop lease | One authority for the VM across both plugins and all Workspace clients. No provider model runtime, private transcript database or proactive scheduler. Room tools are an additive proposal alongside CU tools. |
| **Alan's Plugin for Hermes** | Shared-config reader, Hermes persona/text voice and native proactivity mapping; exact gateway/profile/thread binding, bounded room context and Hermes delivery/cancellation adapter | Hermes keeps its runtime, session and native scheduling. The plugin cannot mint owner instructions, bypass room admission or acquire a separate desktop lock. |
| **Alan's Plugin for Grok Bot** | Shared-config-to-skill/settings generator, operator-applied native preferences/routines, exact Bot/conversation binding and proposed Grok room delivery/cancellation adapter | Generated settings are a handoff format, not a native importer or verified wake connector. Grok keeps its runtime and native scheduling; the same CU MCP policy applies. |

**Tailscale is the backbone transport.** Workspace desktop/iOS, the VM authority and plugin-side CU connections use private tailnet reachability; #241's restricted OpenSSH stdio route is the proposed bot entry point. Tailnet policy and credential-bound principals both matter. No public listener, public port or Tailscale Funnel is part of this design. An optional OpenPod delivery leg cannot become a public CU ingress or replace tailnet authentication.

Workspace sends authenticated owner commands to CU MCP; CU MCP grants a turn to one plugin adapter; that adapter wakes its exact provider thread and returns an explicit post/handoff. Both plugins route computer actions to the same CU MCP authority and lease for the selected host. Provider outages, a phone reconnect or a VM handoff never create another authority. Cross-host continuation needs an explicit owner choice, validation of the new host grant and fresh observations; no lease or in-flight effect migrates with the viewer.

## One shared preference config

Read agents [#157][agents-config] at `88202315a5446e24cb33cb2e7299b4471f1d7931` and [#158][agents-runtime] at `3b4c7ee14f265ea5dc2240059af51957cdb601a2`; both were open when read. #157 defines the draft v1 contract; #158 adds the reader/generator and precedence below. These are reviewed proposals, not a claim that either is installed or merged. The [canonical schema][config-schema] and [consumer contract][config-consumers] stay in the agents repository; do not fork them into Workspace or CU MCP.

Both plugins consume **one source of preferences: `~/.config/alans-way/config.json`**, independent of the working directory and Hermes profile. Hermes reads it at plugin load; Grok's generator reads the same file and emits `SKILL.md` plus `settings.json` snapshots. Generated artifacts are derived output, not a second editable preference source. Reload Hermes and regenerate/reapply Grok output after edits; this is not live synchronization. Separate runtime hosts need an explicitly managed copy of the same source; Tailscale connectivity does not synchronize files. Workspace may eventually expose a validated editor/status view, but no editor, replication service or per-bot config is introduced here.

Every v1 field is required; unknown fields are rejected at every object level:

| Shared field | Hermes mapping in #158 | Grok Bot mapping in #158 |
| --- | --- | --- |
| `schema_version` | Integer `1`; validate before plugin registration | Same validator runs before generation |
| `identity.name`, `identity.role`; `persona.description` | Preference context on every profile/surface; no rewrite of local persona files | Generated `persona.name`, `.role`, `.description` and skill preference context |
| `voice.tone`; `voice.reply_length` (`short`, `balanced`, `detailed`) | Shared text voice on chat surfaces with `/tone texting`; `/tone default` disables voice override; pacing stays local | Generated `voice` plus skill instructions; requested work stays complete |
| `proactivity.enabled` | `false` blocks unsolicited check-ins, briefs and reports; `true` retains local pauses and needs an existing route binding | `false` generates no routines; `true` generates one proposed idle check-in schedule/prompt, installed/updated only on operator request |
| `proactivity.timezone`, `.idle_minutes`, `.active_hours.start`, `.active_hours.end` | Real IANA timezone, positive integer quiet minimum, exact same-day `HH:MM` window (start inclusive, end exclusive); native backoff can delay further | Same timezone/window/quiet minimum in the prompt; generated cadence is `max(5, idle_minutes)` minutes; skip if time, owning conversation or recent activity cannot be verified |

“Voice” here means **text reply style**, not a speech/TTS provider or audio voice ID. V1 has no per-bot identities, routing keys, room budgets, tool credentials or speech fields. Keep stable **Hermes** / **Grok Bot** badges even if both share the display name “Alan”; `identity` never selects an authenticated principal, bot route, room author or provider session.

Use #158's UTF-8 JSON validation, including unique keys, finite numbers, schema version, timezone existence and `start < end` on the same day. Missing config preserves Hermes defaults; generation requires a config. Malformed/unsupported config fails before applying preferences or replacing generated output, with diagnostics that omit preference values. Shared preferences never overwrite local profile state; shared schedule edits belong in this file, while route bindings, pauses and native backoff remain local. No overnight/all-day window or partial merge is defined in v1.

Proactivity is a preference for **provider-native** check-ins, not permission to join/start a room or hand off work. An enabled routine may not mint a root task, reset six turns, wake the peer from prose, resume a paused room or grant desktop access. Room participation still requires an addressed owner instruction or an admitted explicit handoff. Disabling unsolicited check-ins does not disable replies to those instructions. Room Pause fences room grants independently of native routine pauses; it must not claim to pause unrelated private conversations. Grok's prompt-based quiet checks and native routine installation remain unverified; do not treat generated settings as enforced activity observation.

## Baseline read before designing

The initial design baseline was `alans-way@5d10e818a425b32a794d54de6a5866f3ff1e50e0`, with no `docs/architecture` directory. It read the proposed architecture from [#241 at 5ea0ea7][architecture], plus [#243][identity] at `faf5c2ccb2a10b1472262b6ffc8492a948d04828` and [#252][lease] at `f87d76159ad741f54f1ea4478d80829ba2388c12`. All three were open drafts when read; none is assumed deployed.

| Existing or proposed seam | What collaboration must preserve |
| --- | --- |
| #241: VM `workspace-mcp`, restricted OpenSSH stdio over Tailscale | Alan's CU MCP is the one authority; both bots enter through their respective plugins/adapters. No public HTTP fallback. Tailscale device reachability alone is not per-bot authentication. |
| #241: provider-owned conversations, no transcript database or second scheduler | Room posts are deliberate shared messages, not mirrored private histories. Keep provider session IDs separate; no provider runtime or scheduler in Workspace. |
| #243: `X-Hermes-Bot` required on computer routes | Missing or oversized identity refuses before approvals/lease/driver. This remains a cooperative header under a shared app token, **not** credential-bound per-bot authentication. |
| #252: `createFileDesktopLease` for independent VM connectors | Keep the shared lease and its `desktop_busy` response; do not introduce a room-specific competing desktop lock. Its read-then-write race and fail-open file errors do **not** establish safe simultaneous input. |
| `desktop/src/hermes-hub.cjs`, `hermes-conversation.cjs`, `hermes-view.js` | Main process owns connections and exact gateway/session identity; renderer receives bounded display state. Do not map a Grok label onto a Hermes session or send room posts to the currently selected private thread. |
| `desktop/src/computer.cjs`, `desktop/scripts/browser-mcp.cjs` | Existing approvals, identity, 20-second idle lease, current snapshot/host/ref checks and call budgets still apply. Reads do not take an input lease. |

The older [remote-agent design](../superpowers/specs/2026-10-25-grok-bot-remote-agent-design.md) and [remote-agents guide](../../desktop/docs/remote-agents.md) describe a blocked SSH route and HTTP bridge. #241 supersedes that premise with Alex's reported Grok Tailscale tool discovery. This work does not independently verify current Grok connectivity, supported thread embedding or bot wake APIs.

## Options

| Option | Benefit | Cost / limitation | Decision |
| --- | --- | --- | --- |
| Separate provider chats; Alex copies requests/results | Already works where the provider chat works; no new authority | No shared conversation, explicit handoff state or common pause | Keep as fallback |
| Telegram group as the shared room | Existing Telegram pane and Hermes delivery | Grok participation and bot-to-bot delivery are unverified; adds a transport dependency and group visibility concerns | Do not make the MVP depend on it |
| Workspace room with small provider adapters | Common attribution, mentions, bounded handoff, visible pause; reuses private VM authority | Requires supported provider ingress/wake; room context must be explicitly shared | **Recommend** |
| VM calls both model APIs and owns their conversation histories | Full local control of turn scheduling | New agent runtime, credentials, duplicate threads, billing and approval semantics; conflicts with #241 | Reject |

## Chat experience

The conversation list has **Workspace room** alongside existing private chats. On entry Alex sees the three named participants, connection state per bot, the active bot, `turn N of 6`, and Pause. Joining requires Alex's explicit consent to share room messages with both providers. Private provider histories, browser pages, desktop images and files are excluded unless Alex deliberately shares scoped content. The room is session-scoped: a service restart clears its display history and leaves collaboration paused. Provider threads keep the messages delivered to them under their own retention rules.

1. Alex sends `@hermes Draft an approach; ask Grok to review.` A leading, case-insensitive `@hermes` routes to Hermes. `@grok` routes to Grok. An unaddressed message is visible room context and wakes neither bot. Reject unknown or multiple leading recipients; omit `@both` in MVP.
2. Hermes posts its answer as **Hermes**. Plain text such as “@grok might disagree” has no routing effect. A structured handoff event can request **Grok Bot** next; the UI shows `Hermes → Grok Bot`, the root task, and the remaining turns.
3. Grok reviews in its own provider thread, posts a chosen room reply and either finishes or hands back. Both adapters include only the bounded room context for that task, identified as untrusted peer text. They never forward one provider's complete private thread.
4. After six admitted bot turns, the last reply remains visible and the room waits for Alex. A new addressed Alex message starts a fresh task and fences the old turn. General Alex notes cannot reset the budget.
5. **Pause bots** immediately cancels pending room deliveries and room execution grants, fences late replies and requests cancellation of the current provider turn when supported. Show “Stopping current action” until its outcome is known. Pause does not undo an already-dispatched external effect. **Resume** changes readiness only; Alex must send a new mention. Human desktop Take control remains an independent host hold.

Bot availability must be honest: `connected`, `waiting for provider`, `disconnected`, `paused`, `needs Alex`, or `delivery unconfirmed`. A successful tool listing is not proof that Grok can be woken or that its native chat can be embedded. The Workspace room is a shared task thread, not an embedded copy of Grok's native conversation.

## Authority, delivery and loop prevention

Use #241's one VM authority and principal registry. Grok's restricted OpenSSH command on the tailnet binds its credential to its principal before MCP dispatch. Hermes's plugin enters that same authority under its own registered principal. Display names, model arguments, bot headers and quoted text never select the author. Only the authenticated owner app can create membership, pause/resume, start a root task or approve content sharing. Require room membership for reads as well as writes; deny third bots and cross-room cursors.

CU MCP enforces these rules for both Workspace clients and plugin adapters; the renderer, generated Grok skill and optional transport are not admission authorities. All tools below belong to CU MCP; owner IPC belongs to Workspace and forwards to that authority. Plugins bind delivery to provider threads rather than implement separate room budgets.

Proposed additive tools, **not implemented or advertised by this patch**:

| Operation | Caller and contract |
| --- | --- |
| `workspace_room_read(room_id, after_sequence)` | Member only; bounded shared events, current turn and connection state. No private histories, credentials, approval receipts or implicit page/desktop attachments. |
| `workspace_room_post(room_id, turn_id, request_key, text)` | Current assigned bot only; authenticated author is injected by the adapter. One final reply per turn; literal text only. |
| `workspace_room_handoff(room_id, turn_id, request_key, to, summary)` | Current assigned bot only; atomically finish its reply and admit the peer's next turn under the same root. Never a new root, self-handoff, fan-out or authority transfer. |
| Owner `room:command` IPC | Closed command allowlist and bounded projection, patterned after the Hermes hub. Owner posts, membership, Pause and Resume do not exist as bot tools. |

Keep room admission separate from the provider's own turn lifecycle. A provider may finish tool execution after posting a room result; it must not receive further room execution grants for that consumed turn. Adapters bind one exact provider/profile/thread per member and pass a server-issued room invocation token through trusted code. Do not choose a thread from a model-provided string or the pane's current selection.

Admission rules:

- One active bot turn in the room, six admitted turns per addressed owner instruction, no parallel fan-out. Each turn has a fresh opaque ID, root ID, parent and credential generation. Handoff consumes the predecessor once. Denied attempts cannot mint more turns.
- Owner Pause/new addressed instruction invalidates old turn IDs and queued delivery. Duplicate reply/handoff keys return the known outcome; conflicting arguments reject. Record admission metadata/digests and uncertain tombstones in #241's existing ledger. JSON-RPC IDs are not idempotency keys.
- Production turns expire after 120 seconds and root tasks after five minutes; waits, retries and reconnects do not reset these deadlines. Expiry pauses instead of scheduling another bot. Existing tool call/batch limits still apply; six turns alone would not bound infinite tool calls inside one turn.
- Deliver on a queue, never recursively call the other model from a post handler. Only the trusted provider adapter admits/wakes the next turn. If delivery is uncertain, preserve that state and inspect the existing provider invocation before retrying. No blind resend after timeout, reconnect or service restart.
- A stock MCP client can call tools but is not necessarily an inbound message receiver. Hermes may use a verified plugin ingress into its exact existing gateway thread. Grok needs a verified supported invocation/routine or client-owned read mechanism. Without one, show **waiting for Grok** and let Alex carry the request into Grok's own chat; do not add a new scheduler, scrape private APIs or pretend the bot replied.

Keep shared text in bounded memory for the first live MVP, matching #241's no-transcript-database decision. Store only membership, policy, delivery IDs/digests and outcome certainty durably. On restart, invalidate old boot/turn tokens, pause, and do not reconstruct/resend missing text. Durable shared history is a later explicit ADR/retention decision, not an implicit copy of private provider data. MVP caps the feed at 100 messages of 4000 characters and visibly reports omission; adapters pass only the task's bounded shared context.

## OpenPod hybrid delivery adapter

Retain the hybrid option: one private OpenPod pod for Alex, Hermes and Grok Bot, guests off and mentions-only wakes, as a candidate shared text delivery/wake transport. Workspace remains the room experience; **CU MCP owns policy**, and each **plugin owns its provider-side delivery adapter**. OpenPod is a replaceable transport dependency, not a fifth first-party product, desktop driver or model scheduler. No OpenPod integration is implemented here.

The Hermes adapter would consume outbound events with `openpod wait`; the Grok adapter would use a supported native webhook routine or client-owned polling mechanism if verified. These are capability hypotheses, not evidence that either bot can currently be woken. Any webhook needs a supported private/outbound delivery route under the no-public-ports rule. If Grok requires a publicly exposed receiver, that path is blocked; do not enable Funnel or a public bridge. Outbound access to a hosted pod would be an explicit exception to tailnet-only message carriage, with provider visibility/retention reviewed before opt-in. A tailnet-hosted compatible transport is preferable if supported; its availability and license must be verified.

CU MCP first admits the addressed owner turn or structured handoff, then queues delivery with the room/root/turn IDs, invocation identity and idempotency key. The plugin maps a verified transport sender to its credential-bound principal and exact native thread, checks the live grant, and sends only approved bounded context. A transport mention or webhook is a delivery signal; arbitrary pod prose cannot create a root task, hand off, spend a turn or grant tools. Admit once even if a native mention wake and an adapter event both arrive; missing reliable invocation deduplication blocks automatic wake.

Pause/supersede revokes the CU MCP grant and queued deliveries; any later pod event/reply is fenced even if native cancellation is unavailable. OpenPod availability, stale cursors or retry limits cannot reset budgets/deadlines, steal the lease or authorize a resend after uncertain delivery. On restart leave the room paused; do not reconstruct its ephemeral feed from pod history. A pod may retain delivered text separately, so its retention/deletion behavior needs explicit consent rather than the Workspace session-scoped promise. Do not put credentials, approval receipts, screenshots or private histories in the pod. If delivery or sender identity cannot be verified, show waiting/unconfirmed and keep manual carry as fallback.

## Safely sharing the VM desktop

A room task handoff transfers **intent and an optional explicitly shared artifact**, never the input lease, tab access, owner consent, principal, current refs or an unfinished action. A room is not a desktop permission grant. Each bot's reviewed profile and tool exclusions remain in force; Grok cannot inherit Hermes's trusted status.

For a room-issued native mutation: authenticate → validate membership/current turn/deadline → existing profile and operation approval → current host/snapshot/target check → existing shared desktop lease → recheck pause/turn/host grant immediately before dispatch → execute once and record outcome. For batches, repeat dispatch checks between steps. Read access still needs its own profile/membership scope; a posted screenshot must be a deliberate room share because it discloses content to another provider.

Reuse #252 rather than adding a second lease. The current holder completes any accepted action; active input is never stolen by a handoff. The successor sees `desktop_busy` and the holder/retry time, waits within the original deadline, then obtains a **fresh snapshot** before acting. Lease-idle expiry is not evidence that an uncertain third-party effect did not occur. Owner Take control fences queued input and invalidates observations; release requires a new snapshot.

The **CU MCP server owns that lease per execution host**, keyed by authenticated bot principal; both plugins use it, including private-thread calls outside the room. Neither a plugin profile nor an OpenPod participant gets a separate lock. Workspace desktop/iOS viewer controls request the same host's human hold; transferring a room turn or changing viewers never releases/renews the holder's lease. A different host has its own lease and approval scope, so VM handoff cannot carry a local desktop grant across hosts.

**Live input gate:** #252's file lease can allow two concurrent winners and ignores unreadable/unwritable state. Before enabling this room to drive the VM, serialize all desktop mutations through #241's single authority or make cross-process lease acquisition atomic and fail closed, including legacy Hermes/Grok children. Also qualify the VM viewer's host-local human hold, which #241 identifies as missing. Do not claim exclusive input merely because #252's sequential tests pass. No lease changes are included here; the offline prototype cannot dispatch input.

## Prototype and scope

Open [desktop/prototypes/agent-collaboration.html](../../desktop/prototypes/agent-collaboration.html) directly in a modern browser. It loads only its sibling [agent-room.js](../../desktop/prototypes/agent-room.js). No build, account, server or network is needed. The left side simulates the shared chat pane; the right side manually simulates the assigned bot and explicitly labels the disconnected desktop.

Try: send `@hermes Draft a plan`, post a simulated reply with handoff, repeat until six turns, then start again and Pause. Resume does not dispatch anything. The prototype preserves literal text, binds bot handles in the trusted local harness, rejects wrong/stale turns, fences late results, caps history, and shares one budget across handoffs. Local handles **are not authentication**; there is no network admission, elapsed-time deadline, provider invocation, restart ledger or desktop grant implementation.

Run from the repository root:

```sh
node --test desktop/test/agent-room.test.cjs desktop/test/desktop-lease.test.cjs
```

The room tests include wrong-bot admission, duplicate/late handoff, six-turn ping-pong, pause/resume, superseding owner messages, invalid input, mutation of display copies, history bounds and interaction with the existing `createDesktopLease`. That last test proves a room handoff cannot override the app lease's active/idle lifetime; it does **not** qualify #252's cross-process VM race or production identity.

The room suite contains **nine tests**, including punctuation after leading mentions, and requires no installed dependencies. The earlier 33-test result covered room, desktop-lease and desktop-approval together before the ninth room test. Run the room suite, `python3 scripts/check_publication.py` and `git diff --check` for this design update; PR checks record CI results. Browser policy previously refused the local-file preview, so visual rendering was not checked. The prototype does not exercise live providers, OpenPod, config loading, iOS or VM/tailnet execution.

The PR adds this design, standalone HTML, shared policy module and a Node test discovered by the existing `test/*.test.cjs` glob. This follow-up changes only the design and explanatory prototype copy. There are no production callers, config changes, fixtures to migrate, exports in the shipped app, dependencies or data migrations. A later integration reaches Workspace's `hermes-hub.cjs`/`hermes-view.js` or an adjacent room view, main/preload IPC and iOS owner controls; the agents repository's two plugin adapters/config consumers and provider thread fixtures; and CU MCP's registry/ledger, tool schemas and VM lease/viewer tests. Keep credentials and bot runtime state out of renderer projections.

## MVP plan and acceptance

| Stage | Smallest deliverable | Evidence required before advancing |
| --- | --- | --- |
| 0 — this draft | Design plus offline shared-pane prototype and pure admission tests | Mentions, explicit handoff, cap, Pause, literal rendering and lease boundary verified without live agents |
| 1 — qualify boundaries | Reconcile CU MCP #241/#243/#252 and agents #157/#158; register distinct principals; qualify exact provider threads, shared-config application and candidate OpenPod delivery/wake | Wrong key/author/room and stale credential refuse; no profile privilege inheritance; validated same-source persona/text voice/proactivity on both bots; stale generated settings detected; one harmless addressed message reaches each exact native thread without public ingress |
| 2 — text-only room | Owner opt-in membership, bounded ephemeral feed, main-process projection, additive room tools and adapter-owned delivery | Alex → Hermes → Grok → Alex transcript with real authors; duplicate post/handoff never invokes twice; peer prose never triggers; absent Grok capability stays visibly waiting |
| 3 — bounded execution | Ledger keys/tombstones, boot fencing, six-turn cap, elapsed deadlines, Pause and exact provider cancellation reporting | Ping-pong ends at six; pause during queued/in-flight handoff; timeout/disconnect/restart neither resets budgets nor replays; unknown delivery stays unknown |
| 4 — shared VM tools | Existing approvals and identity, one safe desktop authority/atomic lease, human hold and fresh-state handoff | Two real connector processes race input with effect counters; one winner only; unreadable/unwritable lease denies; crash/reused PID; active/idle busy behavior; viewer Take control and pause-between-batch-steps prevent further input |
| 5 — supervised opt-in trial | Alex directs a harmless shared task from the chat pane on the actual tailnet | Real Hermes/Grok round trip and pause, denied transaction, busy desktop, reconnect and correct provider thread recorded without secrets; no duplicated or wrong-target effects |

Stage 2 may ship read-only/text-only while stage 4 remains blocked. No automatic browser-tab sharing, durable transcript store, `@both`, extra agents, Workspace/CU MCP background scheduler, provider API keys, native Grok embedding or cross-host state migration in this MVP. Plugin-native, operator-approved routines remain subject to shared proactivity preferences and local pauses. Disable the room entry/adapters to roll back; retain uncertain delivery tombstones and never replay pending input. Existing private chats and ordinary tools remain usable under their existing policy.

Outstanding verification: real Grok inbound/wake support and tailnet durability, separate bot credential isolation, cross-process lease correctness, VM human hold, production service/host grants and physical desktop cancellation behavior. A draft PR should remain a simulation until those gates are demonstrated; passing local tests does not establish any of them.

Open product questions: who distributes the one config source across runtime hosts and reports stale Grok snapshots; whether a later schema needs per-bot identity or speech settings; whether supported OpenPod/Grok delivery works without public ingress and provides sender binding, deduplication and suitable retention; and how iOS owner commands/viewer holds are authenticated and ordered with desktop commands. Keep those as qualification work, not new v1 schema keys or promises of working integrations.

[architecture]: https://github.com/capthvnsen/alans-way/blob/5ea0ea754945df88f8bbe8e235aed87c9d5dfb8a/docs/architecture/target-architecture.md
[identity]: https://github.com/capthvnsen/alans-way/pull/243
[lease]: https://github.com/capthvnsen/alans-way/pull/252
[agents-config]: https://github.com/capthvnsen/alans-way-agents/pull/157
[agents-runtime]: https://github.com/capthvnsen/alans-way-agents/pull/158
[config-schema]: https://github.com/capthvnsen/alans-way-agents/blob/3b4c7ee14f265ea5dc2240059af51957cdb601a2/shared/config.schema.json
[config-consumers]: https://github.com/capthvnsen/alans-way-agents/blob/3b4c7ee14f265ea5dc2240059af51957cdb601a2/shared/README.md

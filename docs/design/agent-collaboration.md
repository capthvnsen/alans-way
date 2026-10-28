# Hermes and Grok Bot in one Workspace room

Status: proposed, with an offline prototype. Date: 2026-10-28.

Recommend an **opt-in, session-scoped Workspace room** for Alex, Hermes and Grok Bot. Render it as another conversation in the left chat pane. The VM's proposed `workspace-mcp` admits room turns; each provider still owns its bot's actual thread and runtime. A leading Alex `@mention` selects one bot, and that bot can explicitly hand the task to its peer. Six bot turns share one budget. Pause cancels pending room turns; Resume requires a new Alex instruction.

This is a design and simulation, not a connected chat integration. No production connector, credential, app preference, public listener or desktop driver changes. Live collaboration remains gated on authenticated identity, supported provider delivery and safe VM input arbitration.

## Baseline read before designing

The checkout is `alans-way@5d10e818a425b32a794d54de6a5866f3ff1e50e0`; it has no `docs/architecture` directory. Read the proposed architecture from [#241 at 5ea0ea7][architecture], plus [#243][identity] at `faf5c2ccb2a10b1472262b6ffc8492a948d04828` and [#252][lease] at `f87d76159ad741f54f1ea4478d80829ba2388c12`. All three were open drafts when read; none is assumed deployed.

| Existing or proposed seam | What collaboration must preserve |
| --- | --- |
| #241: VM `workspace-mcp`, restricted OpenSSH stdio over Tailscale | One authority; Hermes through its plugin, Grok through its command connector. No public HTTP fallback. Tailscale device reachability alone is not per-bot authentication. |
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

## Safely sharing the VM desktop

A room task handoff transfers **intent and an optional explicitly shared artifact**, never the input lease, tab access, owner consent, principal, current refs or an unfinished action. A room is not a desktop permission grant. Each bot's reviewed profile and tool exclusions remain in force; Grok cannot inherit Hermes's trusted status.

For a room-issued native mutation: authenticate → validate membership/current turn/deadline → existing profile and operation approval → current host/snapshot/target check → existing shared desktop lease → recheck pause/turn/host grant immediately before dispatch → execute once and record outcome. For batches, repeat dispatch checks between steps. Read access still needs its own profile/membership scope; a posted screenshot must be a deliberate room share because it discloses content to another provider.

Reuse #252 rather than adding a second lease. The current holder completes any accepted action; active input is never stolen by a handoff. The successor sees `desktop_busy` and the holder/retry time, waits within the original deadline, then obtains a **fresh snapshot** before acting. Lease-idle expiry is not evidence that an uncertain third-party effect did not occur. Owner Take control fences queued input and invalidates observations; release requires a new snapshot.

**Live input gate:** #252's file lease can allow two concurrent winners and ignores unreadable/unwritable state. Before enabling this room to drive the VM, serialize all desktop mutations through #241's single authority or make cross-process lease acquisition atomic and fail closed, including legacy Hermes/Grok children. Also qualify the VM viewer's host-local human hold, which #241 identifies as missing. Do not claim exclusive input merely because #252's sequential tests pass. No lease changes are included here; the offline prototype cannot dispatch input.

## Prototype and scope

Open [desktop/prototypes/agent-collaboration.html](../../desktop/prototypes/agent-collaboration.html) directly in a modern browser. It loads only its sibling [agent-room.js](../../desktop/prototypes/agent-room.js). No build, account, server or network is needed. The left side simulates the shared chat pane; the right side manually simulates the assigned bot and explicitly labels the disconnected desktop.

Try: send `@hermes Draft a plan`, post a simulated reply with handoff, repeat until six turns, then start again and Pause. Resume does not dispatch anything. The prototype preserves literal text, binds bot handles in the trusted local harness, rejects wrong/stale turns, fences late results, caps history, and shares one budget across handoffs. Local handles **are not authentication**; there is no network admission, elapsed-time deadline, provider invocation, restart ledger or desktop grant implementation.

Run from the repository root:

```sh
node --test desktop/test/agent-room.test.cjs desktop/test/desktop-lease.test.cjs
```

The room tests include wrong-bot admission, duplicate/late handoff, six-turn ping-pong, pause/resume, superseding owner messages, invalid input, mutation of display copies, history bounds and interaction with the existing `createDesktopLease`. That last test proves a room handoff cannot override the app lease's active/idle lifetime; it does **not** qualify #252's cross-process VM race or production identity.

Local verification on Node 26.7.0: the room, desktop-lease and desktop-approval suites pass **33 tests**; the eight new room tests require no installed dependencies. JavaScript syntax, HTML control IDs/script references, local design links, staged diff whitespace and `python3 scripts/check_publication.py` pass. Browser policy refused the local-file preview, so visual rendering was not checked. The full Electron suite, CI's Node 24 runtime and live provider/VM/tailnet execution were not run.

Change scope is four new files: this design, the standalone HTML, its shared policy module, and a Node test discovered by the existing `test/*.test.cjs` glob. There are no production callers, config changes, fixtures to migrate, exports in the shipped app, dependencies or data migrations. A later integration reaches `hermes-hub.cjs`/`hermes-view.js` or an adjacent room view, main/preload IPC, the agents repository's plugin/router, `workspace-mcp` registry/ledger, tool schemas, provider thread fixtures and VM lease/viewer tests. Keep credentials and bot runtime state out of renderer projections.

## MVP plan and acceptance

| Stage | Smallest deliverable | Evidence required before advancing |
| --- | --- | --- |
| 0 — this draft | Design plus offline shared-pane prototype and pure admission tests | Mentions, explicit handoff, cap, Pause, literal rendering and lease boundary verified without live agents |
| 1 — qualify boundaries | Reconcile #241/#243/#252; register distinct bot principals; verify exact Hermes thread and supported Grok delivery/wake | Wrong key/author/room and stale credential refuse; no profile privilege inheritance; both providers receive one harmless addressed message in their exact native thread |
| 2 — text-only room | Owner opt-in membership, bounded ephemeral feed, main-process projection, additive room tools and adapter-owned delivery | Alex → Hermes → Grok → Alex transcript with real authors; duplicate post/handoff never invokes twice; peer prose never triggers; absent Grok capability stays visibly waiting |
| 3 — bounded execution | Ledger keys/tombstones, boot fencing, six-turn cap, elapsed deadlines, Pause and exact provider cancellation reporting | Ping-pong ends at six; pause during queued/in-flight handoff; timeout/disconnect/restart neither resets budgets nor replays; unknown delivery stays unknown |
| 4 — shared VM tools | Existing approvals and identity, one safe desktop authority/atomic lease, human hold and fresh-state handoff | Two real connector processes race input with effect counters; one winner only; unreadable/unwritable lease denies; crash/reused PID; active/idle busy behavior; viewer Take control and pause-between-batch-steps prevent further input |
| 5 — supervised opt-in trial | Alex directs a harmless shared task from the chat pane on the actual tailnet | Real Hermes/Grok round trip and pause, denied transaction, busy desktop, reconnect and correct provider thread recorded without secrets; no duplicated or wrong-target effects |

Stage 2 may ship read-only/text-only while stage 4 remains blocked. No automatic browser-tab sharing, durable transcript store, `@both`, extra agents, background scheduler, provider API keys, native Grok embedding or cross-host state migration in this MVP. Disable the room entry/adapters to roll back; retain uncertain delivery tombstones and never replay pending input. Existing private chats and ordinary tools remain usable under their existing policy.

Outstanding verification: real Grok inbound/wake support and tailnet durability, separate bot credential isolation, cross-process lease correctness, VM human hold, production service/host grants and physical desktop cancellation behavior. A draft PR should remain a simulation until those gates are demonstrated; passing local tests does not establish any of them.

[architecture]: https://github.com/capthvnsen/alans-way/blob/5ea0ea754945df88f8bbe8e235aed87c9d5dfb8a/docs/architecture/target-architecture.md
[identity]: https://github.com/capthvnsen/alans-way/pull/243
[lease]: https://github.com/capthvnsen/alans-way/pull/252

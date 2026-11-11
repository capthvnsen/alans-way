# Grok Bot 1.0.1 parity matrix

Recon only. No product code changed. Date: 2026-11-11. Alan's Way at `31835f1`, Alan's Plugin repo at v0.21.14, Hermes v0.23.1.

## How to read this

**Grok Bot evidence** has two independent sources, and each row says which one supports what:

- `R#` is a REA Evidence record from static analysis of the installed app (`app.asar`, sha256 `171d607e…d2e9`). Full ids are in [Appendix A](#appendix-a-rea-commands-and-output). REA recovered **structure only**: which lazily loaded UI modules exist and what they import, windows, preload bridges, native addons. It did not recover UI text, field names or settings values. So an `R#` cite proves a feature module ships in 1.0.1; it does not prove how it behaves. The word after `R#` is the module the record pins.
- `CL x.y.z` is the public changelog entry for that version, and `AN` is the 1.0 announcement. Behaviour, controls and numbers come from these. All of it is paraphrased.

Where REA found nothing, the cell says `REA: none`. Static analysis never shows runtime behaviour.

**Alan's Way evidence** paths are relative to this repo unless prefixed: `agents:` is `~/alans-way-agents`, `hermes:` is `~/.hermes/hermes-agent/website/docs` (the Hermes 0.23.1 docs shipped with the local install).

**Status**: Has, Partial, Missing. "Partial" often means Hermes can already do it and no Alan's Way surface shows it.

**Home**: `Hermes` (native setting or skill), `Plugin` (Alan's Plugin), `CU MCP`, `Workspace` (desktop UI), `Widget` (a Hermes Desktop block type that the native chat also renders).

**Wave**: W1 chat + Canvas UI, W2 proactive offers / follow-ups / learnings, W3 Pages / Artifacts / docs / decks, W4 connectors UI + smarter approvals, W5 voice + polish.

## Chat and layout

| # | Feature | Grok Bot evidence | Status | Alan's Way evidence | Home | Wave |
|---|---|---|---|---|---|---|
| 1 | Bots list that adapts to how many bots you have (one bot hides it, a few show a narrow rail, many show the full list), with search and new-chat on top | R1 `agents`, `team-agent-rows`, `new-chat-bar`; CL 0.58.0, 0.79.2 | Partial | `desktop/src/renderer.js:45-80` lists Telegram bots only, with unread dot, activity line, drag sort, hide | Workspace | W1 |
| 2 | Message thread in a messaging style: bubbles, reactions on the bubble, quote a selection into the composer, hover timestamps | R1 `chat`, `messages`, `transcript-markdown`; CL 0.44.0, 0.62.0, 0.70.2 | Partial | `desktop/src/hermes-view.js` native pane has streaming turns and a reasoning block, no bubbles, reactions or quoting | Workspace | W1 |
| 3 | Rich reply rendering: markdown, tables that scroll, copy and go full screen, code blocks, math | R1 `transcript-markdown`, `markdown-math`, `CodeBlock`; CL 0.60.0, 0.75.2, 0.77.0, 1.0.1 | Partial | `desktop/src/hermes-view.js:366-380` renders plain text plus code fences only | Workspace | W1 |
| 4 | Send states: a message shows as sent at once, progress appears only after a delay, failed drafts are recoverable | R1 `draft-send-error`; CL 0.57.0, 0.70.2 | Partial | `desktop/src/hermes-view.js` has drafts, send/stop and a "delivery unconfirmed" card | Workspace | W1 |
| 5 | Bot activity stays visible while it works, including when you send another message mid-run | R1 `task-rows`; CL 0.37.0, 0.67.0 | Partial | `desktop/src/activity.cjs` drives a per-bot activity line from Telegram chat actions; Hermes stream events `hermes:user-guide/features/api-server.md:408` not shown as status | Workspace | W1 |
| 6 | Composer: lists, block quotes, emoji picker, spell check, plain paste | R1 `prompt-editor`, `emojibase`; CL 0.21.0, 0.62.0, 0.75.2 | Partial | `desktop/src/hermes-view.js` plain textarea with drafts | Workspace | W1 |
| 7 | Attachments: many files per message, large files, reorder, download all | R1 `file-stage`, `fullscreen-file-viewer-body`; CL 0.21.0, 0.71.2, 0.75.2 | Partial | iOS sends files `ios/AlanWorkspace/Telegram/TelegramStore.swift`; desktop native pane has no attach (`desktop/src/hermes-view.js`, none found) | Workspace | W1 |
| 8 | One inbox across every chat surface | R1 `agents`, `chat` (single app, single list); CL 0.70.2 (state synced desktop and phone) | Missing | Surfaces are alternatives picked by `chatTarget` (`desktop/src/main.cjs:127`); the hub never maps Telegram bots to Hermes sessions (`desktop/src/hermes-hub.cjs:11`) | Workspace | W1 |
| 9 | Search palette over bots, settings, actions and routines, then messages | R1 `spotlight-app`, `people-search-menu-live`; CL 0.54.0, 0.68.0, 0.79.2 | Missing | No palette in `desktop/src/renderer.js` (grep for palette, ⌘K: none) | Workspace | W5 |
| 10 | Quick-launch window and a pop-out chat window bound to one bot | R3 preload bridge keys for spotlight and pop-out (pop-out carries an agent id); R1 `spotlight` | Missing | `docs/design/hermes-webapp-embed.md` lists "no pop-outs" as a known limit | Workspace | W5 |

## Canvas (right pane)

| # | Feature | Grok Bot evidence | Status | Alan's Way evidence | Home | Wave |
|---|---|---|---|---|---|---|
| 11 | Side pane that follows the selected bot, with tabs | R1 `pane-header`, `stack-pager`, `team-bot-details-pane`; CL 0.29.0, 0.75.2 (one column, profile on top, tabs for media, computer, routines), 0.77.0 | Partial | `desktop/src/index.html:43` tab strip with Browser and Bot screen; choice kept per bot in `prefs.canvasTabs` (`desktop/src/main.cjs:383-406`) | Workspace | W1 |
| 12 | Browser tab | R4 `preload-webview`; CL 0.63.0 (faster browsing), AN | Has | `desktop/src/main.cjs:842`; CU MCP browser tools `desktop/scripts/browser-mcp.cjs:113-199` | Workspace | W1 |
| 13 | Bot screen: watch the bot's computer, starts in watch mode, take control on request | R4 `computer-screen-preview`, R3 VNC and desktop-mount preloads, window-capture addon; CL 0.68.1, 0.70.2 | Has | `docs/design/hermes-canvas.md`; noVNC viewer with watch and take-control; `hermes:user-guide/features/bot-screen.md` | Workspace | W1 |
| 14 | Terminal on the bot's computer | CL 0.19.0 (paste into a terminal on the bot's computer); REA: none | Missing | Listed under "Later tabs" in `docs/design/hermes-canvas.md:32`; only reachable through the embedded webapp | Workspace | W1 |
| 15 | Side chat (ask a second question without derailing the main thread) | REA: weak, R1 `use-ask-agent` only; no changelog entry. **Not a Grok Bot parity item; it is in Alex's drawing.** | Missing | "Later tabs" in `docs/design/hermes-canvas.md:32`; Hermes can fork a session `hermes:user-guide/features/api-server.md` (`POST /api/sessions/{id}/fork`) | Workspace | W1 |
| 16 | Bot settings in the side pane: editable profile, name, avatar, per-bot notification switch | R4 `bot-configure-dialog`, `general-pane`, R1 `agent-avatar-editor`; CL 0.68.0, 0.75.2 | Partial | App-level settings only (`desktop/src/renderer.js`, `desktop/src/avatars.js`); shared persona/voice config `agents:shared/config.schema.json` has no UI | Workspace | W1 |
| 17 | Routines / cron tab: list, pause, resume, test, edit, delete | R4 `automation-detail-panel`, `automation-trigger-glyph`; CL 0.52.0, 0.68.0, 0.71.2 | Partial | Hermes has it natively: `hermes:user-guide/features/cron.md`, REST `/api/jobs` (`hermes:user-guide/features/api-server.md:683`). No Workspace UI | Workspace | W1 |
| 18 | Plugin tabs | R4 `plugin-detail-view`, R1 `native-plugin-detail` | Missing | Tab manifest idea in `docs/design/hermes-canvas.md`; Hermes SDK panes `hermes:developer-guide/desktop-plugin-sdk.md:241` | Workspace + Plugin | W1 |
| 19 | Tasks view of background agents the bot started, with working / failed / unknown states | R1 `tasks-sidebar-list`, `task-rows`; CL 0.63.0, 0.78.4 | Partial | Hermes kanban is native (`hermes:user-guide/features/kanban.md`); no Workspace UI | Workspace | W2 |

## Proactivity, follow-ups, learnings

| # | Feature | Grok Bot evidence | Status | Alan's Way evidence | Home | Wave |
|---|---|---|---|---|---|---|
| 20 | Primary bot (starred) notices work it could take over and offers to do it | CL 0.66.0, 0.77.0; AN. REA: none (string trace for the term found no graph match, R10) | Partial | `agents:alans-way/proactivity.py` idle check-ins after 120 min with backoff, morning brief and weekly report off by default, Telegram only | Plugin | W2 |
| 21 | Follow-ups: the bot returns to unfinished work and chases it | AN; CL 0.37.0, 0.77.0 | Partial | Hermes heartbeat re-enters an idle session (`hermes:user-guide/features/heartbeat.md`); plugin runs its own 60 s tick instead | Hermes + Plugin | W2 |
| 22 | Routines triggered by schedule, webhook, tagged email or outside events, with run limits | R4 `automation-trigger-glyph`; CL 0.17.0, 0.21.0, 0.71.2, 0.75.5 | Partial | Hermes cron and jobs API (see row 17); plugin does not use them (`agents:alans-way/proactivity.py`) | Hermes | W2 |
| 23 | Ready-made routine templates the user can start from | R1 `template-editor-dialog`, `bot-template-details-dialog`; CL 0.77.0, 0.78.1 | Missing | None found in either repo | Plugin (skill) | W2 |
| 24 | One memory per bot across all chats, editable only by its owner; import memory from another assistant | R7 (learning trace: 9 seeds, 19 nodes), R1 `bot-manage-knowledge`; CL 0.75.2, 0.77.0 | Partial | Hermes memory files and session search `hermes:user-guide/features/memory.md`; no view or edit UI in Workspace | Hermes + Workspace | W2 |
| 25 | Learnings review: what the bot was taught waits in a queue until approved | R7 `bot-configure-learnings-shown`, `team-bot-memories-list`; CL 1.0.1 (team bots); AN | Partial | Hermes can stage memory writes for approval: `write_approval` and pending/approve commands (`hermes:user-guide/features/memory.md:292,329`). Off by default, no UI | Hermes + Workspace | W2 |
| 26 | Bot proposes changes to its own rules or workflow, shown as a card with a text diff | R1 `auto-review-rule-notice`, `sand-rule-text-diff`; CL 0.75.8; AN | Partial | Hermes can suggest allowlist entries from the CLI (`hermes:user-guide/security.md`); nothing in chat | Widget | W4 |

## Pages, artifacts, docs, decks

| # | Feature | Grok Bot evidence | Status | Alan's Way evidence | Home | Wave |
|---|---|---|---|---|---|---|
| 27 | Pages: bot-built reports, memos and dashboards that are edited together or kept up to date by the bot | R4 `document-page`, `visualization-document`; CL 0.75.2, 0.79.3; AN | Partial | Hermes renders HTML inline through its preview directive (`hermes:developer-guide/desktop-plugin-sdk.md:1153`); native pane cannot render it (`desktop/src/hermes-view.js:366-380`) | Widget + Hermes skill | W3 |
| 28 | Page chrome: rename, find in page, download as PDF, share / unshare, light and dark | R4 `document-page`, R1 `bot-share-popover`; CL 0.70.2, 0.75.2, 0.79.3 | Missing | None found | Workspace | W3 |
| 29 | Slide decks: bot shows sample slides to pick a look, delivers a presentation file | R4 `presentation`; CL 0.68.1 | Missing | None found; Hermes delivers files as attachments (`hermes:user-guide/features/deliverable-mode.md`) | Hermes skill | W3 |
| 30 | Library / Artifacts: per-bot list of pages, files, links and apps, pinned section, filters, hover preview | R1 `bot-store-files-library`, `library-visual-viewer`; CL 0.62.0, 0.75.2, 0.79.2 | Missing | No artifacts tab (`docs/design/hermes-canvas.md:32` lists it as later) | Workspace | W3 |
| 31 | File viewers: PDF, CSV, spreadsheet with cell selection, text, full screen, HTML preview with a source toggle, video speed | R4 `fullscreen-file-viewer-body` imports CSV, PDF, text and spreadsheet viewers; CL 0.31.0, 0.49.0, 0.56.0, 0.70.2 | Partial | PDF viewer only: `desktop/src/local-pdf.cjs` | Workspace | W3 |
| 32 | Charts and diagrams inside pages and replies | R1 `visualization-d3-runtime.gen`, `visualization-three-runtime.gen`, `sand-diagram-render` | Missing | None found | Widget | W3 |

## In-chat cards

| # | Feature | Grok Bot evidence | Status | Alan's Way evidence | Home | Wave |
|---|---|---|---|---|---|---|
| 33 | Question cards: multi-select, several questions as a stepper, free-text answer | R1 `inline-user-form`, `form-values`; CL 0.25.0, 0.75.2, 0.77.0 | Partial | Native pane has clarify and value request cards (`desktop/src/hermes-view.js:444`) | Widget | W1 |
| 34 | In-chat forms the bot prefills, with address lookup and a secure form for card numbers | R1 `sand-form-dialog`, `user-form-phone`; R3 address-lookup and card-text-recognition addons; CL 0.44.0, 0.71.2, 0.77.0, 0.79.2 | Missing | None found | Widget | W3 |
| 35 | Shopping cards: product photo, rating, price, store, a few results side by side, buy action | R4 `shopping-stage`, `cart-stage`, `list-card`; CL 0.78.1, 0.79.2 | Missing | `agents:alans-way` web-errands skill does the browsing, no card output | Widget + Plugin | W3 |
| 36 | Order cards: total, pay action that waits for the user, submitted state while checkout finishes, expiry with a re-price action | R4 `order-checkout` (imports payment-card, vault-card, virtual-card and widget modules), `receipt-shell`; CL 0.78.1, 0.78.4, 0.78.5, 1.0.1 | Missing | Safety base exists: commit gate `agents:alans-way/scripts/workspace-router.cjs:935-954`, payment hand-back states in `desktop/scripts/browser-mcp.cjs` | Widget + Plugin + CU MCP | W3 |
| 37 | Order tracking, refunds and scheduled reorders (one approval per reorder) | R4 `order-stay-receipt-estimate`; CL 0.78.1, 0.78.4, 0.78.5 | Missing | None found | Plugin (skill) | W3 |
| 38 | Travel cards: hotels, car rental, places with a map | R4 `hotel-cards`, `car-rental-card-requests`, R1 `places-stage`, `place-mini-map`; CL 0.79.2 | Missing | None found | Widget | W3 |
| 39 | Link cards with live status and hover preview | R1 `link-dialog`, `link-brand-logo`; CL 0.33.0, 0.34.0, 0.57.0, 0.68.0 | Missing | None found | Workspace | W3 |
| 40 | Apps from connectors shown as interactive cards | R4 `widget` (widget, draft and selection endpoints), `chat-widget`; CL 0.70.2, 0.79.2 | Partial | Hermes block types and tool media renderers (`hermes:developer-guide/desktop-plugin-sdk.md:1102`); not rendered by the native pane | Widget | W3 |

## Connectors and approvals

| # | Feature | Grok Bot evidence | Status | Alan's Way evidence | Home | Wave |
|---|---|---|---|---|---|---|
| 41 | Connect Apps catalogue: categories, recommended picks, per-app detail | R4 `connect`, `connector-card`, `connector-data-center`, `plugin-detail-view`, R1 `marketplace-for-you`; CL 0.48.0, 0.67.0 | Partial | Hermes MCP config and catalogue install (`hermes:user-guide/features/mcp.md`); Workspace only has CU connector setup (`desktop/src/renderer.js:1797-1803`) | Workspace | W4 |
| 42 | Add your own MCP server from a form | R4 `custom-mcp-form`, `mcp-server-connector`, `user-custom-connector` | Partial | Hermes `mcp_servers` config with an untrusted gate (`hermes:user-guide/features/mcp.md`); no form | Workspace | W4 |
| 43 | Vault for logins, payment cards and contacts; password-manager link | R4 `vault-card-editor`, `vault-card-dialog`, R2 password-manager connection service; CL 0.53.0, 0.75.5, 0.77.0 | Missing | None found | Hermes (secrets) | W4 |
| 44 | Approval cards in chat: one-line ask, expand for the full request, stay open for a set time, say which rule paused the action | R6 (approval trace: 14 seeds, 26 nodes) `send-imessage-approval`, `unrequested-meeting-approval`; CL 0.56.0, 0.67.0, 0.77.0, 0.79.2 | Partial | Native pane approval cards (`desktop/src/hermes-view.js:505`); desktop OS prompt with timed grant (`desktop/src/desktop-approval.cjs`) | Widget | W4 |
| 45 | Permission rules: an always-ask list and an allow-without-asking list, add from settings or straight from a card | R1 `auto-review-selector`, `sand-auto-review-instructions`; CL 0.36.0, 0.59.0, 0.67.0, 0.77.0 | Partial | Hermes approval modes, deny globs and command allowlist (`hermes:user-guide/security.md:34,319`); no UI | Workspace | W4 |
| 46 | Smarter approvals: the bot recognises what is already authorised and asks less | AN; CL 0.75.5 | Partial | Hermes `approvals.mode: smart` (`hermes:user-guide/security.md:34`); the native chat reads sessions, where approval frames are a separate path (`hermes:user-guide/features/api-server.md`, runs `/approval`) | Hermes | W4 |
| 47 | Per-computer permission: always, ask each time, never | R3 window-capture and process-list addons, R5 local exec daemon; CL 0.29.0, 0.30.0, 0.37.0 | Has | `desktop/src/desktop-approval.cjs` (ask, idle grant, denial hold), `desktop/src/computer-policy.cjs` (hard blocklist) | CU MCP | W4 |
| 48 | Drafts the user sends or discards for outgoing email | CL 0.45.0, 0.60.0, 0.64.0, 0.68.1; R6 `send-imessage-approval` (same pattern for messages) | Missing | None found | Widget | W4 |

## Voice, notifications, polish

| # | Feature | Grok Bot evidence | Status | Alan's Way evidence | Home | Wave |
|---|---|---|---|---|---|---|
| 49 | Voice menu per bot: one card per voice and a speed slider from half to double speed; the choice sticks per bot | CL 0.63.0, 0.70.2, 1.0.1. REA: none for the menu itself | Partial | TTS call accepts a speed value (`mobile/voice/openrouter_speech.py:45-49`); tone only in `agents:alans-way/voice.py`; no picker or slider | Workspace + Hermes | W5 |
| 50 | Voice calls: survive network drops, pick the microphone, bot can answer while muted, same voice controls in the call | R4 `phone-call`, `voice-call-feedback-card`; CL 0.58.0, 0.75.2, 1.0.1 | Partial | Mobile Mini App call only (`mobile/miniapp/call.js`, `mobile/voice/server.py`); no desktop calls | Workspace | W5 |
| 51 | Dictation with a shortcut and live words; send as a voice memo bubble | R4 `voice-memo-bubble`; CL 0.20.0, 0.77.0, 0.78.4 | Missing | None on desktop; Hermes STT exists (`hermes:user-guide/features/voice-mode.md`) | Workspace | W5 |
| 52 | Notifications: on each reply, desktop first when you are at the computer, cleared when read, per-bot switch | R8 notification-settings native addon; CL 0.62.0, 0.65.0, 0.68.0, 0.71.2, 0.77.0 | Partial | Only a hand-back notification (`desktop/src/main.cjs:1042`); Telegram handles its own | Workspace | W1 |
| 53 | Dock badge counting unread conversations, muted bots excluded | CL 0.49.0, 0.77.0. REA: none | Missing | Unread dot per row only (`desktop/src/telegram-preload.cjs:267`) | Workspace | W1 |
| 54 | Personal usage view (weekly usage, limit banner) | R4 `usage-review-gate`, `top-up-modal-host`; CL 0.25.0, 0.46.0, 0.59.0 | Missing | None found | Workspace | W5 |
| 55 | First-bot setup and setup checklist | R1 `onboarding-flow`; CL 0.31.0, 0.51.0, 0.55.0 | Has | `desktop/src/setup-check.cjs`, `docs/superpowers/specs/2026-10-08-setup-check-design.md` | Workspace | n/a |
| 56 | Teach by recording: the user demonstrates a task once for the bot | R4 `teach-recording-controls` imported by the screen preview | Has | Recordings tool `desktop/scripts/browser-mcp.cjs:199` | CU MCP | n/a |
| 57 | Bot-coloured chat and avatar editor | R1 `agent-avatar-editor`; CL 0.64.0, 0.68.1 | Partial | Avatars: `desktop/src/avatars.js`; no per-bot accent | Workspace | W5 |

## Out of scope (listed so nobody re-discovers them)

| Feature | Grok Bot evidence | Decision |
|---|---|---|
| Team Bots, managers, group access, shared connectors, team learnings approval | R1 `team-bot-*` (about 30 modules); CL 0.61.0, 0.64.0, 1.0.1 | Out of scope: Alex and friends only |
| Slack and Microsoft Teams | R1 `grok-bot-slack-dialog-live`, `teams-integration-shown`; CL 0.63.0, 1.0.1 | Out of scope |
| Video meetings | R6 `unrequested-meeting-approval`; CL 1.0.1 | Out of scope |
| Billing, plans, top-ups, enterprise audit | R4 `top-up-modal-host`; CL 0.18.0, 0.19.0, 0.40.0 | Out of scope |

## Totals

57 in-scope rows: 5 Has, 30 Partial, 22 Missing. Of the 30 Partial rows, 14 are cases where Hermes already does the work and only a surface is missing (rows 17, 19, 21, 22, 24, 25, 26, 27, 40, 41, 42, 45, 46, 49).

## Appendix A: REA commands and output

Tool: `reverse-engineer-anything` skill, REA MCP server (`rea-agents` 6.7.0). Target: `/Applications/Grok Bot.app/Contents/Resources/app.asar`, sha256 `171d607e9faf339ca9a66c0c0113c23c390ac577ca39a72df23b0fdf74dcd2e9`. Raw output is in `/tmp/rea-grokbot/` on Alex's Mac and is not in any repo.

Three sessions analysed the same archive (the lead and two subagents). REA parent ids are per session, so three parent ids exist for one artifact; the archive hash is the stable anchor.

| Ref | Command and key parameters | Real output | Evidence id |
|---|---|---|---|
| fail | `analyze_javascript_application` default integrity policy | **Error** `artifact_integrity_mismatch`: declared hash for an unpacked native addon differs from the file (declared `78bb5ec3…`, calculated `85881109…`). REA's stated cause: native binaries are signed after packing. REA's stated remedy: rerun with `integrity_policy=record-and-continue` | none |
| R0 | same, `detail: summary`, `integrity_policy: record-and-continue` | OK. 696 relevant files, 668 JavaScript files parsed, 0 parse failures, 8,323 findings. 7 windows, 11 bridge APIs, 18 IPC operations (13 dynamic), 2 utility processes, 6 native addon bindings. Coverage partial: 1,102 application unknowns, 68,184 semantic unknowns. 11 native files flagged untrusted | parent `ev_c63a665ba33516b5c83084dcfdef710aa6f8dc0f30fa6f82fae9797fafa2f812`, summary `ev_d7c854f53c35e61b1ac613553e15406c7e93d1af2279c2fa065c7d08bd8d37f5` |
| R0b | `inspect_analysis_view` facts for endpoint, storage, IPC channel, window kinds, 6 of 146 rows | 146 rows total; property keys per row are endpoint kind, mechanism, value, channel, operation | `ev_29bc7b415beb21bd481be25215d9e4d4bdc16525e9e6b5c5358d863ed5570146` |
| R1 | `inspect_analysis_view` module references, asset kind, limit 1500 (subagent A, parent `ev_5e94f800…f8d3`) | 668 assets: the full list of renderer module names used above | `ev_2c75d0e5d785261756e35ca2edd96a31769d0424be406b0f376138fbafc27025` |
| R2 | `inspect_analysis_view` facts: windows, IPC, endpoints, storage, workers, addons (subagent A) | 174 rows | `ev_e8655b0783af7096fce79ea28f5e0a5eb13bb8855aea3c86df8f7266d8af5963` |
| R3 | `inspect_analysis_view` facts: bridge, native addon, IPC kinds (subagent B, parent `ev_78ee90a0…dac0`) | 40 rows: bridge keys for desktop, pop-out, spotlight, coordinator port, desktop mount panel / files / capture overlay; 9 native addon paths | `ev_212ac120d026726acce41fc0f4b392f4a109a9546325db9735df06103ab613bc` |
| R4 | `inspect_analysis_view` facts for 55 selected renderer modules (subagent B) | 105 rows with each module's static imports | `ev_6d2e3d0077f587835a47f6508f3ceeef137d142614eaa1924168be1e792fa811` |
| R5 | `inspect_analysis_view` facts for the local exec daemon (subagent B) | 259 endpoint rows, 256 references; shell parsing addon and child-process use observed | `ev_ff331bc65f6d55e81cc2b30c700609a7e4d17c24c8743b694e99a234abec1391` |
| R6 | `trace_application_feature` string seed for approvals, outgoing (subagent A) | 14 seeds, 26 nodes | `ev_6de837aecc5a30a227332bc6a999e66cb2213bb57849b52f8cce000f3df20c0a` |
| R7 | `trace_application_feature` string seed for learnings, outgoing (subagent A) | 9 seeds, 19 nodes | `ev_7f9b85059ba676e6d43776333d0e1fa589fcecb87acb58794367e4333f3b87ce` |
| R8 | `trace_application_feature` string seed for notifications, outgoing (subagent A) | 11 seeds, 1 native hand-off | `ev_e2d12c5429ce40b3fea6259d16ce965c39c7d2b2f6d7d97733d1a17866b07f52` |
| R9 | `trace_application_feature` module seed for the daemon, outgoing (subagent B) | Resource-constraint stub only | `ev_f72578b859400d9cbe35836f3799ae4c9b781ce1f531bd846568de4f084f8e45` |
| R10 | `trace_application_feature` string seeds for proactive offers and for slides | No graph match for either. Not proof of absence: REA string seeds match graph entities, not text inside renderer code | `ev_eccb6dd3…d472`, `ev_afd4196d…c467` (short form as reported by the subagents; full ids were not saved) |

### Limits of the REA evidence

- REA's JavaScript graph for this app keeps module identities, imports, windows, bridges, IPC and endpoints. It does not keep UI text, enum values or settings fields for renderer modules. Voice options, approval levels, card fields and notification triggers are therefore **not** established by REA; they come from the changelog.
- 13 of 18 IPC operations use dynamic channels, so renderer-to-main pairs are unresolved.
- Native addon exports were not analysed.
- REA's source-recovery tool needs Linux x64 and was not run. A runtime capture of the app was not run.
- Three large files exceeded REA's relationship budget: the exec daemon's main file and two renderer chunks.

## Appendix B: public sources

- `AN`: <https://x.ai/news/grok-bot-1-0>, read 2026-11-11, HTTP 200. It names no versions.
- `CL`: <https://x.ai/changelog/bot>, read 2026-11-11. Plain HTTP fetches got 403 from the site's bot protection; the page was read in a normal browser tab (1,578 lines, 62 releases from 0.17.0 on 2026-08-12 to 1.0.1 on 2026-11-11). Version numbers quoted above for proactivity, Pages, decks, Connect Apps, voice speed, order cards, the always-allow rule, notifications, the dock badge, Library, take-control and in-chat apps were re-checked against the page text by keyword. Other version numbers come from a subagent's read and are not individually re-checked.

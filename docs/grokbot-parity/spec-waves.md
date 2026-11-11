# Build spec by wave

What to build for every Missing and Partial row in [parity-matrix.md](parity-matrix.md), where it lives, and in what order. Flows are in [ui-flows.md](ui-flows.md). Recon and spec only: no code has been written.

## Where things live

| Home | Use it for | Rule |
|---|---|---|
| Hermes native (setting or skill) | Anything Hermes already does: sessions, streaming, cron, heartbeat, memory and its review, approval modes, MCP, TTS/STT | Turn it on and surface it. Do not rebuild it |
| Alan's Plugin | Behaviour that is ours: proactive offers, follow-up bookkeeping, commerce skills, block types | Ships the block definitions and the skills that emit them |
| CU MCP | Acting on a browser or computer, and the safety gates around it | No UI of its own |
| Workspace UI | Bots list, native chat, Canvas tabs, settings, notifications | A thin client. No agent logic, no second copy of state |
| Widget block | Any rich thing inside a thread: cards, Pages, dashboards | One block definition, two renderers: Hermes Desktop (through its plugin SDK) and the native chat |

### The decision that shapes everything: native chat is a thin client

The native chat talks to Hermes's own sessions and API. It is not a forked gateway.

- History and session list: `GET /api/sessions`, `GET /api/sessions/{id}/messages`.
- Sending and streaming: `POST /api/sessions/{id}/chat/stream` (server-sent events for text deltas, tool start and end, run end).
- Side chat: `POST /api/sessions/{id}/fork`.
- Cron tab: `/api/jobs`.
- Feature detection: `GET /v1/capabilities`.
- Multi-profile hosts: the `/p/<profile>/` prefix.

Source: `~/.hermes/hermes-agent/website/docs/user-guide/features/api-server.md` and `developer-guide/programmatic-integration.md` (Hermes 0.23.1). None of these endpoints was called in this recon; shapes are as documented.

**Risk to settle first:** the session stream carries no approval or question frames. Those arrive through the runs API (`/v1/runs` with its approval and clarify calls) or the gateway WebSocket, which needs the client to declare that it handles server requests. The existing native pane already shows approval cards (`desktop/src/hermes-view.js:505`), so `desktop/src/hermes-session-wire.cjs` has one of these paths working today. W1 starts by confirming which, and keeps it.

### One block format for all rich UI

Hermes lets a plugin register a named block: the model writes a directive on its own paragraph, and the registered renderer draws it. Hermes Desktop also renders HTML inline in a sandboxed frame through its built-in preview block (`developer-guide/desktop-plugin-sdk.md:1102-1180`).

- Alan's Plugin registers our block names and ships the Hermes Desktop renderers.
- The native chat implements the same names natively, for speed, and falls back to a sandboxed frame for blocks it does not know.
- A block carries data only (ids, titles, amounts, options). Actions go back as a normal message or an API call. A block never runs code from the model outside the sandbox.

Initial block names: `question`, `approval`, `offer`, `page`, `file`, `product`, `order`, `tracking`, `link`, `chart`.

## W1: chat and Canvas UI

Goal: Alex can use the native chat all day and never needs the webapp or Telegram for a Hermes bot.

| Rows | Build | Home |
|---|---|---|
| 2, 3, 4, 5, 6, 7 | Native chat thread: bubbles, markdown, tables, code, math, send states, one status line while the bot works, composer with lists, quotes and attachments | Workspace |
| 33 | Question, approval and value cards restyled as blocks | Widget |
| 8 | One row per bot; surface switcher in the chat header; explicit link between a Telegram bot and a Hermes profile; unread per bot | Workspace |
| 1 | Spacing pass on the bots list; list adapts to bot count | Workspace |
| 11, 18 | Canvas tab strip takes any number of tabs, including plugin tabs; shortcuts follow strip order; attention dot | Workspace + Plugin |
| 14 | Terminal tab (embed the webapp's terminal first) | Workspace |
| 15 | Side chat tab on a forked session | Workspace |
| 16 | Bot settings tab shell: profile, persona and voice from the shared config | Workspace |
| 17 | Cron jobs tab: list with pause, resume, run now, delete | Workspace |
| 52, 53 | Reply and waiting-for-you notifications; dock badge counting unread bots | Workspace |

Done when:
- The chat-surface benchmark runs and native chat beats the webapp and Telegram on cold open, thread switch and scroll ([chat-surfaces-benchmark.md](chat-surfaces-benchmark.md)).
- A message sent in native chat appears in the webapp for the same session, and the reverse.
- All eight Canvas tab kinds can be shown for a bot, and the active one is restored per bot.

Not in W1: editing cron jobs, permissions rules, Artifacts content, voice.

## W2: proactive offers, follow-ups, learnings

Goal: the bot starts useful work without being asked, never acts without a yes, and the user controls what it remembers.

| Rows | Build | Home |
|---|---|---|
| 20 | Offer block and its three answers; one open offer per bot; "don't offer this again" writes a visible rule | Plugin + Widget |
| 20 | Deliver offers to the Hermes session, not only to Telegram | Plugin |
| 21, 22 | Follow-ups as Hermes jobs tied to a thread; move the plugin's own 60-second loop onto Hermes heartbeat and cron | Hermes + Plugin |
| 17 | Cron jobs tab gains create, edit and a Follow-ups group | Workspace |
| 23 | A handful of starter routines offered at setup | Plugin (skill) |
| 24, 25 | Turn on staged memory writes; review queue and "what this bot knows" in Bot settings; chip under the reply that produced a learning | Hermes + Workspace |
| 19 | Tasks view over Hermes kanban in the Cron jobs tab | Workspace |

Done when:
- An idle bot posts an offer in native chat inside active hours, and each of the three answers does what the flow says.
- A follow-up created in one session fires in that same thread after an app restart.
- Nothing reaches the bot's memory without passing the queue while review is on.

Depends on W1 for the offer block renderer and the Cron jobs tab.

## W3: Pages, Artifacts, docs, decks

Goal: what the bot makes is kept, findable and good-looking, and shopping happens on cards.

| Rows | Build | Home |
|---|---|---|
| 27, 28 | Page block and viewer; in-place edit; "keep up to date" as a cron job; PDF export; share link off by default | Widget + Hermes skill + Workspace |
| 32 | Chart block for dashboards and replies | Widget |
| 29 | Deck skill: look picker, then a presentation file | Hermes skill |
| 30, 31 | Artifacts tab with groups, filters, pins; viewers for PDF, CSV, spreadsheet, text, media, HTML | Workspace |
| 39 | Link block with title, site and status where the site offers one | Widget |
| 34 | Form block with prefill; address lookup; secure field type that never enters the transcript | Widget |
| 35, 36, 37 | Product, order and tracking blocks; order states including expiry and re-price; the shopping skill emits them | Widget + Plugin + CU MCP |
| 38, 40 | Travel cards and connector apps as blocks | Widget |

Done when:
- A Page survives an app restart, can be edited by both sides, and exports to PDF.
- An order cannot be paid except by pressing Pay on its card, proven by a test where the bot tries to submit a checkout directly and the commit gate stops it.
- Every file the bot sent in the last week is reachable from the Artifacts tab in two clicks.

Order within W3: Pages and Artifacts first, commerce cards second, travel cards last. Travel cards are the lowest-value rows in the matrix for a small group and can be dropped without hurting anything else.

## W4: connectors UI and smarter approvals

Goal: connecting an app takes one minute, and the bot asks only when it should.

| Rows | Build | Home |
|---|---|---|
| 41, 42 | Connections section: connected apps, catalogue, detail view, custom MCP form; new custom servers start untrusted | Workspace over Hermes MCP config |
| 44 | Approval block upgrades: reason line, 30-minute expiry, "always allow in future" on expired cards | Widget |
| 45 | Permissions page with two rule lists; add and edit from a card | Workspace over Hermes approval settings |
| 46 | Default to Hermes smart mode; confirm it works on the path native chat uses | Hermes |
| 26 | Rule-change proposal card with a before and after | Widget |
| 48 | Draft block for outgoing email: Send, Edit, Discard | Widget |
| 43 | Saved logins through Hermes's own secret handling or a password manager. **Do not build a card vault.** Payment cards stay with the store or a wallet | Hermes |

Done when:
- Connecting, breaking and reconnecting one real app works end to end from Bot settings.
- A repeated action asks once, "Always allow" stops the second ask, and the rule shows in Permissions.
- An unanswered approval expires and the bot stays stopped.

Row 47 (per-computer permission) is already in place and only needs to be shown in the Permissions page.

## W5: voice and polish

| Rows | Build | Home |
|---|---|---|
| 49 | Voice menu: voice cards with samples, speed slider 0.5× to 2×, saved per bot in the shared config | Workspace + Hermes TTS settings |
| 50 | Desktop voice call reusing the mobile call's turn-taking; reconnect, mic choice, mute | Workspace |
| 51 | Dictation with live words; voice memo bubble with transcript | Workspace + Hermes STT |
| 9 | Search palette over bots, tabs, settings, jobs, then messages | Workspace |
| 10 | Pop-out chat window for one bot | Workspace |
| 54 | Personal usage view if Hermes exposes usage per session (not verified) | Workspace |
| 57 | Per-bot accent colour | Workspace |

Done when the speed setting changes playback in both read-aloud and calls, and persists across restarts and devices.

The same shared config feeds the iOS app, so the voice and speed choice follows the bot to the phone.

## iOS

The iOS app is a native Telegram client today (`ios/AlanWorkspace/Telegram/TelegramStore.swift`). The native chat arrives there after W1 by pointing a second store at the same Hermes sessions API. Blocks render from the same definitions. Nothing in W1 to W5 should put chat logic in the desktop renderer that iOS would have to copy; keep it in the API client and the block definitions.

## Risks and open decisions

| # | Item | Why it matters | Proposed answer |
|---|---|---|---|
| 1 | Approval and question frames are not in the session stream | Native chat could miss approvals | First W1 task: confirm the path `hermes-session-wire.cjs` uses today and keep it |
| 2 | Native pane versus embedded webapp | `docs/design/hermes-webapp-embed.md` plans to delete the native pane if the webapp wins. This spec assumes the opposite | Decide now: native chat is the product, the webapp is the fallback. Update that doc |
| 3 | Reaching the Hermes API from the Mac | The benchmark could not run because no tunnel was up. Native chat needs the same path | Finish the Tailscale Serve sign-in design (`docs/design/webapp-signin-tailscale.md`) before W1 ships |
| 4 | Telegram and Hermes identity | One row per bot needs to know which Telegram bot is which Hermes profile | Explicit user link, stored locally. No name matching |
| 5 | Payments | Order cards touch money | Pay is always a click on the card; commit gate stays; no stored card numbers |
| 6 | Depth of the Grok Bot evidence | REA proved which features ship, not how they behave; behaviour is from the public changelog | Good enough for a spec of our own design. If exact behaviour of one feature matters, do a runtime observation of that feature only |
| 7 | Plugin proactivity is tied to Telegram state | Offers need to reach native chat | W2 moves delivery to the Hermes session and keeps Telegram as a second channel |

## Top gaps by user value

1. Native chat that renders real replies (markdown, tables, cards) on Hermes sessions. Rows 2 to 7.
2. One inbox: one row per bot across Telegram, webapp and native. Row 8.
3. Canvas tabs beyond Browser and Bot screen: Terminal, Side chat, Settings, Artifacts, Cron. Rows 14 to 18.
4. Proactive offers in chat with a clear yes or no. Row 20.
5. Follow-ups and routines with a visible list. Rows 17, 21, 22.
6. Approvals that ask less and explain themselves, with editable rules. Rows 44 to 46.
7. Pages and the Artifacts tab. Rows 27, 28, 30.
8. Learnings review and a view of what the bot knows. Rows 24, 25.
9. Reply and waiting-for-you notifications with a dock badge. Rows 52, 53.
10. Voice menu with speed, and desktop calls. Rows 49, 50.

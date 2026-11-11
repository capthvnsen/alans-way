# UI flows for Alan's Way

Target layout and the flows each wave must deliver. Everything here is written from our own description of features; nothing is copied from Grok Bot. Row numbers refer to [parity-matrix.md](parity-matrix.md).

## Layout

```
┌──────────┬───────────────────────────────┬──────────────────────────────┐
│ Bots     │ Chat                          │ Canvas                       │
│          │                               │ [Browser][Bot screen][Term]  │
│ ● Alan   │   bubble                      │ [Side chat][Settings]        │
│ ○ Hermes │            bubble             │ [Artifacts][Cron][plugin…]   │
│ ○ Orgo   │   card / widget               │                              │
│          │                               │  (content of the active tab, │
│ + New    │ ┌───────────────────────────┐ │   for the selected bot)      │
│          │ │ composer            mic ▶ │ │                              │
└──────────┴─┴───────────────────────────┴─┴──────────────────────────────┘
```

- **Left, bots list.** As today, with more vertical spacing. One row per bot, not per surface. The row shows avatar, name, last-message preview, unread dot, and a live activity line while the bot works (kept from `desktop/src/activity.cjs`).
- **Middle, chat.** Feels like a messaging app, not an IDE: bubbles, generous line height, no chrome between messages, cards inline.
- **Right, Canvas.** A split pane with a tab strip. It always shows the selected bot. The active tab is remembered per bot (already true for the first two tabs, `desktop/src/main.cjs:383-406`).

Collapsing rules stay as today: the list and the Canvas can each be hidden; the chat never is.

## One inbox, three surfaces

One bot row can be reached through up to three surfaces. The row is the bot; the surface is a property of the conversation.

| Surface | What it is | Used when |
|---|---|---|
| Native chat | Thin client on Hermes sessions and its API. Same sessions as every other Hermes client | Default for any bot that exposes the Hermes API. Must be the fastest surface |
| Hermes webapp | The embedded Hermes Desktop webapp (`docs/design/hermes-webapp-embed.md`) | Fallback and for features the native chat has not reached yet |
| Telegram | Embedded Telegram web client | Bots that are only on Telegram, and as the mobile path until the iOS native chat ships |

Rules:

1. A surface switcher sits in the chat header (three small segments, only the ones the bot supports). The choice is remembered per bot.
2. Unread state is per bot: the row is unread if any surface has unread messages.
3. Switching surface never loses a draft. Each surface keeps its own.
4. Native chat and the webapp show the **same Hermes session**, so a message sent in one appears in the other. Telegram is a separate transport into the same agent; the inbox does not try to merge its history into the Hermes session list.
5. The current hub rule that a Telegram bot is never mapped onto a Hermes session (`desktop/src/hermes-hub.cjs:11`) changes to an explicit, user-made link: "this Telegram bot and this Hermes profile are the same bot". No guessing by name.

## Chat flows (W1)

### Send and receive

1. User types and presses Enter. The bubble appears as sent immediately.
2. If the server has not acknowledged within 2 s, a thin progress line appears under the bubble. On failure the bubble turns into a recoverable draft with Retry and Edit.
3. The bot's reply streams into one bubble. While tools run, a single status line under the bot's name says what it is doing (from stream events for tool start, tool end and commentary). It does not create extra bubbles.
4. Stop is available for the whole run. Sending a new message while the bot works queues it and keeps the status line visible.

States a message can be in: `sending`, `sent`, `failed` (user), `streaming`, `done`, `stopped`, `failed` (bot).

### Rendering

- Markdown with headings, lists, links, block quotes, code blocks with copy, and math.
- Tables scroll sideways inside the bubble, can expand into the free space beside the column, and have Copy (as markdown) and Full screen.
- Media and files show as attachment chips with a preview. Clicking opens the Artifacts tab on that item.
- A directive block on its own paragraph (Hermes block types) renders as a **card** or **widget**. Unknown block names render as a neutral "unsupported card" with the raw text behind a toggle, never as broken markup.

### Composer

- Enter sends, Shift+Enter breaks the line. A leading dash or number starts a list; a leading `>` starts a quote.
- Drag files in or paste them. Attachments can be reordered and removed before sending.
- Selecting text in any bubble offers "Quote in reply"; the quote links back to the original message.
- Mic button for dictation (W5).

### Cards the chat must render in W1

Only the ones that block basic use:

| Card | Shape | Actions | States |
|---|---|---|---|
| Question | title, one or more questions, options (single or multi), optional free-text | Submit, Skip | open, answered, superseded (the user typed a normal reply instead) |
| Approval | one-sentence ask, "show details" for the full request, which rule caused it | Allow once, Always allow, Deny | open, allowed, denied, expired |
| Value prompt | label and a field (text, secret, choice) | Submit, Cancel | open, submitted, cancelled |

These exist today in the native pane in plain form (`desktop/src/hermes-view.js:444-505`). W1 restyles them as cards; W4 adds the rule wiring.

## Canvas tabs

| Tab | Shows | Source | Wave |
|---|---|---|---|
| Browser | The bot's browser tabs and the user's local tabs | Existing | done |
| Bot screen | Live view of the bot's computer. Opens in Watch; Take control is explicit | Existing | done |
| Terminal | A shell on the bot's machine | Hermes (the webapp already has one); embed first, native later | W1 |
| Side chat | A second conversation with the same bot that does not touch the main thread | Fork of the current Hermes session (`POST /api/sessions/{id}/fork`) | W1 |
| Bot settings | Profile (name, avatar, role), persona and voice, proactivity, permissions summary, notification switch | Shared config (`agents:shared/config.schema.json`) plus Hermes settings | W1 shell, W4 and W5 fill it |
| Artifacts | Everything the bot produced or was sent: Pages, files, links, media | Hermes session files and deliverables | W3 |
| Cron jobs | Scheduled and triggered jobs with Pause, Resume, Run now, Edit, Delete | Hermes jobs API (`/api/jobs`) | W1 list, W2 editing |
| Plugin tabs | Tabs a plugin registers | Hermes plugin pane registration, mirrored into the strip | W1 strip support |

Tab-strip rules: keyboard shortcuts ⌘1…⌘9 follow strip order; tabs a bot cannot support are hidden, not disabled; a tab that needs attention (hand-back, approval waiting) shows a dot.

### Side chat flow

1. User opens Side chat. It starts empty, with a one-line note of which main-thread message it branched from.
2. Messages here go to a forked session. The main thread is not changed and the bot's main run is not interrupted.
3. "Send to main chat" on any side-chat reply quotes it into the main composer.
4. Closing the tab keeps the fork; reopening shows the latest fork for that bot. "New side chat" starts another.

## Proactive offers and follow-ups (W2)

### Offer

1. The bot decides it could take something on (idle check-in, a routine firing, something it noticed in a connected app).
2. It posts an **offer card** in the chat: what it would do, why now, what it needs.
3. Actions: Do it, Not now, Don't offer this again.
4. "Do it" starts a normal run in the same thread. "Not now" snoozes with backoff (the plugin already has backoff up to 7 days, `agents:alans-way/proactivity.py`). "Don't offer this again" writes a rule the user can see and undo in Bot settings.

Limits: at most one open offer per bot; offers respect active hours and time zone from the shared config; an offer never performs an action on its own.

### Follow-up

1. When a run ends with something pending (waiting on a person, a delivery, a build), the bot records a follow-up with a due time.
2. Follow-ups appear in the Cron jobs tab under "Follow-ups" with the thread they belong to.
3. When due, the bot re-enters that thread and reports, or posts an offer card if a decision is needed.
4. The user can cancel or reschedule a follow-up from the tab or from the message that created it.

### Learnings review

1. With review on, anything the bot wants to remember is staged, not saved.
2. A small "1 thing to remember" chip appears under the reply that produced it. Bot settings shows the full queue.
3. Each item: the text, where it came from, Approve, Edit, Discard.
4. Approved items appear under "What this bot knows", where they stay editable and deletable.

Default: review **on** for new bots, with an "approve automatically" switch for people who do not want the queue.

## Pages and Artifacts (W3)

### Page

A Page is a document the bot builds and keeps: a report, a memo, a dashboard.

1. The bot creates a Page. The chat shows a **page card**: title, a small preview, Open.
2. Open shows it in the Artifacts tab, full height. Wide screens can pop it to a window.
3. The user can edit text in place or ask the bot in chat to change it. Bot edits show a brief "updated" marker and are undoable for the session.
4. A Page can be marked "keep up to date", which creates a cron job that re-runs the data step and rewrites the page.
5. Page chrome: rename by clicking the title, find, light/dark, Download PDF, Share link (friends only; off by default).

### Decks

1. User asks for slides. The bot first shows two or three sample looks as a small picker card.
2. After a pick, it builds the deck and posts a file card with a slide-by-slide preview in the Artifacts tab.
3. Delivery is a presentation file. No hosted deck editor.

### Artifacts tab

- Groups: Pinned, then Today, This week, Older.
- Filters: All, Pages, Media, Links, Files.
- Row hover shows a preview and where it came from. Click opens a viewer: PDF, CSV and spreadsheet (select and copy cells), text, images, video, HTML with a source toggle.
- Pin and unpin from the row.

### Commerce cards

| Card | Shape | Actions | States |
|---|---|---|---|
| Product | photo, name, price, store, rating, up to two short labels; shown as a row of a few options | Choose, Open in Browser tab | shown, chosen |
| Order | items, ship-to if anything ships, total, payment method | Pay (always a deliberate click), Change, Cancel | ready, paying, submitted, confirmed, failed, expired |
| Order expired | same summary, greyed | Check price again (asks the bot for a fresh card) | expired |
| Tracking | carrier, stage, expected date | Open | in transit, delivered, problem |

The order card is the only place a purchase can be approved. The bot never fills in payment before Pay is pressed, and the browser commit gate (`agents:alans-way/scripts/workspace-router.cjs:935-954`) stays on underneath as a second check.

## Connectors and approvals (W4)

### Connect apps

1. Bot settings has a Connections section: connected apps first, then a catalogue with categories and a short recommended list.
2. Connecting an app opens its sign-in in the Browser tab or the system browser, then returns to a detail view: what the bot can read, what it can change, Disconnect.
3. "Add custom" takes an MCP server address or command and a name. New custom servers start untrusted: every tool call asks until the user trusts them.
4. If a connection breaks, the bot says so in chat with a Reconnect action.

### Approvals

1. The bot hits something that needs a yes. An approval card appears in chat, one sentence long.
2. The card says why it is asking: a rule the user made, the default for this kind of action, or an untrusted connector.
3. Allow once runs it. Always allow runs it and adds a rule, shown on the card with "Edit rule". Deny stops the bot until the user's next message.
4. A card that is not answered expires after 30 minutes and offers "Always allow this in future" so the user can prevent the repeat.
5. Permissions page in Bot settings: two lists, "Always ask" and "Allow without asking", each with Add rule. Rules are plain sentences plus the matching pattern.
6. "Smart" mode (Hermes native) is the default: actions that are already covered by a rule or by the request itself do not ask.

Approvals also raise a dot on the bot row and a desktop notification, so a waiting bot is never silent.

## Voice (W5)

1. The mic button in the composer starts dictation. Words appear live. Enter sends as text; a long-press sends the recording as a voice memo bubble with a transcript.
2. The speaker icon in the chat header opens the **Voice menu**: one card per voice with a play-sample button, and a speed slider from 0.5× to 2×. Both are saved per bot.
3. Call starts a hands-free voice conversation. Call settings show the same voice cards and slider, plus microphone choice and mute. The call reconnects on a network drop.
4. Replies are read aloud only during a call or when the user presses play on a bubble.

## Notifications

- A desktop notification for each bot reply when the window is not focused on that bot. It clears when the reply is read anywhere.
- A notification when a bot is waiting for the user (approval, question, hand-back). These are never suppressed by focus rules.
- Dock badge counts bots with unread messages, not messages. Muted bots do not count.
- Per-bot switch in Bot settings: All, Only when waiting for me, Off.

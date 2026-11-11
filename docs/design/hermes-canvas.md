# Hermes Canvas

Status: phase 2, 2026-11-11. Builds on the Chat surface setting ([hermes-webapp-embed.md](hermes-webapp-embed.md)).

## Shape

Three columns, closer to iMessage than to an IDE:

| Left | Middle | Right: Canvas |
|---|---|---|
| Bots list (unchanged) | Chat: Telegram or Hermes Desktop (unchanged) | One thing at a time, picked from a small pill of tabs |

The Canvas follows the bot whose chat is open. Each bot remembers its own tab, so
switching from Alan (watching his screen) to Scout (browsing) and back puts each
one where you left it.

## Phase 1 (this change)

- **Tabs:** `Browser` and `Bot screen`. Both reuse what exists: Browser is the
  existing browser pane; Bot screen is the existing VM live view, the same view the
  expand button and the floating preview use (`activeTabId === 'vps'` in main).
- **Memory:** `prefs.canvasTabs[botId]` is `'browser'` or `'screen'`. It is written
  whenever you switch and when you leave a bot, and read when you select a bot
  and at launch. A bot with no saved choice keeps the current view.
- **Keyboard:** ⌘1 / ⌘2 (Ctrl on Windows and Linux) from anywhere, through the View menu,
  so they work while Telegram or a web page has focus. On the strip itself, ← → Home End
  move between tabs (roving tabindex, ARIA `tablist`). Both are listed in the Shortcuts sheet.
- **Placement:** left end of the existing browser tab bar. No new row.
- The expand button stays: it is the one control still on screen when the
  browser pane is collapsed.

## Phase 2: state and Hermes Desktop pages

- **State:** main holds `canvasTab` (`browser`, `screen`, `chat`, `artifacts`, `cron`,
  `settings`). `activeTabId` is now only the browser's own tab, so Bot screen no longer
  overwrites it and `browserReturnTabId` is gone. The renderer still receives
  `activeTabId: 'vps'` for Bot screen (wire compatibility for `remote.js` and the
  existing tests), plus `canvasTab` and `webappCanvas`.
- **Collapsed pane:** choosing any Canvas tab (⌘1–⌘6, the strip, the expand button)
  reopens a collapsed browser pane.
- **New tabs:** Side chat, Artifacts, Cron jobs and Bot settings are the Hermes Desktop
  routes `#/`, `#/artifacts`, `#/cron` and `#/settings` (Hermes Desktop uses a
  HashRouter; see `apps/desktop/src/app/routes.ts`). One `canvasView` serves all four, so
  switching between them is an in-page hash change, not a reload. It is built by the same
  `guardedWebappView()` as the chat pane's view: no preload, sandboxed, same-origin only,
  partition `persist:hermes-webapp`. Sharing that partition is what lets one cookie
  sign-in cover both views. Picking a page tab always reopens its page, because Hermes
  Desktop closes its Cron and Settings overlays by navigating.
- **When they show:** only while a Hermes Desktop address is set, reachable, and signs
  in with cookies (gated mode). A one-use-link host (private mode) gets no page tabs:
  its credential lives in the chat view's `sessionStorage` and cannot reach a second view.
  If Hermes Desktop becomes unavailable, the Canvas shows Browser but keeps the saved
  choice and returns to it when Hermes Desktop comes back.
- **Per bot:** the choice is remembered per bot like the others, but the pages are the
  one configured Hermes Desktop host, not a per-bot profile. Mapping a bot to a Hermes
  profile is not done.
- **Keyboard:** ⌘3–⌘6 in the View menu, listed in the Shortcuts sheet as one row.
  Arrow keys, Home and End move across the visible tabs only.

## Not built

- **Terminal.** Hermes Desktop's terminal lives in its right sidebar with no route to
  open it, and a native terminal here would need a pty dependency and a shell-access
  design of its own.
- **Plugin tabs.** Need a manifest (id, label, URL) and the same no-preload,
  own-partition treatment as the Webapp view.

Do not add a tab until it does something; empty placeholder tabs make the strip worse.

## Tests

`npm run test:canvas-tabs` drives the real main, preload and renderer. It covers
restore at launch, click, per-bot memory across bot switches, arrow keys, Home and End,
⌘1–⌘6 through the menu, the collapsed pane, the saved preferences, and the Hermes
Desktop pages against a local stand-in: hidden without an address, shared cookie
sign-in, no Workspace bridge, no reload between pages, fallback while unreachable,
and no page tabs for a one-use-link host. Set `CANVAS_SHOTS=<dir>` to save
screenshots at 1440 and 1120 px.

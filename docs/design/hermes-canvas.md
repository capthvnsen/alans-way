# Hermes Canvas

Status: phase 1, 2026-11-10. Builds on the Chat surface setting ([hermes-webapp-embed.md](hermes-webapp-embed.md)).

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

## Later tabs

Terminal, Side chat, Bot settings, Artifacts, Cron jobs, and tabs defined by plugins.
Each one is a button in `#canvas-tabs` plus a branch in `showCanvas()`. Do not add a
tab until it does something; empty placeholder tabs make the strip worse.

Before the third tab lands, `activeTabId === 'vps'` should become an explicit
`canvasTab` in main state. Two tabs fit the current model; four would not.
Plugin tabs need a manifest (id, label, URL) and the same no-preload, own-partition
treatment as the Webapp view.

## Tests

`npm run test:canvas-tabs` drives the real main, preload and renderer. It covers
restore at launch, click, per-bot memory across bot switches, arrow keys and Home,
⌘1/⌘2 through the menu, and the saved preferences. Set `CANVAS_SHOTS=<dir>` to save
screenshots at 1440 and 1120 px.

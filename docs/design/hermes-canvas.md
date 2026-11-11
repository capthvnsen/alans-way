# Hermes Canvas

Status: phase 3, 2026-11-11. Builds on the Chat surface setting ([hermes-webapp-embed.md](hermes-webapp-embed.md)).

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
- **Collapsed pane:** choosing any Canvas tab (⌘1–⌘7, the strip, the expand button)
  reopens a collapsed browser pane.
- **New tabs:** Side chat, Artifacts, Cron jobs and Bot settings are the Hermes Desktop
  routes `#/`, `#/artifacts`, `#/cron` and `#/settings` (Hermes Desktop uses a
  HashRouter; see `apps/desktop/src/app/routes.ts`). One `canvasView` serves all four, so
  switching between them is an in-page hash change, not a reload. It is built by the same
  `guardedWebappView()` as the chat pane's view: no preload, sandboxed, same-origin only,
  partition `persist:hermes-webapp`. Sharing that partition is what lets one cookie
  sign-in cover both views. Picking a page tab always reopens its page, because Hermes
  Desktop closes its Cron and Settings overlays by navigating.
- **When they show:** while a Hermes Desktop address is set, reachable, and either signs
  in with cookies (gated mode) or is a no-sign-in host (private mode: `auth_required: false`,
  e.g. an SSH tunnel to `127.0.0.1`) whose one-use link is already open in the chat view.
  A private host keeps its credential in the chat view's `sessionStorage` and answers 401 on
  `/api` without it, so before the link is pasted it gets no page tabs. After that, main
  copies the `hermes.webapp.session.v1:*` entries (43-character tokens only) into the Canvas
  view's `sessionStorage` on the host's credential-free `/webapp/launch` page, then loads the
  page. Same origin, same partition, still no bridge. The link is needed again after every
  Workspace restart, as for the chat view. If Hermes Desktop becomes unavailable, the Canvas shows Browser but keeps the saved
  choice and returns to it when Hermes Desktop comes back.
- **Per bot:** the choice is remembered per bot like the others, but the pages are the
  one configured Hermes Desktop host, not a per-bot profile. Mapping a bot to a Hermes
  profile is not done.
- **Keyboard:** ⌘4–⌘7 in the View menu, listed in the Shortcuts sheet as one row.
  Arrow keys, Home and End move across the visible tabs only.

## Terminal

Strip order is Browser, Bot screen, Terminal, Side chat, Artifacts, Cron jobs, Bot settings
(⌘1–⌘7). Terminal is always shown. Hermes Desktop has no route that opens its terminal (its
terminal is a pane toggled by app state, not a `#/` route), so this one is native.

- **Renderer:** xterm.js (`@xterm/xterm`, `@xterm/addon-fit`, pure JS) in the Canvas area, one
  instance per bot, kept hidden when not shown so scrollback survives tab and bot switches.
  The tab is remembered per bot in `prefs.canvasTabs` like the others; a restored Terminal tab
  shows a **Start terminal** button and starts nothing.
- **Main (`src/terminal.cjs`):** one child per bot, and no pty library. `script` supplies the
  pty (macOS: `script -q /dev/null …`; Linux: `script -qfc … /dev/null`), fed through `cat`
  because macOS `script` refuses the socket Node gives it. Where the app has a saved agent
  server (`vpsBrowser.sshHost`), the program is `ssh -tt <TAILNET_SSH_OPTIONS> … -- <host>`
  so the server allocates the pty; otherwise it is the user's login shell (`$SHELL -l`,
  only if it is a plain absolute path, else `/bin/sh`). Windows shows "Terminal is not
  available on Windows yet." Every bot uses the same server: there is no per-bot host today.
- **Size:** set at start and on every fit by changing the pty's window size from outside
  (`stty -f <tty>` on the tty path the shell reports on fd 3). The shell sees SIGWINCH and
  nothing is typed into it, so a running program is not disturbed.

Safety rules:

1. The shell starts only from a user click (the Terminal tab or **Start terminal**) or its
   shortcut (⌘3 / Ctrl+3). Arrow keys over the strip, restoring a saved tab, switching bots
   and launching never start one.
2. Nothing a bot or the web can reach can open, write to or read it. The only way in is four
   IPC channels (`terminal:start`, `terminal:input`, `terminal:resize`, `terminal:kill`),
   served only to the Workspace window (the VM view shares the preload and is refused).
   `browser-mcp.cjs`, the local API and `workspace:command` have no terminal call, and
   Computer Use already refuses this app's own window.
3. No command is built from bot or web text. The programs and the inner script are fixed;
   size, shell and host go in as separate arguments. The host must pass `isSshTarget` (plain
   `[user@]host`, never leading `-`) and follows `--`.
4. One shell per bot. It is killed when its bot is removed from the bot list, when the shell
   exits, and when the app quits or exits.

## Not built

- **Plugin tabs.** Need a manifest (id, label, URL) and the same no-preload,
  own-partition treatment as the Webapp view.

Do not add a tab until it does something; empty placeholder tabs make the strip worse.

## Tests

`npm run test:canvas-tabs` drives the real main, preload and renderer. It covers
restore at launch, click, per-bot memory across bot switches, arrow keys, Home and End,
⌘1–⌘7 through the menu, the collapsed pane, the saved preferences, and the Hermes
Desktop pages against a local stand-in: hidden without an address, shared cookie
sign-in, no Workspace bridge, no reload between pages, fallback while unreachable,
and, for a one-use-link host, no page tabs until the link is open and then a shared credential.
`npm run test:terminal-tab` runs a real shell: arrow keys and restore start nothing, the tab click
does, `echo canvas-$((6*7))` prints `canvas-42`, output survives switching tabs and bots, and shells are
per bot. `test/terminal.test.cjs` covers the command builder (ssh, local, Windows, bad addresses). Set `CANVAS_SHOTS=<dir>` to save
screenshots at 1440 and 1120 px.

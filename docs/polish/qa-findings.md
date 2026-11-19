# QA findings: Alan's Workspace polish pass (week 1)

Checked 2026-11-11 on branch `agent/w1-polish` (the six merged draft PRs plus the fixes below).

## How the sweep was run

- **Two passes.** The first pass ran as two QA agents in parallel: one on the chat side (bots
  list, chat header, native chat), one on everything else (Canvas, Settings, sign-in, footer).
  Both were cut off before they wrote their findings or finished their checklists. Their fixes
  (C-01 to C-15, V-01 to V-09) were merged as they were. A second run then checked the merge,
  finished the sweep and wrote this file. The second run's fixes are C-16, C-17 and V-10 to V-14.
- **People we played.** The owner on a first run with nothing set up. The owner on a normal day:
  four Telegram bots (one with a long name), two of them with unread messages, Alan and Mira on
  native chat, Scout and Juniper on Hermes Desktop, an approval waiting, a long thread. A keyboard
  user who never touches the mouse.
- **Window sizes.** 1120×720 (the smallest window) and 1550×980. The chat pane was also dragged
  to its narrowest (320 px) and widest.
- **Tools.** The real app from this checkout, driven by a small script that runs JavaScript in
  the app and takes window screenshots. Every launch used a throwaway profile, a temporary home
  folder and a fake keychain, never your real profile. A contrast checker measured every visible
  piece of text against the WCAG AA rule and the 11 px floor, in every state we visited.
  Keyboard checks used real key presses sent to the window.
- **Real vs stand-in.**
  - Telegram: a blank local stand-in page. No real Telegram was opened.
  - Native chat: the in-repo mock, which replays answers recorded from a real Hermes 0.23.1. We
    stopped and restarted it to test "server down" and used a wrong key to test 401.
  - 1,000-message thread: a real local Hermes lab (read only, nothing sent). It opened in 54 ms
    and scrolled 240 frames with the slowest frame at 9 ms.
  - Hermes Desktop: two small stand-ins, one with a password sign-in and one with no sign-in
    (the one-use-link case). The address stand-in for "can't reach" was a closed port.
  - Terminal: a local shell on this Mac. No SSH.
  - Your real bot, your real servers and your real key file were never touched.
- **Mock quirks, not app bugs.** The mock sends no keep-alive while an approval waits, so an
  approval left open for 45 s ends with "The connection dropped". Real Hermes sends keep-alives.
  The mock's "long reply" recording ends as a stopped reply, so it always says "Stopped.". A
  mock restart forgets every conversation, which is how we found C-17.

## Findings, worst first

Severity: **P0** broken, **P1** bug, **P2** papercut, **P3** nit.

| Id | Sev | Area | What was wrong | Fix |
|---|---|---|---|---|
| C-16 | P1 | Chat header | A long bot name slid the name pill under the agent-list button; with the agent list hidden, the window's red, yellow and green buttons sat on top of the name. | `c5567f4` |
| C-01 | P1 | Native chat | The message box was 8 px tall the first time native chat appeared, so you could not see what you typed. | `abb803e` |
| C-02 | P1 | Native chat | Some conversations opened at their oldest message instead of the newest. | `84a227e` |
| C-07 | P1 | Native chat | If sending your approval answer failed, the button you pressed stayed dead; the only way out was Stop. | `3b4c0ce` |
| C-09 | P1 | Native chat | The conversation menu could not be used from the keyboard: no focus, no arrow keys, and it redrew under your cursor. | `d9af3a1` |
| SC-1 | P1 | Native chat | Writing into a Hermes Desktop conversation failed with a bare "server error". Native chat now writes to the shared Bot Chat and says plainly when Hermes refuses. | `bf0eb16` |
| C-17 | P2 | Native chat | Sending into a conversation that was deleted in Hermes put "Session not found" over the whole pane as if the connection had failed. | `c996871` |
| V-13 | P2 | Settings | Typing a Hermes Desktop or native chat address and pressing Escape threw the edit away without a word. | `393c1cb` |
| V-10 | P2 | Browser home | The home page said "Alan's chat is still connecting" (it only looked at Telegram) while native chat was working right next to it. | `7be7e2d` |
| V-14 | P2 | Hermes Desktop | The box for the one-use link was a bare grey browser input, a third of the pane wide, with its example cut off. | `2268196` |
| C-03 | P2 | Bots list | A bot without a picture showed dark initials on a dark circle. | `ef69f4b` |
| C-04 | P2 | Bots list, chat | Captions, activity lines, badges and native chat labels were 8.5–10.5 px, and several greys failed contrast. | `bb9926b`, `2a616b3` |
| C-05 | P2 | Bots list | Rows were cramped (you asked for more spacing). | `53800f9` |
| C-06 | P2 | Native chat | The status line said "Running a command" while Alan was actually waiting for your answer. | `a11f145` |
| C-10 | P2 | Native chat | Escape did nothing in an open "Show details", and closing the menu also triggered the window's Escape. | `eedba0d` |
| C-12 | P2 | Native chat | Arabic or Hebrew messages and drafts were laid out left to right. | `0bea00a` |
| C-14 | P2 | Native chat | Opening a conversation deleted in Hermes showed the raw "Session not found" for the whole pane, even after moving on. | `a8a5e13` |
| V-01 | P2 | Terminal | When the shell ended or SSH failed, the tab jumped back to Start and hid the error. | `7e0b3cd` |
| V-02 | P2 | Terminal | Clicking the Terminal tab or ⌘3 did not put the cursor in the terminal, so typing went nowhere. | `48e09e8` |
| V-03 | P2 | Terminal | The floating "VPS" chip covered the last line of the terminal. | `606b61d` |
| V-04 | P2 | Bot screen | With no VM set up it still said "click Take control" under a disabled button. | `2ca63ff` |
| V-05 | P2 | Bot screen | At the smallest window, Take control was 9 px and the hint 8 px in low-contrast grey. | `0809806` |
| V-06 | P2 | Settings | Chat surface settings mentioned a "left pane", listed two of three surfaces, ran two surfaces together without headings, and told you to go to the section you were in. | `ddb997f` |
| V-08 | P2 | Canvas, Settings | 31 text styles outside the chat (footer, badges, Shortcuts sheet, Settings labels, downloads, onboarding) were 8.5–10 px. | `e737481` |
| V-09 | P2 | Canvas, Settings | Hint text in the Canvas, Settings, onboarding and footer failed contrast. | `d8bb6d8` |
| V-11 | P3 | Settings | "Import saved key" sat after Save and Test, so it read like a separate step. It now sits under the API key box. | `b7669ba` |
| V-12 | P3 | Shortcuts sheet | "Open focused agent" said it opens the bot's Telegram chat; it opens whichever surface the bot uses. | `f9e71ef` |
| C-08 | P3 | Native chat | Error notices started with "ApiError:". | `f293f99` |
| C-11 | P3 | Native chat | "No messages yet. Say hello." showed above an approval card. | `f5faf3c` |
| C-13 | P3 | Chat header | Tab went right, then back left, then down. | `5485fce` |
| C-15 | P3 | Native chat | The conversation switcher's focus ring was cut off at the top. | `f6e191b` |
| V-07 | P3 | Settings | A refused Hermes Desktop sign-in was said twice. | `a235bf4` |
| O-1 | P2 | Terminal | A new shell starts at 80 columns and is resized a moment later, so the first line shows a stray "%" and anything printed at login (an SSH welcome banner) wraps at the wrong width. Fix: start the shell at the pane's real size. | Open |
| O-2 | P3 | Canvas | At 1120 px the Canvas tab strip cuts its last visible tab mid-word ("Side ch") with no sign that it scrolls. It does scroll, and the selected tab is always shown. | Open |
| O-3 | P3 | Native chat | Pressing Enter while Alan is still replying does nothing; your text waits in the box with no hint why. | Open |
| O-4 | P3 | Shortcuts sheet | Not listed: ← → Home End in the chat surface switch and the Canvas tabs, Esc to close the conversation menu, Enter / Shift+Enter in native chat. All of these work. | Open |
| O-5 | P3 | Native chat | In the conversation menu, chats made in this app are labelled "Here", which is vague. | Open |
| O-6 | P3 | Native chat | The message box shows focus only with a faint border change, unlike the blue ring elsewhere. The blinking cursor still shows where you are. | Open |
| O-7 | P3 | Native chat | Widgets always get a 260 px tall frame, so a short widget leaves an empty box. | Open |
| O-8 | P3 | Hermes Desktop | If the Hermes Desktop address is removed, a bot set to Hermes Desktop shows the "no address yet" page while no segment in the switch is selected. | Open |

**Totals:** 40 findings. P0: 0. P1: 6 (6 fixed). P2: 20 (19 fixed, 1 open). P3: 14 (7 fixed, 7 open).
Fixed: 32. Open: 8.

Not a finding but on this branch: `69d3740` adds the one-time "Import saved key" button in
Settings → Chat surface. Checked: it shows only when a key file is waiting, imports it, deletes
the file and runs Test.

### Checked and fine

- The chat surface switch and the Canvas tab strip match exactly: strip 31.5 px tall with a 3 px
  inset and 1 px border, segments 23.5 px, fully rounded, 11.5 px text, selected segment
  `#2e2e33` with a soft shadow and near-white text. No change was needed.
- Unread dots and the "waiting for you" badge appear and clear. One notification per waiting
  episode: two episodes gave exactly two notifications, and switching bots did not repeat one.
- Native chat: long links, long words and inline code wrap inside the bubble; wide tables and
  code scroll inside their box. The view stays pinned to the bottom while a reply streams and
  does not pull you down after you scroll up. A draft survives switching bots and surfaces.
  Stop works mid-reply and puts the cursor back in the box. Server down shows "Not sent. Retry";
  a wrong key says "Hermes refused the API key; check it in Settings" and recovers when fixed.
  Switching surface mid-reply does not lose the reply. Quitting and reopening brings back the
  same bot, surface, conversation and Canvas tab.
- Keyboard: Tab goes agent list → chat header → chat → Canvas → footer and around again, with a
  visible ring on every control except the message box (O-6). Arrow keys, Home and End work in
  both segmented controls and the agent list; Enter opens the focused agent. Escape closes only
  the topmost thing, and focus goes back to the button that opened it.
- macOS set to light mode: the app stays dark, including its drop-downs. No white areas in the
  screenshots (the switch itself was not filmed, so a one-frame flash would not show).
- Reduced motion: the only new animation (the typing dots) stops.
- After the fixes, the contrast checker finds no text under 11 px or under AA anywhere we went.
  It still flags three icons (the search glass, an arrow, the menu caret) at 3.2–4.4:1, which
  passes the 3:1 rule for icons.

## Needs Alex's call

1. **There is no light theme.** The app is dark only and ignores macOS light mode. *Recommend:*
   keep dark only for now; it is consistent and readable.
2. **Telegram conversations cannot be written from native chat or Hermes Desktop.** This is a
   Hermes rule, not ours (`docs/polish/same-conversation.md`). *Recommend:* keep Telegram
   conversations read-only in native chat, with "Continue here" to copy one over.
3. **Only the Bot Chat and chats made in native chat are shared with Hermes Desktop.** Other
   Hermes Desktop chats are read-only from native chat until Hermes changes upstream (described
   in the same doc). *Recommend:* ask for the upstream change only if you miss it in daily use.
4. **The older "HERMES" section at the bottom of the agent list** (the gateway connection) now
   does what native chat does. *Recommend:* retire it once you have used native chat for a week.
5. **Hermes Desktop pages in the Canvas need a new one-use link after every restart** on a
   Hermes with no sign-in. *Recommend:* set up the username and password sign-in
   (`scripts/webapp-signin.sh`) so it never asks.
6. **The Terminal tab opens a real shell on the bot's machine.** It only starts when you click
   it or press ⌘3. It has not been tried over SSH. *Recommend:* try it once on your VM before
   giving it to friends.
7. **Sending while Alan is still replying** (O-3). *Recommend:* allow it and send the message
   right after the reply ends, so you can type ahead like in a messaging app.
8. **What to call chats made in this app** (O-5). *Recommend:* "This app" instead of "Here".

## Not checked

- A real Telegram session (only a blank stand-in page was used).
- A real Hermes Desktop (only stand-ins), and a real Bot Chat shared live between native chat
  and Hermes Desktop in this pass (the earlier pass checked it against a lab; see
  `same-conversation.md`).
- The Terminal over SSH to a real VM, and the Bot screen with a real VM connected.
- Windows and Linux.
- The packaged app: `desktop/dist/mac-arm64/*.app` is not in this checkout, so it was not
  rebuilt. An earlier `--dir` package build exited 0 (`/tmp/polish-proof/package-build.log`);
  whether that built app was ever opened is unknown.
- VoiceOver or any other screen reader.
- Sending messages to the real 1,000-message lab conversation (it was only opened and scrolled).

## Automated tests after the fixes

`npm run check`: 1824 tests, 1785 pass, 0 fail (the rest are skipped on this Mac). Also passing:
native chat, surface toggle, Canvas tabs, Terminal tab, Hermes Desktop embed, Telegram open,
needs-human, agent input, auto-takeover, settings navigation, keyboard navigation, the four
first-run layout tests, the unit tests with `HERMES_WORKSPACE_REQUIRE_TAILNET=1`, and the
publication check.

`test:shortcut-reference` fails ("agent-dispatched settings and browser keys…", 2 tabs where 1
was expected). It already failed on untouched `main` before this work (seen in an earlier run;
not re-run on `main` here), its test file is unchanged since `main`, and CI does not run it (`.github/workflows/tests.yml` runs
`shortcut-query` and `shortcut-round2` only). It needs its own look.

## Screenshots

Before and after screenshots for every fix (`C-07-before.png`, `V-13-after.png`, …) and the
final set (`final-<screen>-<width>.png`) are in `/tmp/polish-proof/` on your Mac. They are not in
the repo. The scripts that drove the app are next to them in `tools/`, `tools-canvas/` and
`tools-final/`.

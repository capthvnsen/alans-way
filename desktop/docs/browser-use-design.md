# Browser use: design and measurements

Written 2026-10-12 for the bots' browser tabs: the app's own Chromium tabs on
the user's computer (host tabs, driven over the debugger by `src/main.cjs`)
and the VM's Chromium (`scripts/vps-browser-host.cjs`). Both run the same page
code (`src/browser-page.cjs`, `src/agent-input.cjs`), so every change here
lands on both. Numbers are from a MacBook on macOS 27.0.1. The method is the
one `host-computer-use-design.md` used for desktop apps: observe cheaply,
target by element, batch, verify inside the reply, send deltas, and make each
error say the next step.

## ChatGPT's browser agent, October 2026

Researched 2026-10-12 from OpenAI's help center, learn.chatgpt.com, OpenAI
launch posts and reviews. OpenAI pages were read as text through a proxy
because they refuse direct fetches from here. "Reported" marks a third-party
source. The Atlas notes in `atlas-browser-research.md` are history: Atlas
stopped working on 2026-08-09.

**What exists.** No product is called "agent mode" any more. ChatGPT Work
(launched 2026-07-09) runs browser tasks in one of three browsers, and the
model picks which:

- A **cloud browser** on an OpenAI VM. It has none of the user's logins and
  keeps running when the laptop closes
  ([help](https://help.openai.com/en/articles/20001280-using-cloud-browser-in-chatgpt)).
- A **built-in browser** in the desktop app, with its own profile
  ([help](https://help.openai.com/en/articles/20001277-using-the-built-in-browser-in-the-chatgpt-desktop-app)).
- The **ChatGPT extension** in the user's own Chrome, Edge, Brave, Opera or
  Vivaldi profile, with their signed-in sessions
  ([docs](https://learn.chatgpt.com/docs/chrome-extension)).

Codex shares the stack. The legacy screenshot-driven "ChatGPT agent" was
reportedly removed in August
([Wikipedia](https://en.wikipedia.org/wiki/OpenAI_Operator)). The help
center text retrieved here still describes it, so that is unconfirmed.

**How it acts (reported).** Simon Willison captured the agent's own runtime
docs from a live session
([capture](https://codex-tool-reference.simonw.chatgpt.site/skills/control-browser),
[post](https://simonwillison.net/2026/Aug/30/understanding-chatgpt-work/)).
These are not a published OpenAI API. Per that capture:

- The model writes JavaScript against one `agent.browsers.*` API in a Node
  REPL, so a single turn can chain many actions.
- Each tab has three layers, preferred in this order:
  1. Playwright locators (`getByRole`, `getByLabel`, `getByText`, `waitForLoadState`, `waitForURL`, `domSnapshot()`).
  2. A filtered DOM with node ids for interactable elements.
  3. Pixel coordinates.
- `domSnapshot()` expands iframes.
- JS dialogs are handled per tab (`getJsDialog`).
- Page-change notices ride on responses.
- The agent is told to take one authoritative signal as the answer rather
  than re-verify with full snapshots, and to "avoid requesting both" a DOM
  snapshot and a screenshot.

Shadow DOM and pop-up windows are not mentioned.

**Numbers.** OpenAI publishes model scores, not per-step browser figures:

- BrowseComp: GPT-5.6 Sol 90.4%, GPT-6 Astra 91.5%.
- OSWorld 2.0: Astra 72.6%.
- Astra took about 40 minutes per OSWorld 2.0 task against Sol's 75
  ([Astra](https://openai.com/index/gpt-6-astra/),
  [5.6](https://openai.com/index/gpt-5-6/)).

There are no WebArena, WebVoyager or Mind2Web scores for the current stack.
Steps per task, tokens per task, per-step latency and step or session limits
are all unpublished. Reviewers time bounded browser jobs at 1 to 9 minutes
(reported). A head-to-head run is not possible here: Work needs a paid
account and its loop cannot be scripted. The comparison below is therefore
per mechanism, against what is published.

**For the user.** These are the parts that are not about tokens:

- **Visibility.** In the desktop app "you and ChatGPT can see the same page"
  (split or full view). The cloud browser's live tab can be opened from the
  chat, and screenshots appear in it
  ([browser docs](https://learn.chatgpt.com/docs/browser)).
  - A cursor overlay, element highlights and tab badges are not documented
    anywhere.
- **Take-over and hand-back.** "You can stop the task or take over at any
  time." The user returns control with **I'm done**
  ([computer-use docs](https://learn.chatgpt.com/docs/computer-use),
  [browser docs](https://learn.chatgpt.com/docs/browser)). The agent can also
  ask for a hand-off itself.
  - Reported: the take-over button shows only after the agent's turn ends.
  - MacStories saw frozen take-over UI and missing login panels
    ([MacStories](https://www.macstories.net/stories/hands-on-with-chatgpt-works-new-cloud-browser-feature/)).
- **Sign-in.** At a login wall the cloud browser pauses and shows a secure
  form. Credentials go to the remote browser and "are not visible to the
  model". A separate model checks the form for phishing. "Sign in on web
  page instead" is the alternative.
- **Confirmations.** It asks before actions "that could be hard to reverse
  or create a financial, legal, account, or other real-world commitment".
  The captured policy confirms deletes, purchases, permission changes and
  sending sensitive data, even when the first prompt allowed them. It asks
  before solving a CAPTCHA.
- **Site permissions.** Each site gets Always ask / Auto approve / Always
  allow (cloud), or Allow once / for this site / for all sites (extension).
  An optional reviewer model, Auto-review, can approve new sites.
- **Isolation.** The extension works in its own tab groups in background
  tabs and does not take over the user's active tab (reported).

## Where we were (baseline, origin/main 4c77e86)

The tools already batch (up to 25 steps, with waits), settle each reply until
the work the action started has landed, and answer every action with what
changed (`effect`). Refs were per-snapshot positions (`s<generation>-<n>`)
stamped on the DOM as an attribute.

A new bench (below) drives realistic tasks the way a model does: read once,
act by ref, read only the replies. It found five problems:

1. **Refs died on every change.** The host voided all refs after each
   action, and a page that re-renders its list (React, Vue, plain
   `innerHTML`) replaced the stamped nodes. So a batch built from one
   snapshot failed at the first step after a re-render. The todo task took
   8 calls and 3 snapshots for 5 steps.
2. **Action replies capped the list at 40, with no sign of the rest.** After
   a navigation to a link-heavy page the control the agent needed (Next on
   books.toscrape.com) was not in the reply. Every step cost another
   snapshot of about 17k characters. That task took 6 calls and 16k tokens.
3. **Same-named controls were anonymous.** 120 "Open" buttons, or "Delete" on
   every row, all read the same. The agent had to count rows in the text,
   or run script to locate the right row and click its pixels.
4. **A covering modal or cookie banner was invisible until a click failed.**
   The error said `covered by div#modal` and nothing about what closes it.
   Two blind failures per task.
5. **Pop-ups and dialogs cost extra round trips.** A pop-up tab could only be
   found by listing tabs. A confirm or prompt was dismissed, and the note
   asked for an `eval` override plus a repeat.

Two others are not fixed here:

- **Cross-site iframes cannot be read**, so a payment or delivery widget
  needs a screenshot and pixel clicks.
- **Background host tabs throttle page timers.** The held-out eval's
  infinite-scroll oracle, which scrolls by script with 500ms timers, failed
  on the live app. The `scroll` action itself works.

## Comparison

| | ChatGPT Work (published or reported) | Alan's Way before | Alan's Way after |
|---|---|---|---|
| Observation | DOM snapshot with node ids, or a screenshot, not both by default (reported) | Text plus a list of controls; screenshot on request | Same, plus `row` on repeated names and `overlays` for what covers the page |
| Targeting | Semantic locators first, then node ids, then pixels (reported) | Ref, CSS selector or pixels | Ref, **name** (with role and row), selector or pixels |
| Refs across changes | Unknown | Voided by every action and every re-render | Kept while the control lives; a re-rendered control keeps its ref only on an exact, unique match |
| Batching | Code in a REPL, many actions per turn (reported) | Up to 25 steps with waits | Same; steps can now name controls, so a batch needs no snapshot first |
| Verification | One authoritative signal, change notices on responses (reported) | `effect` with new text and the controls when they changed | Same, with changed/removed controls instead of the list |
| Iframes | `domSnapshot()` expands them (reported) | Same-origin only | Same-origin only |
| Shadow DOM | Unknown | Open roots | Open roots, names too |
| Dialogs | Per-tab dialog handling (reported) | alert accepted, confirm and prompt dismissed; accept by eval override | Same default; `dialog: {accept, text}` on the action answers them |
| New tabs | Tab list API (reported) | List tabs to find a pop-up | The reply's `opened[]` names it |
| Modals, cookie banners | Seen in screenshots; no confirmation needed for cookie banners (reported) | Seen only when a click failed | Listed in every reply with the ref that closes them, preferring reject or no thanks |
| Sign-in wall | Pauses, secure form hidden from the model, phishing check | Agent sees a password field and releases the tab | Unchanged here; `release` now takes a reason and the app shows "<Bot> needs you" (#126, merged alongside) |
| Watching | Shared view in the app, live cloud tab | Agent cursor, tint, element highlight in the app's tabs; VM tabs viewable | Unchanged |
| Take-over | Stop or take over any time; I'm done hands back | Take over / Give to agent, with a control epoch that voids every pending agent action | Unchanged |
| Consequential actions | Asks first (purchases, deletes, sending data) | Plugin skill and the operator's approvals | Unchanged |

What ChatGPT does that we do not:

- **A sign-in path that keeps the password from the model.** Our hand-back
  is a release of the tab. The user signs in themselves in the same tab,
  which keeps the password out of the model too, but there is no secure
  form and no phishing check.
- **Cross-site iframes.**
- **Per-site permission prompts.**
- **A reviewer model** for new sites.

What we do that it does not document:

- A visible agent cursor with an element highlight.
- A take-over that voids every pending agent action by epoch.
- Agent tabs that never take the user's focus or pointer.
- Tab ownership per bot.

## Changes, ranked by what they moved

1. **Name targets.** `{action:"click", name:"Next", role:"link"}` acts on
   the control with that name, as a snapshot would list it. Matching is
   exact first, then by prefix, then by contained words. `role` and `row`
   narrow it. It works in open shadow roots and same-origin frames, and the
   reply says which ref it resolved to. Several matches fail with their
   refs and rows; it never guesses. This is the locator layer ChatGPT
   prefers, and it removes the snapshot before an action on a named control
   and after a navigation.
2. **Stable refs.** A ref (`e12`) names one control for the life of its
   document. Refs are held in a page-side store on a registered symbol, not
   in a DOM attribute. When the page re-renders a control as a new node, the
   ref moves to it only if exactly one new control has the same role, name,
   row and address, and no other lost ref shares them. Anything less certain
   is `stale`, never a guess.
   - Refs no longer die after each action or on in-page route changes.
   - A page can no longer plant the ref attribute to redirect a ref.
   - Numbering continues across documents in a tab, so an old document's
     ref never names a control in the new one.
3. **Delta replies.** Pass `generation` and an action reply carries
   `changed[]` and `removed[]` instead of the list. A scan cut short by its
   cap removes only refs the page reports gone. After a navigation, without
   `generation`, or when the delta is over 60% of the list, the reply is the
   list, and `unlisted` counts what the 40-item cut left out.
4. **Overlays.** Every snapshot and reply lists a dialog or banner covering
   a quarter or more of the viewport, with its name and the ref that closes
   it. Stacked ones are listed topmost first. The close ref prefers close,
   no thanks or reject over accept. A fixed app shell that holds most of the
   page's controls does not count. A click that lands on a cover now says:
   `covered by "Join our newsletter". Close it first: click e19 ("No thanks")`.
5. **Row context.** Controls whose role and name repeat carry `row`, the
   text of the item they sit in (`Open` with row `Order #87 · $278.00`), so
   the right one is picked without counting or scripts.
6. **Opened tabs and dialog answers.**
   - A reply's `opened[]` names tabs its action opened, with id and epoch.
   - `dialog: {accept: true, text}` on an action (or a batch step) answers
     the confirm or prompt it raises. The default is still dismiss, and the
     note says how to accept.

The tool descriptions say all of this in 1.2k more characters (10,963 to
12,179 for the browser tools on main with #126; about 300 tokens per turn,
before prompt caching).

## Before and after

`node scripts/browser-bench.cjs --runs 3`, medians per task. Before is
origin/main at 4c77e86; after is this branch rebased on main with #126. Calls are model
round trips (each tool call). Tokens are reply characters / 4, plus
width x height / 750 for a screenshot. Tool ms is time inside the tools; it
leaves out the 300 ms think time between calls and varies run to run. Calls
and tokens are close to deterministic. The bench's loop uses `generation`,
names and `overlays` only where the checkout under test offers them, so the
same loop runs on both.

**VM host code (vps-browser-host.cjs, local headless Chrome)**

| Task | Pass | Calls | Snapshots | Tool errors | Tokens |
|---|---|---|---|---|---|
| search-open | 3/3 → 3/3 | 4 → 3 | 1 → 0 | 0 → 0 | 2,324 → 2,001 |
| form-multifield | 3/3 → 3/3 | 3 → 3 | 1 → 1 | 0 → 0 | 1,280 → 1,275 |
| infinite-list | 3/3 → 3/3 | 8 → 7 | 1 → 1 | 0 → 0 | 4,926 → 4,012 |
| cookie-modal | 3/3 → 3/3 | 7 → 3 | 1 → 1 | 2 → 0 | 1,970 → 977 |
| spa-rerender | 3/3 → 3/3 | 8 → 2 | 3 → 0 | 0 → 0 | 4,659 → 813 |
| popup-tab | 3/3 → 3/3 | 7 → 5 | 2 → 1 | 0 → 0 | 2,346 → 1,706 |
| confirm-dialog | 3/3 → 3/3 | 5 → 3 | 1 → 0 | 0 → 0 | 1,241 → 916 |
| login-wall | 3/3 → 3/3 | 4 → 3 | 1 → 0 | 0 → 0 | 1,307 → 818 |
| iframes | 3/3 → 3/3 | 8 → 8 | 1 → 1 | 0 → 0 | 2,549 → 2,283 |
| pub-wiki-search | 3/3 → 3/3 | 4 → 4 | 1 → 1 | 0 → 0 | 4,385 → 4,413 |
| pub-books-next | 3/3 → 3/3 | 6 → 3 | 3 → 1 | 0 → 0 | 16,350 → 6,593 |
| pub-selenium-form | 3/3 → 3/3 | 3 → 3 | 1 → 1 | 0 → 0 | 1,073 → 1,077 |
| **Total** | **36/36 → 36/36** | **67 → 47 (-30%)** | **17 → 8** | **2 → 0** | **44,410 → 26,884 (-39%)** |

Tool time, summed medians: 11,435 ms → 9,442 ms.

**Host tabs (the app under Electron)**

| Task | Pass | Calls | Snapshots | Tool errors | Tokens |
|---|---|---|---|---|---|
| search-open | 3/3 → 3/3 | 4 → 3 | 1 → 0 | 0 → 0 | 2,001 → 1,694 |
| form-multifield | 3/3 → 3/3 | 3 → 3 | 1 → 1 | 0 → 0 | 1,117 → 1,108 |
| infinite-list | 3/3 → 3/3 | 8 → 7 | 1 → 1 | 0 → 0 | 4,177 → 3,415 |
| cookie-modal | 3/3 → 3/3 | 7 → 3 | 1 → 1 | 2 → 0 | 1,555 → 827 |
| spa-rerender | 3/3 → 3/3 | 8 → 2 | 3 → 0 | 0 → 0 | 4,054 → 670 |
| popup-tab | 3/3 → 3/3 | 7 → 5 | 2 → 1 | 0 → 0 | 2,023 → 1,406 |
| confirm-dialog | 3/3 → 3/3 | 5 → 3 | 1 → 0 | 0 → 0 | 862 → 651 |
| login-wall | 3/3 → 3/3 | 4 → 3 | 1 → 0 | 0 → 0 | 1,110 → 646 |
| iframes | 3/3 → 3/3 | 8 → 8 | 1 → 1 | 0 → 0 | 2,355 → 2,087 |
| pub-wiki-search | 3/3 → 3/3 | 4 → 4 | 1 → 1 | 0 → 0 | 4,022 → 4,219 |
| pub-books-next | 3/3 → 3/3 | 6 → 3 | 3 → 1 | 0 → 0 | 16,112 → 6,470 |
| pub-selenium-form | 3/3 → 3/3 | 3 → 3 | 1 → 1 | 0 → 0 | 899 → 898 |
| **Total** | **36/36 → 36/36** | **67 → 47 (-30%)** | **17 → 8** | **2 → 0** | **40,287 → 24,091 (-40%)** |

Tool time, summed medians: 13,788 ms → 7,732 ms.

The held-out eval (`node eval/run.cjs --mode oracle`, 20 browser tasks, 3
runs each) checks that nothing regressed. Its oracles are scripted with
eval and selectors, so they do not exercise the new features, and none of
its pages were used to tune these changes.

| Engine | Pass | Mean wall | Mean tool calls | Mean reply bytes |
|---|---|---|---|---|
| VM host code | 59/60 → 60/60 | 985 → 905 ms | 5.1 → 5.1 | 10,098 → 10,803 |
| Host tabs (app under Electron) | 51/60 → 54/60 | 2,418 → 1,326 ms | 5.3 → 5.1 | 9,709 → 12,069 |

The failures that remain, on host tabs only, are in the eval's own oracles,
not in the tools: `pub-wiki-multihop` clicks link pixels it measured by
script and lands on the old page, and `pub-quotes-infinite-scroll` scrolls by
script with page timers that a background tab in a minimized window
throttles (3/3 each, before and after). Before, `pub-shadow-switch`,
`pub-iframe-datepicker` and `fx-infinite-scroll-select` also failed once
each; after, they passed. Replies are larger in this eval because its oracles
snapshot with `maxElements: 300`, and rows and overlays add to every
snapshot.

The VM itself (the live Orgo VM through the installed app, public tasks only,
because fixtures on this Mac are not reachable from it) was run for the
baseline: 3/3 tasks, 13 calls, 21.5k tokens, 2 to 4 times the local latency.
The after numbers there need the VM host updated through the app's update
flow, which is a deploy, so they were not run. The VM engine rows above run
the same `vps-browser-host.cjs` against a local headless Chrome.

## Safety

Unchanged:

- The approval and policy paths.
- The agent cursor, tint and highlight.
- Take-over by control epoch.
- Tab ownership.
- The address barrier on agent navigation.
- The default dismissal of confirm and prompt.

Stricter:

- Refs resolve only through the page-side store. A page that copies or
  plants `data-hermes-workspace-ref` cannot steer an agent's ref, which the
  old attribute lookup allowed.
- A re-rendered control is rebound only on an exact, unique match.
  Identical twins go stale (tested).

New choices an agent can make:

- `dialog: {accept: true}` replaces the old eval override and is scoped to
  the one action.
- Clicking an overlay's close ref is a click the agent could already make.
  The close ref offered prefers the choice that shares nothing.

## Not done, ranked

1. **Cross-site iframes.** List and act on controls inside cross-origin
   frames, through per-frame CDP sessions (out-of-process frames) on both
   hosts. Frame-qualified refs, and coordinates offset by the frame owner's
   box. The iframes task still costs a screenshot, a script and pixel clicks
   (8 calls).
2. **Sign-in detection.** Say in the reply when a page is a login wall, and
   point at `release` with reason `login` (#126).
3. **Tool definition size.** The browser tools are 12.2k characters. Moving
   the rarely used parts (`cdp`, `viewport`, drag details) into one line
   each would pay for this change's additions.
4. **Shorter element entries.** Same-origin `href`s as paths would cut about
   a quarter of a link-heavy list. `navigate` would then need to accept a
   path relative to the tab.
5. **Wait inside frames and shadow roots.** `wait` with `text` or `selector`
   reads only the top document's light DOM. A name-based wait would match
   the rest of the tools.
6. **Background host tabs and page timers.** Script that scrolls and waits on
   timers in a hidden host tab runs slowly (the eval's quotes oracle). The
   `scroll` action is not affected.

## Running the benches

```sh
cd desktop
node scripts/browser-bench.cjs                                   # vm and app engines, all tasks
node scripts/browser-bench.cjs --engine vm --runs 3 --json out.json
node scripts/browser-bench.cjs --root /path/to/baseline/desktop  # bench another checkout
node scripts/browser-bench.cjs --connection "$HOME/Library/Application Support/Hermes Workspace/connection.json" --host vm   # the live VM, public tasks
node scripts/browser-bench.cjs --suite api                       # the older raw-API timing flows, needs the app running
```

- **`vm`** runs `scripts/vps-browser-host.cjs` against a headless Chrome
  with `*.example` mapped to a local fixture server.
- **`app`** launches the app (`src/main.cjs`) under Electron with a
  throwaway profile and its window minimized, with loopback fixtures
  allowed. Agent tabs open in the background as they do for bots.
- **`--root`** benches another checkout, so a baseline needs only
  `git worktree add` and its `node_modules`.

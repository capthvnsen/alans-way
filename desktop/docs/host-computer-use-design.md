# Host computer use: design and measurements

Written 2026-10-11 for the computer-use and browser-use path that drives the
user's own computer (the host): Mac first, Windows second. Linux hosts keep
the existing AT-SPI driver. Numbers are from a MacBook on macOS 27.0.1; nothing
here was run on Windows or Linux.

## Where to act, and how

An agent has three surfaces. It must pick one before it picks a tool.

| Task | Surface | Read with | Act with |
|---|---|---|---|
| Anything on a web page | Host browser (the app's Chromium tabs), or the VM browser when the computer is offline or `host:"vm"` is passed | `cua_alans_way_snapshot` | `cua_alans_way_action` (batch + wait) |
| A native app on the user's computer | Host desktop | `workspace_computer_apps`, `workspace_computer_snapshot` | `computer_use` (the alans-way-computer provider, approval-gated), or `workspace_computer_action` where the operator allowed it |
| A native app on the VM | VM desktop (only when the computer is offline) | same tools; `workspace_computer_apps` answers `host: "vps"` | same |

Rules the tools now state themselves:

- `workspace_computer_apps` names the machine: `host` is `mac`, `windows` or
  `linux` for the user's computer, `vps` for the VM desktop.
- Desktop work happens in background apps. The pointer never moves and focus
  never changes, so the app in front is the user's and is refused
  (`in_front`). Keychains, password managers, this app, Windows secure
  desktop and password fields are refused and no longer listed.
- Errors carry the next step: `permission` (which System Settings pane),
  `locked` (ask the user to unlock), a snapshot `note` (windows on another
  Space, or no windows), `stale_ref` (which ref changed).

## A good host action loop, from first principles

The dominant costs in an agent loop are model turns (seconds each) and
tokens per turn. Tool latency (tens of milliseconds here) is noise next to
them. So:

1. **Observe cheaply.** Read the accessibility tree, not pixels. A control
   with a role and a name is unambiguous and costs a few tokens; a
   screenshot costs about a thousand and still needs the model to find the
   control.
2. **Target by element, not pixel.** A ref survives window moves, scaling
   and themes; a coordinate does not. Pixels are the fallback for canvases,
   charts and unlabeled icons.
3. **Keep refs meaningful across changes.** If any change anywhere in the
   app voids every ref, an app with a clock or a progress bar can never be
   driven, and every state-changing step costs an extra observation.
4. **Batch.** Several steps in one call, one round trip.
5. **Verify inside the action.** The reply to an action is the new state,
   and a batch can wait for the expected text. Re-observing after every
   action doubles the turns.
6. **Send deltas.** After an action, the model already holds the tree; send
   what changed.
7. **Show only what a person would see.** Rows scrolled out of view are not
   on screen; list them as a count and let the agent scroll.
8. **Fail with the next step.** Permission, lock screen, other Space, front
   app: each error says what to do.

## Codex computer use, as published

Researched 2026-10-11 from OpenAI's docs and changelog plus one third-party
review. OpenAI publishes little about the Codex app's loop; unknowns are
marked.

- **Background on Mac, with its own cursor.** "Computer Use can work in the
  background while you use other apps" with a picture-in-picture preview
  ([use-your-computer-with-codex](https://learn.chatgpt.com/use-cases/use-your-computer-with-codex));
  "with its own cursor ... without taking over your computer"
  ([OpenAI on X](https://x.com/OpenAI/status/2044827932145897652)). The
  mechanism (CGEvent vs Accessibility actions) is unknown.
- **Windows takes the foreground.** On Windows it "takes over the
  foreground", the pointer and keyboard move, and OpenAI suggests a VM if you
  need your desktop ([computer-use docs](https://learn.chatgpt.com/docs/computer-use)).
- **Observation.** OpenAI says it needs Screen Recording "so ChatGPT can see
  the target app" and Accessibility to click and type
  ([computer-use docs](https://learn.chatgpt.com/docs/computer-use)).
  MacStories reports it reads the accessibility tree first, with screenshots
  and coordinate clicks as secondary
  ([MacStories](https://www.macstories.net/notes/openais-new-codex-app-has-the-best-computer-use-feature-ive-ever-tested/));
  that is third-party, not OpenAI. Resolution, per-window vs full screen, and
  element ids are unknown.
- **The API tool is pixels.** The Responses API `computer` tool returns
  screenshots, takes `x`/`y` coordinates, and a `computer_call` carries an
  ordered `actions` array; the harness returns a screenshot after a group of
  actions ([computer use guide](https://developers.openai.com/api/docs/guides/tools-computer-use.md)).
  Image cost is `ceil(w/32) x ceil(h/32)` patches times 1.2
  ([images and vision](https://developers.openai.com/api/docs/guides/images-vision)),
  which works out to roughly 1,566 tokens for a 1440x900 screenshot (our
  arithmetic from that formula).
- **Safety.** Per-app approval with "Always allow", no terminal apps, no
  admin prompts ([computer-use docs](https://learn.chatgpt.com/docs/computer-use)).
- **Locked Mac.** Tasks continue after the Mac locks; it briefly unlocks
  during turns ([changelog](https://learn.chatgpt.com/docs/changelog)).
- **Scores.** GPT-5.4 at 75.0% on OSWorld-Verified, per a secondary source
  ([Tom's Guide](https://www.tomsguide.com/ai/gpt-5-4-is-here-and-openai-just-made-every-other-ai-model-look-slow)).
  No published latency, steps per task, or tokens per task for the Codex app.

Because Codex publishes no per-task numbers and its app loop cannot be
scripted here, there is no head-to-head run. The comparison below is per
step, against what is published.

| Per step | Codex (published) | Alan's Way after this change (measured) |
|---|---|---|
| Observation | Screenshot per step in the API loop, ~1.5k tokens at 1440x900; app loop unknown | Element tree, ~560 tokens for the two-window fixture; screenshot only on request |
| Targeting | Pixels (API); app unknown | Element refs that survive unrelated changes; pixels as fallback |
| Batching | `actions` array (API) | Up to 25 steps, with `wait` for the expected result |
| Verification | Harness screenshot after a group of actions | The action reply is the new state, as a delta (about 40 tokens for a click, 250 for a scroll that reveals new rows) |
| Mac focus | Background, own cursor | Background, pointer never moves, front app refused |
| Windows focus | Foreground takeover | Background through UI Automation (not re-measured here) |
| Locked screen | Works (briefly unlocks) | Refuses with `locked` and asks the user |

## Where we were (baseline, origin/main 0c24a2c)

The helper was already accessibility-first with refs, batches, a generation
check and `since` for unchanged trees. The bench found four problems:

1. **Long lists were unreadable.** The walk is breadth-first with a cap of
   180 elements. In a table, every row and every cell counts toward the cap
   before the text inside them is reached, so the fixture's 80-row list
   came back as 155 nameless `AXRow`/`AXCell` entries, `truncated:true`, and
   no row names. Finder's Downloads list had 1,010 rows out of view.
2. **Any change voided every ref.** Refs were positions in the tree and the
   generation was a hash of the whole tree, so a ticking label made every
   ref action fail with `stale_ref`, and so did the retry.
3. **Every action re-sent the whole tree**, about 3.7k tokens for the
   fixture, with window chrome buttons and fractional frames.
4. **Blind spots with no explanation.** With a full-screen app in front,
   every other app's windows sit on another Space, where the accessibility
   API lists no windows at all. The snapshot was an empty list that looked
   like a blank app, and screenshots failed with "no window". A locked
   screen returned the menu-bar strips as windows.

The provider path (alans-way-computer) adds two costs of its own: every
`capture` is a snapshot plus a screenshot, and action replies are dropped,
so the model captures again to see any result and reuses the generation of
its last capture, which turned every state-changing step into a `stale_ref`.

## Changes, ranked by what they moved

1. **Read what is on screen.** The walk clips to each scroll area's visible
   rect (`hidden: N` counts the rest), folds cells and text into their row's
   name, and skips close/minimize/zoom/full-screen buttons. Fixture
   snapshot: 177 elements and 14.7 KB to 22 elements and 2.2 KB, with every
   row named. Fixes the list and scroll tasks.
2. **Stable refs and per-ref checks.** A ref follows its control
   (AXUIElement identity, then role, name and position among namesakes for
   apps that rebuild their tree). The helper keeps the last eight trees it
   handed out; a ref action with an older generation still runs when every
   ref it uses is the same control (the same AXUIElement) with the role,
   name and enclosing row the caller saw, and otherwise fails naming the
   ref. A ref re-bound by label, or a button in a recycled table row, never
   passes. Fixes live churn and removes the provider's stale retries without
   changing the provider.
3. **Delta replies.** An action reply lists `changed[]` and `removed[]`
   against what that bot was last sent, when the caller passes that tree's
   generation (so a lost reply gets the whole tree) and the delta is under
   60% of the full tree (shared JS, so Windows and Linux get it too; Windows
   now has stable refs and Linux's positional refs still fall back).
4. **`wait` step.** `{action:"wait", text, gone, timeout}` polls the tree, so
   a batch acts and confirms in one call. Steps after a wait still carry the
   caller's generation; a run or a wait that fails after earlier steps ran is
   reported in `results`, not thrown; all waits in one call share 45 s.
5. **Say why a tree is empty.** No readable window gives a `note`: on another
   Space, minimized or hidden (with the fix), or no windows (use the menus).
   Window screenshots include off-screen windows, preferring on-screen ones
   and skipping the untitled never-shown windows apps own.
6. **`locked`.** Found during the bench: with the screen locked,
   Accessibility returns the menu-bar strips as an app's windows (78 empty
   menu items for the fixture, no controls). The helper now fails fast with
   `locked` and the next step, after the policy check.
7. **Tool text.** `workspace_computer_apps` returns `host`; descriptions lead
   with where and how; the app list drops off-limits apps and negative pids
   and only marks the front app.

Safety is unchanged: the policy list, the password-field checks, the
front-app refusal, the pointer restore and the provider's approval gate are
all as they were. The per-ref check is narrower than the old whole-tree
check only where the control the caller named is provably the same one with
the same label.

## Before and after

`scripts/computer-bench.cjs`, one run each, 600 ms think time between
reading a reply and acting (the fixture clock ticks every 250 ms). Text
tokens are reply characters / 4; image tokens are width x height / 750.
Calls and tokens are deterministic; milliseconds vary run to run.

Modes: **mcp** is a model on the MCP tools acting one step per call and
reading each reply; **batch** is one snapshot then one batch; **plugin**
emulates the alans-way-computer provider (capture = snapshot + screenshot,
action replies discarded, a final capture to read the result).

The tables below were measured before the code-review fixes. Repeat runs on
the final code match them per run (calls, stale_ref and text tokens):

| Runs | Baseline mcp / batch | Final mcp / batch |
|---|---|---|
| 3 | 12/21 / 12/21 | 20/21 / 21/21 |
| 5 | not run | 35/35 / 35/35 |

The one miss was "switch window" in mcp mode, 20 seconds after the screen
unlocked: that loop reads the action reply without a `wait`, and the text
view had not updated yet. It did not repeat in the next 5 runs. The batch
loop, which waits for the text, passed every run.

**mcp**

| Task | Pass | Calls | stale_ref | Text tokens |
|---|---|---|---|---|
| find + click x3 | ✅ → ✅ | 4 → 4 | 0 → 0 | 14,781 → 677 |
| type + submit + read | ✅ → ✅ | 3 → 3 | 0 → 0 | 11,088 → 629 |
| switch window | ✅ → ✅ | 2 → 2 | 0 → 0 | 7,399 → 587 |
| read list + select | ❌ → ✅ | 1 → 2 | 0 → 0 | 3,698 → 564 |
| scroll list | ❌ → ✅ | 2 → 2 | 0 → 0 | 7,498 → 812 |
| menu reset | ✅ → ✅ | 2 → 2 | 0 → 0 | 7,578 → 697 |
| click under live churn | ❌ → ✅ | 4 → 3 | 2 → 0 | 7,598 → 719 |
| **Total** | **4/7 → 7/7** | **18 → 18** | **2 → 0** | **59,640 → 4,685 (−92%)** |

**batch**

| Task | Pass | Calls | stale_ref | Text tokens |
|---|---|---|---|---|
| **Total** | **4/7 → 7/7** | **15 → 14** | **2 → 0** | **48,596 → 4,589 (−91%)** |

**plugin** (fixture on screen, so the baseline can screenshot it)

| Task | Pass | Calls | stale_ref | Text tokens | Image tokens |
|---|---|---|---|---|---|
| find + click x3 | ✅ → ✅ | 13 → 7 | 2 → 0 | 25,976 → 1,258 | 4,944 → 2,472 |
| type + submit + read | ✅ → ✅ | 9 → 6 | 1 → 0 | 18,560 → 1,213 | 3,708 → 2,472 |
| switch window | ✅ → ✅ | 5 → 5 | 0 → 0 | 11,143 → 1,176 | 2,472 → 2,472 |
| read list + select | ❌ → ✅ | 2 → 5 | 0 → 0 | 3,722 → 626 | 1,236 → 2,472 |
| scroll list | ❌ → ✅ | 5 → 5 | 0 → 0 | 11,336 → 1,446 | 2,472 → 2,472 |
| menu reset | ✅ → ✅ | 5 → 5 | 0 → 0 | 11,407 → 1,322 | 2,472 → 2,472 |
| click under live churn | ❌ → ✅ | 6 → 6 | 2 → 0 | 7,646 → 1,342 | 2,472 → 2,472 |
| **Total** | **4/7 → 7/7** | **45 → 39** | **5 → 0** | **89,790 → 8,383 (−91%)** | **19,776 → 17,304** |

Opening the fixture and getting its first tree: about 250 ms both before and
after. Tool time per task stayed in the 100 ms to 1 s range, dominated by the
600 ms think pauses the bench does not count and by the app itself.

With the provider unchanged, screenshots are now two thirds of its tokens.
The provider changes below take it to the mcp row: about 18 calls and 4.7k
tokens for the same seven tasks (projected from the mcp mode, not run).

Browser use (`scripts/browser-bench.cjs`, the app's own browser, unchanged by
this work) already batches: 4/4 tasks pass in one call each, 124 ms to 761 ms,
255 to 1,080 tokens per task.

## Not done, ranked

1. **Provider: use action replies** (alans-way-computer, proposed in the PR).
   Merge `changed`/`removed` into its element list (tombstone removed indexes
   so element numbers never shift), say what changed in the action message,
   and stop capturing just to read a result.
2. **Provider: no screenshot by default.** Treat `capture(mode="som")` as the
   tree alone when it has named elements, and say a screenshot is one
   `mode="vision"` away. Saves about 1.2k tokens per capture on the fixture.
3. **Provider: surface `note`, `hidden` and `locked`** in its capture note
   and error codes.
4. **Windows verification.** Windows now has RuntimeId refs and the per-ref
   check. It is stricter than Mac: the namesake ordinal is in the signature
   (MSAA list items can have index-based RuntimeIds), a ref with no RuntimeId
   never passes an older generation, and toggle state (`on`/`off`/`mixed`)
   sits after the name cap so a long label cannot hide a flip.
   Compile-checked on Mac against .NET Framework 4.8 reference assemblies at
   C# 5, and the ref checks run under `dotnet` in `npm test`; the Windows CI
   job builds with the in-box `csc` and runs selftest and Notepad. Not driven
   by hand on a real PC yet.
5. **Screenshot scale.** Captures use the Retina backing scale, so a 420 pt
   window is an 840 px image. 1x would quarter the image cost at some text
   legibility; worth a bench with a vision model before changing.
6. **Off-Space actions.** Accessibility cannot see windows on another Space,
   so those apps can only be read by screenshot. Whether posted events reach
   them is untested.

## Running the benches

```sh
cd desktop
node scripts/computer-bench.cjs                      # mcp, batch, plugin
node scripts/computer-bench.cjs --mode plugin --visible
node scripts/computer-bench.cjs --root /path/to/other/checkout/desktop   # baseline
node scripts/browser-bench.cjs                       # needs the app running
```

The fixture (`test/computer-bench-app.swift`) is built into a temporary
`.app` and opened with `open -g`, so it never takes focus. Its windows join
every Space and sit off the right edge of the display unless `--visible`.
The Mac must be unlocked, and the terminal running the bench needs
Accessibility (and Screen Recording for screenshots).

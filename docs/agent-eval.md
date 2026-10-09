# Agent capability and speed eval (workstream 4, phase 1)

Goal: measure how capable and how fast a Hermes agent is when it drives Alan's Way tools (workspace browser on the Mac app and on the VM, plus desktop computer use), against a bar of OpenAI Codex computer use.

## 1. Inventory of what exists

| Item | What it does | Gap |
|---|---|---|
| `desktop/scripts/browser-bench.cjs` | Calls the browser HTTP API directly (no agent, no model, no MCP layer) on 4 httpbin.org/example.com flows, per-action vs `batch`. Reports wall time, HTTP call count, pass/fail. | One site (httpbin). Measures the API round trip, not an agent's decisions. Needs a live app and its `connection.json`. Cannot show whether an agent finds the right element. |
| `desktop/test/speed-replies.test.cjs` | Headless Chrome + the real `vps-browser-host`. A synthetic 10-task page (click, link, checkbox, select, type+submit, each twice) mimicking the browser.openalan.com benchmark. Asserts each task completes in one `batch` call with fresh refs and `effect`. | Overfitting risk is the main finding: the tools' reply format (`effect`, fresh `elements`, settle windows) was tuned to this exact page shape. It only has easy widgets, one tab, no iframes, shadow DOM, dialogs, downloads, scrolling or pagination. Scripted calls, so no agent turn or token data. The "3.5 s per task" figures are one-turn-per-task; they say nothing about capability. |
| `desktop/test/workspace-integration.cjs`, `browser-smoke`, `background-browser`, `agent-input*`, `cross-host`, `browser-mcp.test.cjs` | Electron/unit correctness of the app, input isolation, MCP schema. | Correctness, not task success; none run an agent. |
| `desktop/test/computer-*.test.cjs`, `fake-computer-service.cjs`, `mac-computer.test.cjs` | Unit tests for desktop control with a fake helper. | No real-app task coverage (Finder, TextEdit, menus). |
| Hermes `evals/` (in the Hermes checkout) | Hermes internals (ACP, auth, delegation). | Nothing for browser/desktop tasks. |

Nothing existing runs a model against held-out tasks, records tool calls, turns and tokens together, or has a baseline for Codex.

## 2. The held-out task set (25)

None of these pages or sites appear in the speed tests. `desktop/eval/tasks.cjs` is the source of truth (goal, start, check, max steps, why, oracle). List them with `node eval/run.cjs --list`.

Check types: `state` (a fixture page POSTs its outcome to the fixture server, or a tab URL/DOM is read straight from the host) and `answer` (regex or value derived independently, for example from an API or the page's own HTML fetched by the checker). No LLM judging.

| id | tier | what | max | why hard |
|---|---|---|---|---|
| pub-form-multifield | public (selenium.dev) | Fill 4 control types, submit | 8 | decoys; signal is the post-submit URL |
| pub-wiki-search-extract | public (Wikipedia) | Search, read DOB from infobox | 8 | autocomplete; long page |
| pub-wiki-multihop | public (Wikipedia) | Click through to Babbage, birth year | 8 | many similar links; link beyond first snapshot |
| pub-books-pagination | public (toscrape) | Next to page 3, 5th title | 10 | truncated titles; grid position |
| pub-quotes-infinite-scroll | public (toscrape) | Scroll to load 30, author of 25th | 10 | content only after scroll |
| pub-js-prompt | public (selenium.dev) | Native prompt answer | 8 | host dismisses prompts unless overridden |
| pub-shadow-switch | public (shoelace.style) | Turn on the Medium web-component switch | 8 | shadow DOM, switch absent from snapshot, promo modal covers page |
| pub-iframe-datepicker | public (jqueryui) | Pick the 15th inside an iframe | 8 | iframe plus popup calendar |
| fx-shadow-nested | fixture | Type into input two shadow roots deep, press button | 6 | selectors cannot pierce |
| fx-iframe-decoy | fixture | Coupon form in iframe, disabled twin outside | 6 | same accessible name twice |
| fx-dialog-chain | fixture | alert, confirm, prompt | 8 | confirm/prompt auto-dismissed |
| fx-file-download | fixture | Download attachment | 4 | page never changes; loop risk |
| fx-new-tab-code | fixture | Read code in new tab, use in the first | 12 | second tab the agent did not open |
| fx-infinite-scroll-select | fixture | Item 80-110 of 120, lazy 20 at a time | 14 | 120 identical buttons |
| fx-paginate-max | fixture | Max score over 6 pages, submit its ID | 16 | state over pages |
| fx-flaky-overlay | fixture | Click once; overlay 1.8 s, button remounts twice | 8 | stale refs, double submit |
| fx-combobox-virtual | fixture | Choose Portugal in a virtualized combobox | 8 | option not in DOM until typed or scrolled |
| fx-canvas-click | fixture | Click the named-colour circle | 5 | needs screenshot and coordinates |
| fx-wizard-validation | fixture | 3-step form, conditional field, validation | 14 | re-rendered controls per step |
| fx-drag-reorder | fixture | Native HTML5 drag to reorder | 6 | synthesized mouse and drag events |
| dk-finder-read | desktop | Go to Folder, name the largest file | 14 | dialog navigation, Size column |
| dk-textedit-save | desktop | Type and save in a sandbox dir | 16 | Save sheet, rich text default |
| dk-settings-read | desktop | General > About, macOS version (read-only) | 12 | SwiftUI tree, nested panes |
| dk-calculator-menu | desktop | View > Scientific, 123 x 45 | 14 | menu-only mode switch, unnamed keys |
| dk-finder-rename-move | desktop | Rename and move a file in the sandbox | 18 | context menu, inline rename, no pointer |

Safety: the task set sends nothing, buys nothing, logs in nowhere and changes no setting. Desktop tasks touch only `$TMPDIR/alans-way-eval-sandbox`; System Settings is read-only. Public sites are read-only except that web forms and a datepicker are filled but never submitted anywhere that stores data (the selenium form echoes into the URL). the-internet.herokuapp.com was dropped: its render-blocking Optimizely script never finishes loading in headless Chrome here (reproduced in plain Chrome too), so `open` fails after 8 s. Public sites change; the checker derives expected values from the live site where it can (books, quotes) and the fixed ones (Hopper DOB, Babbage) are stable facts.

## 3. Metrics and baseline protocol

Per run (`results.jsonl`): `ok` (the check), `overBudget` (tool calls above `maxSteps`), `wallMs`, `toolCalls` (every host request the agent caused, counted at a proxy in front of the host), `httpErrors`, `respBytes` (observation size, a model-independent cost proxy), and for Hermes `agentTurns` (`api_calls`), `tokens` and `costUsd` from `hermes -z --usage-file`.

Aggregates: success rate; strict success (ok and within budget); median and p90 wall time per task; tool calls per task; turns per task; tokens per solved task; failure categories:
`wrong_answer`, `wrong_state`, `tool_error` (host returned 4xx/5xx, for example stale ref or human_has_control), `over_budget`, `gave_up`, `timeout`, `agent_crash`, plus harness errors.

Run each task at least 3 times per configuration; agents are noisy. Report per-tier numbers separately (public, fixture, desktop) and per host (Mac in-app, VM).

Codex baseline: use `--mode manual`. The harness serves the same fixtures on `http://127.0.0.1:<port>`, prints each task's exact prompt and start URL, times it, and runs the same check. Start Codex computer use in a fresh session per task, paste the prompt verbatim, note turns and tool calls from its trace, type the final answer. Tabs/DOM-based public checks (form URL, prompt result, datepicker) cannot be read in manual mode; judge those by hand against the check text in `tasks.cjs`. Compare success rate and median wall time at equal task sets; the bar is parity on fixtures and public tasks within one standard error, with wall time at or below Codex.

## 4. Harness

`desktop/eval/` (run from `desktop/`, `npm ci --ignore-scripts` first):

- `fixtures.cjs`: 12 local pages; each reports its outcome to the server.
- `runtime.cjs`: boots headless Chrome plus the real `vps-browser-host` behind a counting proxy (same stack as `speed-replies.test.cjs`), or attaches to any `--connection connection.json`, for example a test build of the Mac app.
- `tools.cjs`: an MCP client that spawns the shipped `scripts/browser-mcp.cjs`, so the oracle uses the real tool names, schemas and reply shapes.
- `tasks.cjs`, `run.cjs`.

Modes:

- `--mode oracle`: a scripted best-known solution through the real MCP tools. Validates each task's check and gives a floor for tool calls and latency (no model).
- `--mode null`: does nothing; every check must fail (negative control).
- `--mode hermes`: runs `hermes -z "<prompt>" --usage-file F` per task against the same stack. Built, plumbing tested with a stub `HERMES_CMD`, never run against a real model.
- `--mode manual`: Codex or human baseline, above.

### What `--mode hermes` needs (not run yet)

1. A working Hermes CLI. The `hermes` on this Mac currently fails (its venv python path is gone), so set `HERMES_CMD` to a working one, for example `HERMES_CMD="/path/to/hermes"`. The harness uses `-z` (single shot, auto-approves, stdout is the final reply), `--usage-file`, `--model`, `--provider`, `--skills`. These flags were read from the Hermes source, not exercised.
2. A model: `EVAL_MODEL` and `EVAL_PROVIDER` (or `--model`, `--provider`) plus that provider's API key in the environment, for example `OPENROUTER_API_KEY`. Decide the model; token cost scales with it. Roughly 25 tasks x 3 repeats x ~8 turns is a few hundred calls.
3. The Alan's Way plugin skill, so the agent follows the same instructions as production: check out `origin/release/plugin-0.8.0` of alans-way-agents to a scratch dir and pass `--plugin-dir DIR` (or `ALANS_WAY_PLUGIN_DIR`). The harness copies `alans-way/skills` into an isolated `HERMES_HOME` and passes `--skills workspace-operations`. Without it the agent runs without the SKILL guidance, which is not the production condition.
4. The harness generates an isolated `HERMES_HOME` (own `config.yaml` with only `mcp_servers.workspace_browser` pointing at `browser-mcp.cjs`), so it never touches `~/.hermes`, Alex's bots or Orgo. Pass `--hermes-home DIR` to use a prepared profile instead.
5. Desktop tasks: need `--connection` to a Mac app build with Accessibility and Screen Recording granted, and a `--hermes-home` profile that has the `alans-way-computer` provider and the `computer_use` toolset. They are skipped otherwise. Hermes asks for approval per desktop action in interactive use; `-z` sets yolo mode, so run desktop tasks only against the sandbox dir and a machine nobody is using.
6. Mac in-app vs VM: boot mode runs Chromium through the VM's host code (the "VM" engine). For the Mac in-app browser, launch a test build of the app with `HERMES_WORKSPACE_ALLOW_LOOPBACK=1` and pass its `connection.json` via `--connection`; fixture URLs then need host `127.0.0.1` (set `fx.host`, currently only done in manual mode).
7. Public tasks need network.

## 5. Dry run (a), oracle through the real MCP tools, headless Chrome, no network

Run on this worktree, `nice`d, one browser. Five tasks, 3 repeats each:

| task | pass | wall ms | tool calls | obs bytes |
|---|---|---|---|---|
| fx-shadow-nested | 3/3 | 898 / 828 / 815 | 4 | 3083 |
| fx-iframe-decoy | 2/3 | 1447 / 1440 / failed at 108 | 4 | 3525 |
| fx-dialog-chain | 3/3 | 233 / 240 / 236 | 3 | 2008 |
| fx-new-tab-code | 3/3 | 929 / 965 / 931 | 10 | 8837 |
| fx-flaky-overlay | 3/3 | 2096 / 2033 / 2023 | 4 | 2819 |

14/15. The other 7 fixture oracles also pass in separate runs, and `--mode null` fails all 12 (checks are not vacuous).

Finding from the one failure, reproduced 1 in 8 with a bare snapshot: `cua_alans_way_snapshot` right after `cua_alans_way_open` on a page with a same-origin iframe returned `loading:false` but omitted the iframe's controls (only the outer controls were listed). The iframe had not finished loading and nothing in the reply said so. An agent would act on an incomplete control list. That is a real tool gap that the one-site speed test cannot see. Not fixed here (eval only).

## 6. Full oracle pass (network on), 3 repeats

Ran public (8) and fixture (12) tasks, 60 runs: 59/60 passed. Median wall ms and tool calls per run:

| task | pass | wall | calls/max |
|---|---|---|---|
| pub-form-multifield | 3/3 | 709 | 3/8 |
| pub-wiki-search-extract | 3/3 | 1017 | 4/8 |
| pub-wiki-multihop | 3/3 | 776 | 5/8 |
| pub-books-pagination | 3/3 | 897 | 6/10 |
| pub-quotes-infinite-scroll | 3/3 | 1413 | 2/10 |
| pub-js-prompt | 3/3 | 258 | 4/8 |
| pub-shadow-switch | 3/3 | 1302 | 5/8 |
| pub-iframe-datepicker | 3/3 | 1183 | 6/8 |
| fx-shadow-nested | 3/3 | 826 | 4/6 |
| fx-iframe-decoy | 2/3 | 1443 | 4/6 |
| fx-dialog-chain | 3/3 | 237 | 3/8 |
| fx-file-download | 3/3 | 845 | 3/4 |
| fx-new-tab-code | 3/3 | 942 | 10/12 |
| fx-infinite-scroll-select | 3/3 | 806 | 14/14 |
| fx-paginate-max | 3/3 | 966 | 5/16 |
| fx-flaky-overlay | 3/3 | 2030 | 4/8 |
| fx-combobox-virtual | 3/3 | 820 | 5/8 |
| fx-canvas-click | 3/3 | 236 | 3/5 |
| fx-wizard-validation | 3/3 | 1884 | 12/14 |
| fx-drag-reorder | 3/3 | 247 | 2/6 |

Desktop tasks (5) did not run: they need a Mac app build with Accessibility and Screen Recording granted, and have no oracle yet.

Oracles use eval and selectors where a human-like agent would use refs, so the call counts are a floor, not a target. The public oracles passed against live sites on 2026-10-09; the quotes and books checks derive the expected value from the site at check time.

## 7. Repro note for a separate fix: iframe controls missing from an early snapshot

Not fixed on this branch.

- Task: `fx-iframe-decoy` (the same effect shows on `pub-iframe-datepicker`, where the oracle has to poll snapshots until the iframe's input appears).
- Steps: `cua_alans_way_open` the fixture page `/f/iframe` (outer page with a disabled "Coupon code" input plus a same-origin `<iframe src="/f/iframe-inner">` holding the real form), then immediately `cua_alans_way_snapshot`.
- Symptom: the reply has `loading:false` and lists the iframe under `iframes`, but `elements` has only the outer controls. The iframe's "Coupon code" input and "Apply" button are missing. A snapshot a moment later includes them.
- Rate: 1 in 8 on a bare open then snapshot (script `scratchpad/dbg2.cjs`, 8 loops); 2 of 18 oracle runs of this task across the sessions (`--mode oracle --tasks fx-iframe-decoy --repeat 3`).
- Expected: either wait for same-origin iframe load before reporting `loading:false`, or report the frame as still loading so the agent knows the control list is incomplete.


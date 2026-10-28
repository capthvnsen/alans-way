# Computer-use benchmark

A reproducible benchmark for Alan's Way computer use: a fixed task suite, one command, results as JSON plus a Markdown table, and a method for comparing against a baseline such as Codex computer use. This page also checks three public claims against the evidence that exists today.

Short version: the benchmark runs, the tool layer passes 57/60 runs on its own, and none of the three public claims is backed by a published, reproducible model-vs-Codex run yet. The commands to produce those runs are below.

## Run it

```sh
sh scripts/bench-cu.sh                              # fixture tasks, oracle + null arms, 3 repeats, no network, no model
BENCH_TASKS=fixture,public sh scripts/bench-cu.sh   # add the 8 public-site tasks (needs network)
```

It installs `desktop/` dependencies if missing, runs each arm through `desktop/eval/run.cjs`, and writes `results.json` and `results.md` with `desktop/eval/report.cjs`. Output goes to `$TMPDIR/alans-way-bench/<UTC time>/` unless `BENCH_OUT` is set. Each arm also keeps its raw `results.jsonl` (one row per run) and `meta.json` (git describe, node, platform, model, driver, host round trip). Settings: `BENCH_ARMS` (default `oracle null`), `BENCH_TASKS` (task ids or tiers), `BENCH_REPEAT` (default 3). Any other arguments go to every arm's `run.cjs` (see its header).

Needs Node and a Chrome or Chromium (`HERMES_TEST_CHROME` to point at one). Fixture + public with both default arms took 2 min 41 s on an M-series Mac.

## Task suite

25 held-out tasks, defined in `desktop/eval/tasks.cjs` and described task by task in [docs/agent-eval.md](../agent-eval.md#2-the-held-out-task-set-25). None were used to tune the tools.

| Tier | Tasks | What |
|---|---|---|
| fixture | 12 | Local pages served by the harness: nested shadow DOM, iframe decoy, alert/confirm/prompt chain, download, second tab, lazy list, paged table, remounting button behind an overlay, virtualized combobox, canvas, validated wizard, drag and drop. Deterministic, no network. |
| public | 8 | Read-only tasks on public sites: selenium.dev form and prompt, Wikipedia search and multi-hop, books.toscrape pagination, quotes.toscrape infinite scroll, a Shoelace shadow-DOM switch, a jQuery UI datepicker in an iframe. |
| desktop | 5 | macOS apps in a sandbox directory: Finder read, TextEdit save, System Settings read, Calculator menus, Finder rename and move. Need a Mac app build with Accessibility and Screen Recording and a Hermes profile with `computer_use`; no oracle yet. |

Success is decided by code, never by a model: the fixture page reports its own state to the harness, or the check reads the tab URL or DOM, or compares the answer against a value derived independently (for example from the site's own API).

## Arms

| Arm | What runs | Measures |
|---|---|---|
| `oracle` | A scripted best-known solution through the shipped MCP server (`scripts/browser-mcp.cjs`) | Tool-layer floor: latency, calls and observation bytes with zero model time. Validates every check. |
| `null` | Opens the start page and does nothing | Negative control: must fail every task. The report warns if it passes any. |
| `hermes` | `hermes -z "<prompt>" --usage-file F` per task, isolated `HERMES_HOME`, Alan's Way skill via `--plugin-dir` | The product: success, wall time, turns, tokens and cost from Hermes' usage file. |
| `codex` | `codex exec --json` per task with the same goal text | Baseline: success, wall time, tool calls and tokens from the Codex event stream. |
| `manual` | The harness prints each task, times it and runs the check; a person drives the tool under test | Any baseline that cannot be scripted (Codex desktop app, ChatGPT agent). |

**Driver.** Each run records `driver`: `local` when the browser host is on this machine, `remote` when it is reached over the network, such as Hermes on a VPS driving the Mac app over Tailscale. It is inferred from the host URL and can be forced with `--driver remote` (needed when an SSH tunnel makes the host look like loopback). `meta.json` also records `hostRttMs`, the median round trip to the browser host before any task, so local and remote runs show their network distance.

## Metrics

Per run (`results.jsonl`): `ok`, `overBudget` (tool calls above the task's `maxSteps`), `wallMs` (start of the agent to its exit, including any one-shot startup), `toolCalls`, `httpCalls` and `httpErrors` (every request to the browser host, counted at a proxy), `respBytes` (bytes the tools returned), `agentTurns`, `tokens`, `costUsd`, and a failure category (`wrong_answer`, `wrong_state`, `tool_error`, `over_budget`, `gave_up`, `timeout`, `agent_crash`).

Per arm and tier (`results.json`, `results.md`): success, strict success (within budget), wall p50 and p90 (nearest rank, all runs), mean tool calls, mean observation KB, mean turns, **tokens per solved task** and **cost per solved task**. The last two divide everything spent, failed runs included, by the number of tasks actually solved, so an arm cannot look cheap by failing fast.

Cost is what Hermes reports (`estimated_cost_usd`). Codex runs on a subscription and its event stream reports tokens but no price, so its cost column stays `n/a`; compare tokens instead.

## Baseline comparison method

1. Same machine, same task list, same goal text, same checks, at least 3 repeats per task. Run arms back to back on an idle machine; note any change in between.
2. `report.cjs` picks the baseline (`--baseline LABEL`, default the first arm whose label starts with `codex`) and, for each other arm, sums the per-task median wall time over passing runs **on tasks both arms solved at least once**, plus the same for tokens. It prints the sums and their ratio (below 1.0 means the arm is faster or uses fewer tokens than the baseline).
3. Success is compared first. A speed or token ratio only counts as a win when success is no lower than the baseline's.
4. A claim of "N x faster" holds when the wall ratio is at or below 1/N under rule 3. "N x cheaper" needs the token ratio (or cost per solved task when both arms report cost) at or below 1/N.

Known asymmetries to report alongside any comparison:

- **Unverifiable checks for Codex.** Codex's browser is not on our host, so `pub-shadow-switch` and `pub-iframe-datepicker` (DOM checks) fail as unverifiable, and `pub-form-multifield` and `pub-wiki-multihop` rely on the URL Codex reports. Compare success on the remaining 18 browser tasks, or judge those four by hand.
- **The approval gate.** Alan's Way refuses actions that look like they submit, buy or post until the user approves (`commit_required`). `pub-form-multifield` hits it on "Submit" by design, so an unattended Hermes run fails it; Codex has no such gate. Report the result with and without that task.
- **One-shot startup.** `hermes -z` pays CLI startup on every task, and it is slower than `codex exec`'s; gateway users (the Telegram path) never pay it. The harness counts it in `wallMs` because each arm pays its own startup. Report gateway numbers separately if you measure them.

Merge separately made runs (say a VPS run and a Codex run on the Mac) by copying their arm directories side by side:

```sh
node desktop/eval/report.cjs --out OUT_DIR path/to/hermes-remote path/to/codex
```

## Results

Run on 2026-10-28 (UTC), commit `v0.21.13-1-g2e73067`, MacBook (darwin-arm64), Node 26.7, headless Chrome for Testing plus the real VPS browser host code (`scripts/vps-browser-host.cjs`), host round trip 1 ms. Command: `BENCH_TASKS=fixture,public sh scripts/bench-cu.sh`. Raw rows, per-task table and JSON: [results/2026-10-28-local/](results/2026-10-28-local/).

| Arm | Driver | Tier | Success | Strict | Wall p50 | Wall p90 | Tool calls | Obs KB | Turns | Tokens/solved | $/solved |
|---|---|---|---|---|---|---|---|---|---|---|---|
| oracle (tool floor) | local | fixture | 36/36 | 36/36 | 0.8 s | 1.9 s | 6.1 | 8.7 | n/a | n/a | n/a |
| oracle (tool floor) | local | public | 21/24 | 21/24 | 0.8 s | 1.5 s | 4.6 | 23.6 | n/a | n/a | n/a |
| null (control) | local | fixture + public | 0/60 | 0/60 | 0.1 s | 0.3 s | 1.0 | 0.4 | n/a | n/a | n/a |
| hermes, Mac in-app browser | local | all | not run | | | | | | | | |
| hermes, VPS driving the Mac over Tailscale | remote | all | not run | | | | | | | | |
| codex (`codex exec`) | local | fixture + public | not run | | | | | | | | |
| any arm | | desktop | not run | | | | | | | | |

What this run shows:

- **The tool layer is not the bottleneck.** With zero model time, a task costs 0.8 s at the median and 1.9 s at p90, in 2 to 13 tool calls. Any agent's wall time above that is model time, startup and the network.
- **Checks are not vacuous.** The null arm fails all 60 runs.
- **The 3 public failures are the approval gate, as designed.** `pub-form-multifield` stops at `commit_required` on the Submit button. The oracle does not simulate a person approving on a public site.
- **Finding: the commit gate also refuses read-only `eval` on ordinary pages.** On Wikipedia ("Donate" link), books.toscrape ("Add a comment" sidebar link) and quotes.toscrape and fixture pages with timers, `eval` fails with `commit_required` even when the code only reads. Before this change 5 of 8 public oracles, the datepicker check and the paged-table fixture oracle failed on that alone. They now use `read` with `list`, clicks, scrolls and the `dialog` option; harness checks approve their own read-only check code with the test receipt from `desktop/test/approval-fixture.cjs` (agent actions never get it), and fixture oracles approve gated fixture actions the same way. A model agent that reaches for `eval` on these pages will hit the same wall. Whether the gate should treat links like "Donate" as commits is a product decision, not changed here.

Not run here, and why: no model arm ran because this worker has no model credentials it may read and the brief rules out spending on them; the desktop tier needs an unlocked screen and Accessibility grants (the screen was locked); the remote arm needs the VPS.

## Commands for the runs that are missing

Run all of these from a checkout of this branch at the same commit. Each prints its table and leaves `results.json` in `BENCH_OUT`.

**Hermes, Mac in-app browser (local driver), on the Mac:**

```sh
# HERMES_CMD: a working hermes binary. --plugin-dir: a checkout of alans-way-agents at the released plugin.
# The Mac app blocks loopback, so fixtures are served on the Mac's LAN IP.
HERMES_CMD=/path/to/hermes BENCH_ARMS=hermes BENCH_TASKS=fixture,public BENCH_OUT=~/bench/hermes-local \
  sh scripts/bench-cu.sh --connection "$HOME/Library/Application Support/Hermes Workspace/connection.json" \
  --fixture-host "$(ipconfig getifaddr en0)" --model MODEL --provider PROVIDER --plugin-dir /path/to/alans-way-agents \
  --label hermes-local
```

**Hermes on the VPS driving the Mac over Tailscale (remote driver), on the VPS:**

The app's endpoint is loopback only, so reach it the way production does, over SSH on the tailnet.

```sh
# 1. Tunnel to the Mac app (APP_PORT is the port in the Mac's connection.json url).
ssh -N -L 47123:127.0.0.1:APP_PORT MAC_TAILSCALE_NAME &
# 2. Copy the Mac's connection.json to the VPS (chmod 600) and set its "url" to http://127.0.0.1:47123. Delete it after the run.
# 3. Fixtures are served on the VPS's Tailscale IP so the Mac's browser can reach them.
HERMES_CMD=$(command -v hermes) BENCH_ARMS=hermes BENCH_TASKS=fixture,public BENCH_OUT=~/bench/hermes-remote \
  sh scripts/bench-cu.sh --connection /path/to/mac-connection.json --driver remote \
  --fixture-host "$(tailscale ip -4)" --model MODEL --provider PROVIDER --plugin-dir /path/to/alans-way-agents \
  --label hermes-remote
```

**Codex baseline, on the Mac:**

```sh
BENCH_ARMS=codex BENCH_TASKS=fixture,public BENCH_OUT=~/bench/codex sh scripts/bench-cu.sh --label codex-local
```

For the Codex desktop app or ChatGPT agent, use `BENCH_ARMS=manual` and follow the prompts.

**Compare them:**

```sh
node desktop/eval/report.cjs --out ~/bench/compare ~/bench/hermes-local/hermes ~/bench/hermes-remote/hermes ~/bench/codex/codex
```

**Desktop tier** (takes over the screen; use a machine nobody is using): add `--tasks desktop` with `--hermes-home` pointing at a profile that has the `alans-way-computer` provider and the `computer_use` toolset; see [docs/agent-eval.md section 4](../agent-eval.md#what---mode-hermes-needs-not-run-yet).

**Desktop token bench** (the source of the 92% figure, scripted, no model; needs Accessibility for the helper and an unlocked screen):

```sh
cd desktop
git worktree add /tmp/aw-before 0c24a2c            # the baseline the design doc measured
node scripts/computer-bench.cjs --mode mcp,batch,plugin --runs 3 --json /tmp/after.json
node scripts/computer-bench.cjs --mode mcp,batch,plugin --runs 3 --root /tmp/aw-before/desktop --json /tmp/before.json
```

## Verdicts on the public claims

| Claim | Verdict | Evidence |
|---|---|---|
| Computer use is "2-4x faster/cheaper" (2026-10-05) | **Not supported** by any published run; not yet measured by this benchmark | No reproducible run compares Alan's Way to another tool at 2x or more. The closest internal result (2026-10-21, private harness, 12 public browser tasks x 3, same model gpt-6.1-sol on both sides): Workspace browser 36/36, median 21.8 s vs Codex with its Chrome extension 36/36, 27.1 s, and 6.9% fewer tokens. That is about 1.2x faster, not 2x. Run the hermes and codex arms above to settle it. |
| "92% fewer tokens on some tasks" (2026-10-13) | **Supported as a self-comparison; not re-run here** | [desktop/docs/host-computer-use-design.md](../../desktop/docs/host-computer-use-design.md#before-and-after): seven scripted desktop tasks in `computer-bench` mcp mode, text tokens 59,640 before vs 4,685 after the delta-reply change (-92%; batch mode -91%, plugin mode -91% text). It compares Alan's Way against its own earlier version, not against Codex, counts text tokens estimated as characters / 4 (screenshots excluded; plugin-mode image tokens fell only 19,776 to 17,304), and uses a scripted loop, not a model. "On some tasks" is accurate; it says nothing about cost against competitors. |
| Hermes "beats Codex computer use from a VPS controlling the local machine" (2026-10-23) | **Not yet measured** by this benchmark; internal evidence is mixed | Internal runs on 2026-10-22 and 23 (private harness, 24 Mac-app runs per arm, Hermes on the VPS driving Alex's Mac): with the production Sonnet one-shot path Alan's Way was behind, 18/24 at p50 70.3 s vs Codex 20/24 at 32.6 s. With the same model as Codex it was ahead on agent time, 22/24 at 35.9 s vs 22/24 at 43.3 s, but that agent time leaves out Hermes' one-shot startup (56.5 s with it), so the comparison is not like for like. The `hermes-remote` vs `codex-local` runs above measure it the same way for both. |

"Internal" numbers come from runs whose harness and reports are not in this repository, so they cannot be reproduced from here; they are listed only so the verdicts do not hide evidence in either direction.

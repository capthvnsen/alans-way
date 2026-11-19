| Arm | Driver | Tier | Success | Strict | Wall p50 | Wall p90 | Tool calls | Obs KB | Turns | Tokens/solved | $/solved |
|---|---|---|---|---|---|---|---|---|---|---|---|
| oracle-local | local | all | 57/60 | 57/60 | 0.9 s | 1.9 s | 5.5 | 14.8 | n/a | n/a | n/a |
| oracle-local | local | public | 21/24 | 21/24 | 0.9 s | 1.7 s | 4.6 | 23.9 | n/a | n/a | n/a |
| oracle-local | local | fixture | 36/36 | 36/36 | 0.9 s | 1.9 s | 6.1 | 8.7 | n/a | n/a | n/a |
| null-local | local | all | 0/60 | 0/60 | 0.1 s | 0.4 s | 1.0 | 0.4 | n/a | n/a | n/a |
| null-local | local | public | 0/24 | 0/24 | 0.3 s | 0.8 s | 1.0 | 0.4 | n/a | n/a | n/a |
| null-local | local | fixture | 0/36 | 0/36 | 0.1 s | 0.1 s | 1.0 | 0.4 | n/a | n/a | n/a |
| hermes-local | local | all | 17/20 | 16/20 | 19.0 s | 35.0 s | 4.9 | 17.0 | 6.2 | 229226 | $0.206 |
| hermes-local | local | public | 7/8 | 6/8 | 19.8 s | 41.3 s | 4.8 | 32.6 | 6.1 | 256006 | $0.248 |
| hermes-local | local | fixture | 10/12 | 10/12 | 18.0 s | 33.8 s | 5.0 | 6.7 | 6.3 | 210480 | $0.177 |

| Task | Tier | oracle-local | null-local | hermes-local |
|---|---|---|---|---|
| pub-form-multifield | public | 0/3, 0.5 s, 3.0 calls | 0/3, 0.2 s, 1.0 calls | 0/1, 35.0 s, 5.0 calls |
| pub-wiki-search-extract | public | 3/3, 0.9 s, 4.0 calls | 0/3, 0.4 s, 1.0 calls | 1/1, 15.1 s, 3.0 calls |
| pub-wiki-multihop | public | 3/3, 0.9 s, 4.0 calls | 0/3, 0.3 s, 1.0 calls | 1/1, 16.8 s, 3.0 calls |
| pub-books-pagination | public | 3/3, 1.0 s, 8.0 calls | 0/3, 0.2 s, 1.0 calls | 1/1, 19.0 s, 4.0 calls |
| pub-quotes-infinite-scroll | public | 3/3, 1.4 s, 4.0 calls | 0/3, 0.4 s, 1.0 calls | 1/1, 19.9 s, 3.0 calls |
| pub-js-prompt | public | 3/3, 0.3 s, 3.0 calls | 0/3, 0.1 s, 1.0 calls | 1/1, 19.8 s, 4.0 calls |
| pub-shadow-switch | public | 3/3, 0.7 s, 6.0 calls | 0/3, 0.3 s, 1.0 calls | 1/1, 41.3 s, 9.0 calls |
| pub-iframe-datepicker | public | 3/3, 1.2 s, 5.0 calls | 0/3, 0.2 s, 1.0 calls | 1/1, 35.4 s, 7.0 calls |
| fx-shadow-nested | fixture | 3/3, 0.8 s, 4.0 calls | 0/3, 0.1 s, 1.0 calls | 1/1, 17.8 s, 4.0 calls |
| fx-iframe-decoy | fixture | 3/3, 1.5 s, 4.0 calls | 0/3, 0.1 s, 1.0 calls | 1/1, 18.0 s, 4.0 calls |
| fx-dialog-chain | fixture | 3/3, 0.3 s, 3.0 calls | 0/3, 0.1 s, 1.0 calls | 1/1, 12.8 s, 3.0 calls |
| fx-file-download | fixture | 3/3, 1.0 s, 3.0 calls | 0/3, 0.1 s, 1.0 calls | 1/1, 17.1 s, 4.0 calls |
| fx-new-tab-code | fixture | 3/3, 1.0 s, 10.0 calls | 0/3, 0.1 s, 1.0 calls | 1/1, 18.2 s, 5.0 calls |
| fx-infinite-scroll-select | fixture | 3/3, 0.8 s, 12.7 calls | 0/3, 0.1 s, 1.0 calls | 1/1, 29.7 s, 6.0 calls |
| fx-paginate-max | fixture | 3/3, 1.0 s, 9.0 calls | 0/3, 0.1 s, 1.0 calls | 0/1, 33.8 s, 6.0 calls |
| fx-flaky-overlay | fixture | 3/3, 2.1 s, 6.0 calls | 0/3, 0.1 s, 1.0 calls | 0/1, 34.9 s, 7.0 calls |
| fx-combobox-virtual | fixture | 3/3, 0.9 s, 5.0 calls | 0/3, 0.1 s, 1.0 calls | 1/1, 16.6 s, 5.0 calls |
| fx-canvas-click | fixture | 3/3, 0.3 s, 3.0 calls | 0/3, 0.1 s, 1.0 calls | 1/1, 23.3 s, 5.0 calls |
| fx-wizard-validation | fixture | 3/3, 1.9 s, 12.0 calls | 0/3, 0.1 s, 1.0 calls | 1/1, 22.2 s, 6.0 calls |
| fx-drag-reorder | fixture | 3/3, 0.3 s, 2.0 calls | 0/3, 0.1 s, 1.0 calls | 1/1, 17.8 s, 5.0 calls |

## Run notes

Run on 2026-11-19 (UTC), MacBook (darwin-arm64), Node 26.7, current `main` (`d9bb82a`) plus the harness change in this branch (the Hermes rows were produced with that change uncommitted, hence `-dirty` in its `meta.json`). Fixture + public tiers, 20 tasks, `null` and `oracle` at 3 repeats (60 runs each, same result as 2026-10-28: oracle 57/60, null 0/60), the model arm at **1 repeat** (20 runs, one full pass; no subset needed). Headless Chrome plus the real `vps-browser-host`, host round trip 1 ms.

Arms:

| Arm | Status |
|---|---|
| `null`, `oracle` | ran |
| `hermes-local` | ran. Hermes 0.23.2, `claude-opus-5.5` on Anthropic (the model in the user's Hermes config), the released plugin skills (`origin/release/plugin-0.8.0`), throwaway `HERMES_HOME`. "Local" here means the harness's headless Chrome through the VPS host code, **not** the Mac in-app browser: that path needs the real app's `connection.json`, which this task excludes. 3 desktop tasks are not in scope (they take over the screen). |
| `hermes-remote` | **not run.** The documented method (computer-use.md) needs an SSH tunnel from the VM to the Mac app, a copy of the app's `connection.json` (with its token) placed on the VM, and fixtures served from the VM. That uses the real app profile and writes to the VM, both excluded here. Nothing in the repo describes a read-only way. |
| `codex-local` | **not run.** `codex` 0.166.0 is installed but `codex login status` says "Not logged in". Human step: run `codex login` in a terminal and finish the browser sign-in, then `BENCH_ARMS=codex BENCH_TASKS=fixture,public BENCH_REPEAT=1 BENCH_OUT=<dir> sh scripts/bench-cu.sh --label codex-local`. |

## Where the time goes

Hermes local, 20 runs. Per-task columns come from `results.jsonl`: `wallMs`, `toolMs` (sum of the host-side duration of every request the agent made, measured at the proxy), `firstToolMs` (start of the run to the first host request), `agentTurns`, `tokens`.

| | oracle (no model) | hermes-local |
|---|---|---|
| Success | 57/60 (3 gated) | **17/20**, 16/20 within budget; 17/17 on tasks that do not need approval |
| Task time p50 / p90 | 0.9 s / 1.9 s | **19.0 s / 35.0 s** (mean 23.2 s) |
| Tool time (browser host) p50 / p90 | about all of it | 0.7 s / 2.4 s; **5.2 %** of total wall (24 s of 465 s) |
| Model + Hermes time | 0 | about **95 %** of wall, 3.3 s per turn (median) |
| Before the first tool call | n/a | 3.5 s median (4.3 s p90); 12.0 s on the very first task (cold MCP server and skills) |
| Turns per task | n/a | 6.2 mean (p50 6, p90 8) |
| Tokens per task | n/a | 195k mean (p50 165k, p90 258k): 194k input, of which 171k cache reads and 23k cache writes; **1.3k output** |
| Tokens / $ per solved task | n/a | 229k / $0.21 (run cost $3.51 for 20 tasks) |
| Tool calls per task | 5.5 | 4.9 |

Per tier (hermes): public 7/8, p50 19.8 s, p90 41.3 s; fixture 10/12, p50 18.0 s, p90 33.8 s.

Startup, as far as the logs show: the gateway took 10.5 s to come up once per arm, and is not in any task's time. Inside a task, the time before the first host request is a median 3.5 s: CLI attach, MCP server spawn and the first model response together. The logs cannot split that further, and they cannot split model time from Hermes' own overhead: the usage file reports tokens and call counts but no timings. So "model + Hermes" is wall minus tool time, not a pure model number. The earlier statement that `hermes -z` pays CLI startup on every task no longer holds on Hermes 0.23: `-z` attaches to a gateway, so the per-task cost is the attach, not a Python start.

Three slowest tasks:

1. **pub-shadow-switch, 41.3 s.** 10 turns, 493k tokens (2.5x the mean), 9 tool calls against a budget of 8, so over budget. The "Shoelace is now Web Awesome" promo dialog has to be closed first and the switch is not in the snapshot, so the agent needed extra look-and-act round trips. Tool time was only 0.7 s.
2. **pub-iframe-datepicker, 35.4 s.** 8 turns, 367k tokens, and the largest tool time of any run (6.1 s of it): the calendar sits in an iframe that loads late, so the host waits on it and the agent re-reads. Passed.
3. **pub-form-multifield, 35.0 s.** Failed, 6 turns. It filled the form, then Submit hit `commit_required`. The agent declined to work around the gate and wrote an explanation. Two other runs, `fx-flaky-overlay` (34.9 s) and `fx-paginate-max` (33.8 s), failed the same way, so the three failures are all one cause.

What this says: the browser tool layer costs 0.7 s per task. Almost all of the 19 s is the model loop, about 6 turns at about 3.3 s, with 1.3k output tokens in total. Each turn re-reads a roughly 30k-token prompt; the cache keeps that cheap in dollars but not in latency. Fewer turns (batching, fewer observation round trips) is the lever, not faster browser actions. The approval gate is the only thing that cost success: all three failures say the agent could not send the approval (`fx-flaky-overlay`: "the tool won't accept the field used to request it"), and an unattended run has no one to approve. That is by design for `pub-form-multifield` but it also blocks `fx-paginate-max` and `fx-flaky-overlay`, which the oracle gets through with a test receipt. Whether the agent-facing approval field works is worth a look.

## Not verified

- One run per task: p90 over 20 runs is the 18th value, and single runs of a model are noisy. No error bars.
- Codex and remote arms are missing, so there is no comparison to the 2x claims yet.
- Model time vs Hermes overhead is not split (no timings in the usage file).
- Mac in-app browser path, desktop tier, and gateway/Telegram latency are not measured.
- Public-site tasks depend on the live sites on the day.

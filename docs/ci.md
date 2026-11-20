# CI audit

Measured 2026-11-20 from the GitHub Actions API (`gh api .../actions/workflows/<wf>.yml/runs` and `.../actions/runs/<id>/jobs`, per-step timestamps; no bulk logs). Window: the newest 150 `tests` runs (2026-10-30 to 2026-11-20, 3 weeks: 96 pull_request, 53 push to main), the newest 40 `ios` runs, 22 `nightly`, 32 `release`, 6 `browser-egress`. Raw data and the scripts that produced these tables are not committed.

## Where the time goes

Every number is seconds, p50 / p95. **Queue** = job created to job started. **Setup** = "Set up job", checkout, setup-node/python/cache, `npm ci`, brew/xcode-select. **Run** = everything after. Only jobs that ran to success or failure are in setup/run; cancelled jobs are only in queue and in the last two columns.

| Job | n | Queue | Setup | Run | Fail % | Cancelled before any step / after |
|---|---|---|---|---|---|---|
| tests / desktop (macos) | 154 | 4 / **1111** | 13 / 18 | **320 / 416** | 10 | 1 / 1 |
| tests / desktop (ubuntu) | 155 | 2 / 3 | 9 / 20 | 134 / 158 | 3 | 0 / 1 |
| tests / desktop-electron (macos) | 155 | 3 / **1392** | 14 / 20 | **787 / 869** | 12 | 1 / 0 |
| tests / desktop-windows | 156 | 2 / 3 | 14 / 27 | **536 / 624** | 3 | 0 / 0 |
| tests / package-and-test macos 3.11 | 154 | 3 / **1726** | 4 / 7 | 46 / 63 | 3 | 3 / 0 |
| tests / package-and-test macos 3.12 | 155 | 4 / **1499** | 5 / 7 | 46 / 58 | 3 | 2 / 0 |
| tests / package-and-test ubuntu 3.11 | 158 | 2 / 3 | 3 / 7 | 28 / 34 | 3 | 0 / 0 |
| tests / package-and-test ubuntu 3.12 | 158 | 2 / 4 | 3 / 7 | 26 / 35 | 3 | 0 / 0 |
| ios / simulator (macos) | 24 | 4 / **1154** | 20 / 29 | 693 / 894 | 0 | 13 / 2 |
| nightly / build macos | 17 | 3 / 304 | 15 / 19 | 635 / 708 | 35 | 5 / 0 |
| nightly / build windows | 22 | 2 / 12 | 33 / 39 | 84 / 93 | 0 | 0 / 0 |
| nightly / build linux | 22 | 2 / 3 | 9 / 12 | 29 / 32 | 0 | 0 / 0 |
| release / build macos | 34 | 43 / 307 | 12 / 16 | 382 / 637 | 26 | 0 / 1 |
| release / build windows | 35 | 2 / 4 | 32 / 62 | 84 / 96 | 0 | 0 / 0 |
| browser-egress / kernel-filter | 5 | 2 / 556 | 5 / 8 | 6 / 7 | 0 | 1 / 0 |

(Small bookkeeping jobs in `nightly` and `release` — prepare, draft, upload, publish — run 4 to 43 s and are left out.)

What this says:

- **Setup is not the problem.** It is 9 to 14 s at p50, inside the 15 s budget on every `tests` job. `npm ci` takes 4 to 6 s including the Electron binary. The npm cache is keyed on the lockfile hash and was restored in the one log checked per OS family (36 MB); the lockfile changed 3 times in the 3-week window, so at most 3 misses per OS plus the first run of any PR branch that edits it. Caching `node_modules` would save under 4 s per job.
- **Queueing is a macOS-only problem.** Linux and Windows jobs start in 2 to 3 s at p95. macOS jobs start in 3 to 4 s at p50 but 1100 to 1700 s at p95; 38% of PR runs had at least one job wait over 5 minutes. A cancelled-with-zero-steps job is a macOS job that never got a runner.
- **Run time of the biggest jobs is the rest**: `desktop-electron` (13 min, sequential window suites), macOS `npm run check` (5 min, versus 2 min on Linux for the same suite), Windows (9 min, of which `hermes-update-ps1.test.cjs` is 483 s at p50: 21 end-to-end cases at 24 s each, see Flaky checks).

### PR to result

Time from run created to the last job finishing, first attempt only, runs with no cancelled job:

| | n | p50 | p95 |
|---|---|---|---|
| pull_request | 90 | 14.1 min | 36.3 min |
| push to main | 50 | 14.4 min | 59.3 min |
| pull_request, no job queued over 60 s | 73 | 13.4 min | 14.6 min |
| run created to `updated_at`, all finished runs incl. reruns | 150 | 18.6 min | 109.6 min |

`desktop-electron` is the last job to finish in 80% of PR runs. Remove the queue and the median does not move much (13.4 min); the queue is what makes the tail (p95 36 min, 110 min with reruns).

### Minutes and cost per week

GitHub bills each job rounded up to whole minutes, by OS. Sampled minutes divided by 3 weeks (jobs cancelled mid-run included; jobs that never started excluded). `release` is tag-driven and left out of the weekly figure (the 32 sampled runs from Oct 6 to Oct 30 used 95 Linux, 85 Windows, 264 macOS minutes in total).

| Workflow | Linux min/wk | Windows min/wk | macOS min/wk |
|---|---|---|---|
| tests | 309 | 481 | 1136 |
| ios | 0 | 0 | 99 |
| nightly | 29 | 17 | 55 |
| browser-egress | 2 | 0 | 0 |
| **Total** | **340** | **498** | **1290** |

Assumption for cost: public list prices for standard runners, per minute: Linux 2-core $0.006, Windows 2-core $0.010, macOS 3/4-core $0.062 ([GitHub docs, runner pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing); [pricing changes announcement](https://resources.github.com/actions/2026-pricing-changes-for-github-actions/)). That is 340 x 0.006 + 498 x 0.010 + 1290 x 0.062 = **about $87 per week, about $377 per month, 92% of it macOS**. The two GitHub pages I found disagree on the macOS rate ($0.062, and $0.08 with Linux $0.008 and Windows $0.016 on the other); at the higher rates it is about $114 per week, about $493 per month. I could not tell which is current. In plan-quota terms (macOS counts 10x, Windows 2x) it is 14,236 weighted minutes per week.

**The repository reports `visibility: public`** (`gh api repos/capthvnsen/alans-way`), not private. GitHub-hosted standard runners are free for public repositories, so the real bill today is likely $0 and the dollar figures above are what it would cost if the repo were private. Either way macOS minutes are what to cut: it is where the queue is too.

Minutes lost to runs that a newer push to the same branch made pointless (no `concurrency` group today): 12 of 96 PR runs were still running when the branch moved on, 4.4% of weighted minutes (about 33 macOS minutes per week). The saving is small; the benefit of cancelling is the macOS queue.

## Flaky checks (failed, then passed on rerun, same commit)

8 job instances in 149 sampled `tests` runs plus the `release` runs; 9 of 149 `tests` runs have a second attempt. (The CI-history scan found 61 of 858 since 2026-10-13; this window is shorter.)

| Date | Job | Failing step | Cause |
|---|---|---|---|
| 10-07, 10-09 | release / build macos (v0.3.1, v0.21.2) | `npm run check` | Not investigated: tags from before this window. |
| 10-30 | tests / desktop-windows | `hermes-update-ps1.test.cjs` "gateways stop and restart around a successful update that still fits the budget" | Wall-clock dependence in the test. Below. |
| 10-31 (x2) | tests / desktop (macos), two PRs | `speed-replies.test.cjs` "a link moved by hover is re-resolved before the click lands" and "only an exact name acts ...: The page stopped responding" | Both drive a real headless Chrome and failed on the same day, never again in the sample. Cause not found from logs; Chrome page hang on a loaded runner is the likely reason. |
| 11-11 | tests / desktop-electron | `test:auto-takeover` "Timed out waiting for takeover state" | Window-suite state wait. #333 (merged) fixed two other window stalls but did not touch this suite; not seen again in the sample. |
| 11-20 (x2) | tests / desktop-windows | `hermes-update-ps1.test.cjs` same case | Same as 10-30. Total failures of this one case: 5 of 156 Windows runs (3 are in the 150-run sample as fail-then-pass, 2 more failed outright). |

`hermes-update-ps1.test.cjs`, "still fits the budget":

- `ALANS_WAY_HERMES_BUDGET=100` is the test's own input (`runScript`), not a product limit; the product default is 270 s. With 4 gateways the update gets `budget - reserve(60) - 8 - elapsed` seconds, so with a 100 s budget the update's window is 32 s minus everything the script already spent stopping gateways. On a runner where each `hermes` spawn takes 1 to 6 s (the log shows 24 s per whole script run on a slow runner, 1 s on a fast one), `elapsed` eats that margin and `hermes update` is cut off ("the hermes update timed out", seen on 10-30 and 11-20).
- The other three failures were "no JSON result line": the first end-to-end test in the job hit the test's own 150 s `spawnSync` timeout with no output, on a runner where the next 19 tests took about 1 s each. The first one or two end-to-end runs in a Windows job pay a one-time cost (78 s, 119 s, then 25 s in the slow case; 150 s+, then 14 s, then 1 s in the fast case).
- Fix on branch `agent/ci1-5-ps1-test-budget`: this one test passes `ALANS_WAY_HERMES_BUDGET=250` instead of 100. The reserve cap still discriminates (uncapped reserve 4 x 60 = 240 starves the update at 250; capped 125 leaves 117 s) but now tolerates about 97 s of elapsed time instead of 12 s. Nothing in the product changes. The cold-start cost of the first run is not explained; it is reported, not hidden (see the owner list).

## Slowest unit-test files (`node --test`, one file at a time, 4 files in parallel, measured on a loaded M-series Mac; 121 files, 410 s of summed file time)

| s | File | Why |
|---|---|---|
| 158 | vm-update-script | 117 tests building git remotes/clones; one test is 30 s because it waits out a hung fake `hermes` for the doctor budget (40 s) |
| 50 | vps-host-chrome | launches real headless Chrome, 13 waits |
| 32 | browser-mcp-stdio | spawns the MCP server over stdio, 15 timed waits |
| 31 | mac-computer | runs `swiftc` on the Swift helper and a fixture (macOS only) |
| 30 | speed-replies | launches headless Chrome, 19 timed waits |
| 12.5 | challenge | headless Chrome |
| 10.4 | vps-host | 13 timed waits, 7 spawns |
| 9.2 | computer-helper | helper process |
| 7.8 | batch-flow | |
| 6.9 | eval-approval | |
| 6.2 | hermes-view | |
| 5.8 | browser-mcp | |
| 5.1 | agent-input | 8 timed waits |
| 4.3 | ssh-user-tools | 6 spawns |
| 4.0 | vps-computer | 10 spawns |
| 2.8 | hermes-update | 6 spawns |
| 2.4 | hermes-api, native-chat-queue | |
| 2.3 | gateway-link | |
| 1.8 | win-computer | |

The first five are 301 s of the 410 s: one shard cannot hold more than one of them if the suite is split across jobs, which is why a sharding script balanced on these times beats `--test-shard=i/n` (that splits by file order).

## Changes (branches, in merge order)

Each is one commit on its own branch from `main` (rebased onto `0f541d9`); none is pushed. Branches 1 to 7 merge cleanly in this order; 8 needs 7. Numbers marked "projected" were derived from the tables above, not measured on CI.

| # | Branch | What it does | Effect |
|---|---|---|---|
| 1 | `agent/ci1-1-cancel-superseded-pr-runs` | `concurrency` per PR branch with cancel-in-progress for `tests`, `ios`, `browser-egress`; main pushes and manual runs get a unique group | frees macOS runners sooner; 4.4% of weighted minutes |
| 2 | `agent/ci1-2-merge-group-and-gate` | `merge_group` trigger; `changes` job (iOS-only PRs skip the desktop family); `gate` job to require | enables a merge queue; skips ~90% of a run on 4% of PRs |
| 3 | `agent/ci1-3-shard-unit-tests` | `check` split into `check:syntax` + `check:unit`; unit tests as 3 balanced shards per OS | macOS check 320 s to ~150 s (projected), Linux 134 s to ~60-90 s (projected) |
| 4 | `agent/ci1-4-shard-electron-suites` | the 34 window suites across 4 parallel macOS jobs | 801 s to ~215 s (projected), +14% billed macOS minutes for that job |
| 5 | `agent/ci1-5-ps1-test-budget` | the Windows budget test no longer depends on runner speed | removes 5 of 156 Windows failures if the cause is as found |
| 6 | `agent/ci1-6-job-timeouts` | real `timeout-minutes` on desktop and package jobs; iOS 45 to 25 | a hang costs minutes, not 6 hours |
| 7 | `agent/ci1-7-check-diff` | `npm run check:diff`: syntax + only the unit tests a change reaches | local, 0.4 s selection; 3 s for a single-module change |
| 8 | `agent/ci1-8-quick-pr-feedback` | `quick` Linux job on PRs running `check:diff` | first answer on a PR in ~15-30 s (projected) |

Merge 2, 3, 4 and 6 touch `tests.yml` in separate hunks; 3 and 7 both touch `desktop/package.json` and were placed to avoid a conflict. Branch 3 had to be rebased once already because `main` moved (#336 changed the `check` line and added two tests, whose weights I added). A new unit test file needs no change to run: it is assigned to a shard with the median weight until `desktop/test/shard-weights.json` is refreshed, and `test-shard.test.cjs` fails if the weights name a file that no longer exists.

### Merge queue, selection and the full suite

The brief's rule is that the full suite runs before anything reaches `main`. Today there is no merge queue and no branch protection, so every PR already runs the full set and so does the push to `main`. Selection is therefore only used where it cannot lower that bar: the local `check:diff` and the extra `quick` job. PRs still run everything. Once a merge queue is on and `gate` is required, PR runs could be narrowed to the selection and the queue would run the full set; that is a decision for the owner, not wired here.

## Decided not to do, with the evidence

- **Cache `node_modules` / Electron binary.** `npm ci` is 4 to 6 s including the Electron download, setup is 9 to 14 s p50 in total; a cache restore would cost about as much as it saves.
- **Docs-only path skip.** Not safe here: the desktop tests read `docs/setup-prompt.md`, `docs/gateway-spec.md`, `docs/cu-mcp.md` and `README.md`, and the Python tests scan every `*.md`. Only `ios/**` is provably unread by `desktop/` and is the only skip.
- **Python-only or desktop-only skip of the Python job.** `tests/test_setup_prompt.py` reads `desktop/docs/*.md` and `scripts/check_publication.py` scans the whole tree, so the Python job must run on every change.
- **Drop the macOS copy of the unit suite on PRs.** Of 158 paired runs, macOS failed where Linux passed in 12 (7.6%), Linux alone in 2, both in 3. Eight of those 12 were two tests in `speed-replies.test.cjs`, not run-to-run noise: "navigation replies expose Next for another click" failed on `main` twice on 11-19 (the second click reports `navigated: false` after about 10 s), "Enter in a field outside a form is refused ..." and two more on PRs. That is a macOS-only race in the click-result detection or the test, unresolved here; the macOS copy is the only place it shows, so it stays.
- **Fixed-sleep and timeout cleanup of slow tests.** `vm-update-script.test.cjs` has one 30 s test that waits out the 30 s per-call cap of `vm-update.sh --doctor`; shortening it means lowering the test's own budget to 26 s at best (the call is skipped below 20 s), which saves 4 s of a 154 s file. The other long files spawn real Chrome, MCP servers or `swiftc` and have no cheap fixed wait to cut. The better lever is splitting `vm-update-script.test.cjs` (2,596 lines, shared fixtures) so shard 1 is not one file; not attempted without a way to run it under CI.
- **Retry or wider timeouts anywhere.** None added.
- **A script that fails a run for exceeding a job budget.** GitHub's `timeout-minutes` already fails the job.
- **`npm run precheck`.** The name is taken: `desktop/package.json` has a `precheck` (Electron install) that npm runs before `check`. The new command is `check:diff`.
- **Window suites on Linux under `xvfb`.** Proposal only, not proven (I may not run Electron windows here and cannot run CI). Candidates by evidence: `hermes-conversation-electron` and `hermes-session-wire-electron` already run Electron as plain Node (`ELECTRON_RUN_AS_NODE=1` in `run-workspace-suite.cjs`), so they need no display at all; `plugin-approval-binding-headless` and `plugin-target-binding-headless` use headless Chrome; `electron-fixture` is a `node --test` file. That is 5 of 34 suites, about 100 s of the 790 s. Everything else drives real `BrowserWindow`s and macOS behaviour (focus, Retina, permissions); moving those needs a trial run in CI, which is the owner's call. Branch `agent/q1-hidden-tests` (hidden-window mode) is the other half of that; this work does not duplicate it.

## Before and after

Per pull-request run, no queueing, p50. "Now" is measured; "after" is projected from the step tables above with all eight branches merged.

| | Now | After (projected) |
|---|---|---|
| First answer on a PR (`quick`) | none | ~15-30 s |
| macOS unit tests | 334 s | ~165 s |
| Linux unit tests | 143 s | ~70-100 s |
| `desktop-electron` | 801 s | ~215 s per shard |
| Windows | 553 s | 553 s (unchanged: `hermes-update-ps1` is 483 s) |
| **Slowest job, so PR-to-result** | **13.4 min** | **~9.2 min (Windows becomes the longest)** |
| Weighted minutes per PR run | ~264 | ~298 (+13%): Electron 14 to 16 macOS min, macOS unit 6 to 7, a few Linux minutes |
| macOS minutes per week | 1,290 | ~1,470 before the cancel and skip savings, ~1,410 after (about +9%) |

Splitting the Windows job (its 21 end-to-end cases are independent) or finding why a run costs 24 s would take the median to about 4 min. Queueing is not in these numbers: p95 PR-to-result today is dominated by it (36 min) and sharding more macOS jobs can make it worse, not better.

**Is "under 1 minute at the median" reachable?** Not for the full result on these runners. Cold setup alone is 9 to 14 s on Linux, `npm ci` 4 to 6 s, and the macOS window suites need real macOS runners (about 4 minutes when parallel, longer when the pool is busy). What is reachable is a first red/green in under a minute from the `quick` job on Linux, with the full set following. Getting the full set under 5 minutes at the median needs the Windows job split and, for the p95, runners that do not queue.

## For the owner

Everything below needs an account, a repository setting, or a bigger bill. Costs are monthly at about 4.33 weeks, at the list prices above; if the repo stays public, the GitHub-hosted standard-runner figures are $0.

1. **Turn on the merge queue and require `gate`** (Settings > Rules > Rulesets > Require a merge queue; require the `gate` check from `tests`). $0 for the setting. It adds one full run per merged PR (about 29 PRs a week x about 25 macOS minutes = roughly 725 macOS min a week, about $195 a month at $0.062 if private), unless PR runs are narrowed to the selection afterwards. Effect on p50/p95: none by itself; it is what makes narrower PR runs safe. Recommended: yes, after branches 2 to 4 are merged.
2. **Fix the macOS queue (the p95)**, pick one:
   - *GitHub larger macOS runners*: not available to a personal account (the repo owner is a `User`), they need an organisation on Team or Enterprise (Team is $4 per user per month) and are billed even for public repos; macOS 6-core M1 is $0.16 per minute. If all 1,410 macOS minutes a week moved there and ran about as fast, about $980 a month plus the plan; I did not verify queue behaviour of that pool. Expect p95 queue to fall from 1,100 to 1,700 s to a few seconds.
   - *A third-party macOS runner provider* (Namespace, Blacksmith, WarpBuild, Cirrus and similar): needs an account and a GitHub app install. I could not verify current prices; one secondary source lists a 6 vCPU M4 Pro at $0.08 per minute (about $490 a month for 1,410 minutes, a guess, to be quoted). Effect: likely the same as above.
   - *A self-hosted Mac mini* (about $600 once, plus power and hosting; no per-minute cost): queue goes to about 0 and the Electron suites run on real hardware, but the repo is public, so a self-hosted runner must not run fork PRs (GitHub's own warning), and window suites need a logged-in GUI session on that machine. Effect: p95 queue gone, p50 flat. Cheapest, highest upkeep.
   - Recommendation: stay on GitHub-hosted runners, merge branches 1 to 6, and decide on the runner after one week of real numbers from the sharded jobs. If the queue tail is still over 5 minutes, the self-hosted Mac mini is the cheapest way to remove it; the third-party provider is the least work.
3. **Confirm the repository's visibility.** The API says `public`; the brief says private. If it is public the macOS bill today is $0 and the cost figures are only a "what if". $0.
4. **A Windows diagnostic run.** `hermes-update-ps1.test.cjs` costs 483 s per Windows job (about 20 weighted min per run) and its first end-to-end case sometimes takes 78 to 150+ s while later ones take 1 s. I could not find the cause without a Windows machine. Suggested: one `workflow_dispatch` run with per-call timing printed from `Invoke-Hermes`. $0, 10 minutes of your time to run it.
5. **After merging 3 and 4, set `timeout-minutes` down** to about twice the new job times (a one-line edit in each job), and refresh `desktop/test/shard-weights.json` from a real run. $0.

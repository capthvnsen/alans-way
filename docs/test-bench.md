# The test bench

A throwaway Hermes on the owner's Linux VM that automated agents may use, so the app's chat, gateway and queue code stop
being checked only against fakes. It is **not** the production Hermes and shares nothing with it.

Status: designed and written, **not yet provisioned anywhere**. The scripts have only been dry-run, and the runner has only
been run against the in-repo fake (`desktop/test/bench/fake-bench-backend.cjs`). The first real provisioning is a human step.

## The short version

- One dedicated Unix user on the VM (`hermes-bench`) owns everything: its own Hermes home, state, logs, secrets and two
  systemd *user* units. Production runs as another user and is never touched.
- Two listeners, on ports that Hermes does not use by default: the API server on loopback `28642`, and `hermes serve` on
  the VM's tailnet address `29119`. Nothing is bound to a LAN or public address.
- A cheap model through a provider key made for the bench alone, tools limited to `clarify`, no Telegram or any other
  messaging platform.
- Secrets are generated on the VM, written to 0600 files and never printed. A fetch script copies one credentials file
  to a 0600 file on the Mac; the runner reads that file and redacts everything it prints.
- Every start, stop, reset and uninstall names the bench's own unit or pid file. No script matches a process by name.

## Files

| Path | What it is |
| --- | --- |
| `scripts/test-bench/provision.sh` | Runs on the VM. Creates the user, config, secrets and units. Dry run unless `--apply`. |
| `scripts/test-bench/status.sh` | VM, read-only. Facts about the bench, no secrets. |
| `scripts/test-bench/control.sh` | VM. `start` or `stop` the bench's two units. |
| `scripts/test-bench/reset.sh` | VM. Back to a clean bench: wipes stored state, keeps config and secrets. |
| `scripts/test-bench/uninstall.sh` | VM. Removes the bench (and with `--remove-user`, the account). |
| `scripts/test-bench/fetch.sh` | Mac. Copies the credentials file to `~/.alans-way-test-bench/credentials.json` (0600). |
| `scripts/test-bench/tunnel.sh` | Mac. SSH tunnel to the bench's loopback API port, tracked by its own pid file. |
| `desktop/test/bench/run.cjs` | Mac. The scripted real-backend session (see below). |

All VM scripts take `--user <name>` (must be `hermes-bench` or `hermes-bench-<suffix>`) and, where they change anything,
`--apply`. Without `--apply` they print every action and do none of them.

## How the bench is kept apart from production

Hermes itself says one backend serves every profile of an OS user, and that "separate OS users have separate `$HOME`s,
separate `~/.hermes` profile roots, separate ports-by-convention and separate credentials"
(`gateway/host_rendezvous.py:1-30`, `gateway/status.py:321-337`). A second *profile* would not be isolation: a named profile
is served from the default profile's listener (`gateway/config.py:306-320`), and a second `hermes serve` under one user
**attaches to the running one and exits** instead of starting (`hermes_cli/main_dashboard.py:895-960`). So the bench is a
second *user*, not a second profile.

| What | How it is separated |
| --- | --- |
| Unix account | `hermes-bench`: its own uid and group, login shell `nologin`, no password, no ssh key, no sudo, no other group (provision refuses if `id -nG` shows any). Home mode `0700`. |
| Hermes home | `~hermes-bench/bench-home`, set as `HERMES_HOME` by the launcher scripts. Hermes' state database, sessions, memory, `.env` and logs all live under it (`hermes_constants.py:206`, `hermes_cli/config.py:433,473`). |
| Singleton locks and "attach" records | `HERMES_GATEWAY_LOCK_DIR` and `XDG_STATE_HOME` point at `~hermes-bench/bench-state`. `hermes serve` also gets `--isolated`, which skips the attach step (`hermes_cli/subcommands/dashboard.py:32-35`). |
| Ports | `28642` (API server) and `29119` (`hermes serve`). Hermes defaults are `8642` and `9119`, and the optional webapp listener is `9120` and off (`gateway/platforms/api_server.py:154-155`, `hermes_cli/subcommands/dashboard.py:18-19`, `hermes_cli/config_defaults.py:982`). Both are below the OS ephemeral range. Provision refuses if either port is already in use by anything but the running bench. |
| Network | API server: `127.0.0.1` only (`gateway.api_server.host`). `hermes serve`: the VM's tailnet address, which must be in the `100.64.0.0/10` tailnet range or provision refuses. Hermes requires password sign-in on any non-loopback bind (`hermes_cli/web_server.py:370-381,974-1030`). Tailnet ACLs are the owner's to set; restrict `29119` to the Mac. |
| Units | `hermes-bench-gateway.service` and `hermes-bench-serve.service`, in the bench user's own systemd instance (`~/.config/systemd/user`). Production's units belong to another user manager, so the names cannot collide. |
| Logs | `~hermes-bench/bench-logs/{gateway,serve}.log` plus Hermes' own logs under `bench-home/logs`. |
| Messaging | The bench `.env` holds no bot token of any platform, and provision refuses to run if one appears. Hermes starts a platform only when it has credentials. |
| Production's files, memory, vault, sessions | The bench user is a different uid with no shared group. What stops it reading production is **production's own permissions** (a home directory the bench uid cannot enter, normally mode `0700`). The scripts do not change production's permissions; they **check**: `provision.sh --prod-home <dir>` runs `ls <dir>` as the bench user and refuses if it succeeds, and `status.sh --prod-home` repeats the check. Only `~hermes-bench` is writable by the bench user. |
| Signalling production's processes | A process can signal another only with the same uid (or root). The bench user is not root and has no sudo, so even a wrong pid cannot reach production. |
| Resource limits | `MemoryMax=1500M`, `TasksMax=300`, `NoNewPrivileges`, `PrivateTmp` on both units. |

### Why tools are limited

The API server "gives full access to hermes-agent's toolset, including terminal commands"
(`website/docs/user-guide/features/api-server.md:818-822`). A bench key is held by automated agents, and the VM is on the
tailnet, so a terminal tool would be a way into everything the VM can reach. The bench enables one toolset, `clarify`, in
three places:

- `platform_toolsets.api_server: [clarify]` for the REST path (`gateway/platforms/api_server.py:2215` reads exactly this; `clarify` is a toolset at `toolsets.py:150`).
- `platform_toolsets.cli: [clarify]` and the environment pin `HERMES_TUI_TOOLSETS=clarify` for the WebSocket path. The pin wins over config and an unrecognised pin falls back to config rather than to "all tools" (`tui_gateway/agent_factory.py:393-418`).
- Memory is off (`memory.memory_enabled`, `memory.user_profile_enabled`: `hermes_cli/config_defaults.py:1295-1296`).

Consequence: **approval round trips cannot be tested on the bench**, because an approval needs a command to approve. See
"What it does not cover".

## Hermes commands and keys used

Hermes source cited at the commit that was read (`b5f15a6d31`, `capthvnsen/hermes-agent`, `--depth 1`).

| Used | Where it is defined |
| --- | --- |
| `hermes gateway run --external-supervisor` (the API server host; run by a systemd unit, never `--replace` or `--force`) | `hermes_cli/subcommands/gateway.py:70-117` (`--replace` :84, `--force` :89, `--external-supervisor` :110) |
| `hermes serve --isolated --host <tailnet ip> --port 29119` (the WebSocket gateway and sign-in) | `hermes_cli/subcommands/dashboard.py:18-19,32-35,60-95` |
| `HERMES_HOME` | `hermes_constants.py:206` |
| `API_SERVER_KEY` in `.env`, at least 16 characters, the server refuses to start without it | `gateway/platforms/api_server.py:1058,3906-3935` |
| `gateway.api_server.{enabled,host,port,model_name,max_concurrent_runs}` in `config.yaml` | `website/docs/user-guide/features/api-server.md:830-858`, `gateway/platforms/api_server.py:161-170,1096` |
| `model_name` shows on `GET /v1/models`; the runner refuses a server that does not call itself `alans-way-test-bench` | `gateway/platforms/api_server.py:2316-2330` |
| `HERMES_DASHBOARD_BASIC_AUTH_USERNAME`, `_PASSWORD`, `_SECRET` (the bundled password provider; the secret keeps sessions across restarts) | `plugins/dashboard_auth/basic/__init__.py:196-285` |
| `model.default`, `model.provider` in `config.yaml`; `OPENROUTER_API_KEY` in `.env` | `hermes_cli/config_defaults.py:22-30`, `hermes_cli/config.py:862` |
| `agent.max_turns: 4`, `agent.run_budget_seconds: 120` (per-run caps on tool loops and wall clock) | `hermes_cli/config_defaults.py:66,73` |
| `POST /api/sessions` with our own `id`: `201`, and `409` for an id that exists or was deleted | `gateway/platforms/api_server.py:2574-2642` |
| `session.compress` needs at least 4 messages in the conversation | `agent/conversation_compression_manual.py:19`, `tui_gateway/session_compression.py:279` |

Deliberately **not** used, because they act on every Hermes process of a user or on the production service: `hermes serve
--stop` and `dashboard --stop` (they scan the process table, `hermes_cli/main.py:2387-2410`), `hermes gateway
start|stop|restart|install`, `--replace`, `tailscale serve|funnel` (machine-wide). A test in
`desktop/test/bench-scripts.test.cjs` fails if any script contains one of them, or `pkill`, `killall`, `pgrep`, `set -x`,
or a line that prints a secret variable.

### Spending

Hermes has no local dollar cap for a provider key: the only monthly cap it knows is the Nous Portal's, and that is
"portal-only" (`hermes_cli/cli_billing_mixin.py:1148-1158`). So the caps are layered:

1. **The provider key.** Make the bench's OpenRouter key a new key with a credit limit of a few dollars (an OpenRouter
   feature, not a Hermes one; not confirmed from Hermes source). This is the real ceiling; it also bounds the background
   calls Hermes makes with the same key (conversation titles, compaction summaries).
2. `agent.max_turns: 4` and `agent.run_budget_seconds: 120` bound a single run; `max_concurrent_runs: 2` bounds parallelism.
3. The runner's prompt counter (below): 24 by default, 60 at most, whatever the config file says.

**Model.** The cheapest sensible choice is a small, fast, tool-calling model: `anthropic/claude-haiku-5-5` on OpenRouter
(an assumed id and price, set with `--model`). A run sends five short prompts (six with `--clarify`), each carrying
Hermes' system prompt (assume 8k input tokens), plus one compaction summary and two titles: about 50k input and 2k output
tokens. At an assumed $1 per million input and $5 per million output that is **about $0.06 per run**; call it $0.30 if the
price is five times higher. The worst case the runner allows (60 prompts) is under $3. These are estimates: measure the
first real run from the provider's usage page and replace this paragraph with the number.

## Credentials: how an agent gets them without seeing them

1. `provision.sh` generates the API key, the dashboard password and the session-signing secret with `openssl rand` **inside
   the bench user's shell**. Their values are only ever in shell variables and `printf` redirected into files, never in a
   command line (which `ps` would show) and never on a terminal.
2. They land in `~hermes-bench/bench-home/.env` (0600; Hermes reads it) and in `~hermes-bench/bench-credentials.json` (0600),
   a small JSON file: `gateway_url`, `api_url`, `username`, `password`, `api_key`, and a `marker`.
3. The provider key is not generated. The human puts it in a 0600 file on the VM and passes `--provider-key-file`; it is
   piped into the bench user's shell on standard input.
4. `fetch.sh <ssh-target>` runs `sudo -n -u hermes-bench cat <file>` over ssh with standard output redirected into a file
   under `~/.alans-way-test-bench/` (directory 0700, file 0600). It checks the JSON has the right keys without printing it.
   The VM needs one passwordless sudoers rule for exactly that command; nothing broader.
5. The runner takes `--config <that file>` and refuses unless it is a regular file (not a link), mode exactly `0600`, owned by
   the current user. Everything it prints goes through a redactor that removes the key, the password and every token it
   obtained. An agent that runs the runner sees pass/fail lines and timings, never a credential.

Agents must pass the **path** of the file around, never its contents, and must not `cat`, `echo` or log it.

## Procedures (for the human)

Needed first: a new OpenRouter key with a credit limit; a Hermes install the bench user can execute (if production's lives in
a private home directory, install Hermes for the bench user by the same method and use that path); `sudo` on the VM; Tailscale
up on the VM and the Mac.

1. **Stage the provider key** (on the VM, in `bash`): `umask 077; read -rs K; printf %s "$K" > ~/bench-provider-key; unset K`, then paste the key and press Enter. Nothing is shown.
2. **Look first:** `scripts/test-bench/provision.sh --hermes-bin <path to hermes> --prod-home <production user's home> --provider-key-file ~/bench-provider-key`. It prints the plan and every action as `DRY-RUN:`. Read it. Success: the plan names `hermes-bench`, ports `28642` and `29119`, a tailnet address, and ends with "done. facts".
3. **Do it:** the same command plus `--apply`. Success: it ends with the same "done. facts" block, no `refused:` line. If it says it cannot read production and refuses, that is correct: tighten production's home directory yourself, then re-run.
4. **Delete the staged key:** `shred -u ~/bench-provider-key` (or `rm`).
5. **Check:** `scripts/test-bench/status.sh --prod-home <production user's home>`. Success: both units `active`, both ports `listening`, files `mode 600`, "production ... is not readable", and `api check 200, names itself alans-way-test-bench`.
6. **On the Mac:** `scripts/test-bench/fetch.sh <ssh-target>`. Success: "saved: ~/.alans-way-test-bench/credentials.json (mode 0600; contents not shown)".
7. `scripts/test-bench/tunnel.sh start <ssh-target>`. Success: "tunnel up: 127.0.0.1:28642 -> the bench API server".
8. `node desktop/test/bench/run.cjs --config ~/.alans-way-test-bench/credentials.json`. Success: every line `PASS` (one `SKIP` for the clarify probe), "OK: ...".
9. `scripts/test-bench/tunnel.sh stop <ssh-target>` when done.

**Start / stop** (VM): `scripts/test-bench/control.sh start --apply` / `stop --apply`. Stop is `systemctl --user stop
hermes-bench-serve.service hermes-bench-gateway.service` as the bench user. If a unit leaves a process behind, the script reads
the bench's own pid file (`~hermes-bench/bench-state/{gateway,serve}.pid`, written by the launcher just before it `exec`s
Hermes) and ends that pid **only if** its `HERMES_HOME` is `~hermes-bench/bench-home` and its working directory is
`~hermes-bench/bench-state`; otherwise it leaves the process alone and says so. It then waits 15 seconds before `SIGKILL`,
re-proving the same facts first.

**Reset to clean** (VM): `scripts/test-bench/reset.sh --apply [--start]`. Stops the bench, then deletes everything in
`bench-home` except `.env` and `config.yaml`, and empties `bench-logs` and `bench-state`. The credentials file stays valid, so
the Mac needs no new fetch. Checks first: the bench marker exists and `bench-home` resolves to where it should.

**Uninstall** (VM): `scripts/test-bench/uninstall.sh --apply [--remove-user]`. Stops and disables the two units, deletes the
bench's directories, credentials and unit files; `--remove-user` also disables linger, ends that user's sessions
(`loginctl terminate-user`) and deletes the account with `userdel --remove`. Every step first checks the bench marker; an
account named `hermes-bench` that lacks it is refused.

## What the bench must never be used for

- Anything about the production Hermes, its bots, its data or its users. The bench has none of them; if a test needs them, it is not a bench test.
- Load or soak testing, or anything that sends prompts in a loop. The runner has a counter for this; do not route around it.
- Real personal or customer data in a prompt. The bench provider key sees whatever is sent.
- Running tools, browsing, or "just trying a command": only `clarify` is enabled and that is deliberate.
- Putting a different provider key, a bot token or a production secret into the bench's `.env`.
- Exposing it: no `tailscale serve`/`funnel`, no wider bind address, no port forwarding other than `tunnel.sh`.

## Rules for agents using it

1. Use the runner (or code that reuses its safety checks), with `--config <path>`. Never open, print or copy the file's contents.
2. Create conversations only with ids beginning `bench-`, delete them when done, and send nothing that is not a short test prompt. Do not run two benches at once (`--sweep` deletes leftover `bench-` conversations from a crashed run).
3. Stay under the prompt cap. If a run hits it, that is a bug to fix, not a number to raise.
4. Never stop, restart, reconfigure or signal anything on the VM yourself. Ask the human to run `control.sh` or `reset.sh`.
5. Never use `pkill`, `killall`, or a command that selects processes by name, on the VM or on the Mac. Stop the tunnel with `tunnel.sh stop`.
6. Report failures with the runner's output only. It contains no secret, and nothing else should be pasted.
7. A real-backend result is evidence about the bench's Hermes version at that moment; say which one when quoting it.

## The runner

`node desktop/test/bench/run.cjs --config <file> [--clarify] [--max-prompts N] [--sweep]`. No window, no Electron, no app
profile. It uses the app's own modules: `hermes-remote` (sign-in, tickets), `gateway-link` and `gateway-api` (the
WebSocket), `hermes-api` (REST and SSE) and `native-chat` (queue, compaction, history), against the bench.

Before it sends anything it refuses unless: the file is 0600, a plain file and ours; both addresses are loopback, a literal
tailnet address or an `https://*.ts.net` name (and the REST one is loopback or https, the rule `hermes-api.cjs` itself
applies, so a tailnet API is reached through `tunnel.sh`); and `GET /v1/models` on the API address names itself
`alans-way-test-bench`. A tunnel pointed at production by mistake fails the bench-key and bench-name checks, because production has neither.

| Check | What it proves |
| --- | --- |
| `signin` | password sign-in through the app's own PKCE flow |
| `link-live` | the WebSocket comes up and `gateway.ready` arrives |
| `create-conversation` | an id the client chose is created once and listed once; a second create is `409` |
| `reply-websocket` | a reply streams over the WebSocket; first token and total time |
| `reply-rest-sse` | the same over REST+SSE |
| `usage-after-reply` | `session.usage` reports a context size after a reply |
| `second-turn`, `history-matches` | what was sent and received matches the stored history, in order, on both transports |
| `compact-then-send` | native chat's compact-before-send flow runs `session.compress`, then the next message is answered |
| `queued-while-down` | with the link taken down on the client side, a message is held, then delivered **exactly once** (one stored user row, one prompt counted) |
| `clarify-roundtrip` | only with `--clarify`: asks the model to call `clarify`, answers it, expects the run to finish; `SKIP` if the model does not call it |
| `cleanup` | every conversation the run created is deleted |

Two honest limits. **Compaction:** Hermes reports the real context size and a cheap session never reaches the compaction
threshold, so the runner shows native chat the size inflated to 90% of the window; the decision to compact is the client's,
the `session.compress` that follows is the real one. **Approvals** are not covered (no terminal tool, see above).
It also does not exercise native chat's create-on-first-send path, because that path invents an `api_...` id and the runner
creates only `bench-` ids.

Safety: one counter sees every prompt, including the ones native chat sends and any duplicate it might send, and stops at the
cap; conversations are created only through a wrapper that refuses a non-`bench-` id, and deleted only through a deleter that
refuses the same; each id is also appended to a ledger file next to the config as it is created, so a crash can be swept up
with `--sweep`; exit code 0 all good, 1 a check failed, 2 refused to run.

Against the in-repo fake it prints (timings vary):

```
PASS  signin                      8 ms  provider basic
PASS  link-live                  22 ms  WebSocket attached
PASS  create-conversation         5 ms  created once, second create 409
PASS  reply-websocket           132 ms  first token 7 ms, total 132 ms, 3 deltas
PASS  reply-rest-sse            128 ms  first token 4 ms, total 128 ms, 3 deltas
PASS  usage-after-reply           1 ms  context 3800 of 200000
PASS  second-turn               125 ms  first token 2 ms, total 125 ms, 3 deltas
PASS  history-matches             2 ms  3 user and 3 assistant messages match, in order
PASS  compact-then-send         188 ms  session.compress ran, then the message was answered
PASS  queued-while-down        3171 ms  held while the link was down, delivered exactly once after it returned
SKIP  clarify-roundtrip         127 ms  the model did not call clarify
PASS  cleanup                deleted 4 conversations
OK: 11 passed, 0 failed, 1 skipped; prompts used 6 of 24
```

## Later: iOS and the plugin repo (design only, not built)

**iOS.** `ios/scripts/test-gateway-integration.sh` starts the desktop fake and passes its address to `xcodebuild` as
`TEST_RUNNER_GATEWAY_FAKE_URL`. A bench mode would take `BENCH_CONFIG=<credentials file>`, run the same refusals as the
runner (0600, tailnet or loopback, names itself the bench) in a small shared Node helper, start `tunnel.sh` if the config's
API address is loopback, and pass the URL and credentials to the tests as `TEST_RUNNER_*` environment variables, which do not
appear in the command line. The tests would be a separate class that skips unless those variables are set, with the same
`bench-` id rule and prompt cap. The simulator shares the Mac's network, so the tailnet address works as it does for the
desktop. The script must not enable `set -x`.

**Plugin repo.** The Hermes plugin's real-backend tests would read the same file through `HERMES_TEST_BENCH_CREDENTIALS=<path>`
(unset means skip), apply the same four refusals, and talk to the API server only. It gets the same rules: `bench-` ids,
cleanup, a prompt budget, no printing. Nothing in the plugin repo should hold the file or a copy of it.

## Things assumed, not confirmed from Hermes source

1. A provider-side credit limit per key exists at OpenRouter and the owner can set it (it is the real spending cap).
2. The model id `anthropic/claude-haiku-5-5` exists on OpenRouter, and the price assumed in the cost estimate.
3. `hermes gateway run --external-supervisor` starts under a plain user unit without `hermes gateway install`, and does not refuse because it detects a service for the profile. If it does refuse, the gateway unit fails and `status.sh` shows it.
4. `hermes serve` loads `bench-home/.env` at start, so the dashboard password variables reach the password provider (the provider reads the environment, `plugins/dashboard_auth/basic/__init__.py:245-285`).
5. `platform_toolsets.api_server: [clarify]` leaves no always-on tools beyond `clarify`; the runner does not verify the tool list. Check once with `GET /v1/toolsets` through the tunnel.
6. Hermes does not `chdir`, so the launcher's working directory is what `/proc/<pid>/cwd` shows. If it differs, the pid-file fallback refuses to kill (the safe failure).
7. `--isolated` has no side effect on a user that runs no other backend; it is recorded in the spawn ledger (`hermes_cli/web_server.py:1431`), which is per user.
8. Hermes opens no other TCP port in this configuration. `gateway.control_socket` is a Unix socket under the bench's home.
9. `order=latest` is honoured by the history route (the app uses it) and rows carry numeric `id`, `role`, `content`.
10. The WebSocket path streams deltas. If the VM's Hermes sends whole replies, the runner reports "whole reply (no deltas)" and measures the first token as the completed text.
11. After `session.compress` the same conversation id keeps working for the next message. The runner checks the reply through native chat's own state, not stored history, for that reason.
12. `session.compress` returns `status: compressed` for a short, cheap conversation of four or more messages. If Hermes says no, `compact-then-send` fails with Hermes' reason, which is information about Hermes.
13. systemd on the VM is at least 240 (`StandardOutput=append:`) and delegates `memory` and `pids` to user units (otherwise `MemoryMax`/`TasksMax` are silently not applied).
14. `useradd`, `loginctl`, `ss`, `openssl`, `curl` and `stat -c` exist (a mainstream Linux).

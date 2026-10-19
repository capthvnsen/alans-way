# Optional vanilla Hermes approval fixture

`test/vanilla-hermes-approval.py` exercises the installed public Hermes CLI, a
workspace stdio MCP router, the matching connector and loopback browser host,
and a separate headless Chromium. It is explicitly opt-in and is not part of
`npm check`. It imports no Hermes implementation and changes no production code.

The model endpoint is a deterministic inert **model-fixture transport**. It
chooses only actually advertised workspace MCP tools, using public discovery
when enabled. This establishes bounded transport and approval behavior, not
model intelligence, authenticated operation, or vendor task parity. Scripted
PTY choices do not establish independent human or native GUI acceptance.

## Run

Use macOS with an existing default-root source installation of public `hermes`,
Python 3.9+, Node, cached Chromium, and existing prebuilt Hermes TUI assets.
The fixture never installs, repairs, builds, or bypasses the public launcher.
Set these paths to one coherent immutable desktop/plugin candidate:

```sh
python3 desktop/test/vanilla-hermes-approval.py --run \
  --desktop "$DESKTOP_CANDIDATE" --plugin "$PLUGIN_CANDIDATE" \
  --runtime "$HERMES_RUNTIME_STORE" --chrome "$CHROMIUM_EXECUTABLE" \
  --borrow-default-root --interface tui --tui-dir "$PREBUILT_HERMES_TUI" \
  --tool-search off --out evidence/quality/vanilla-approval/new-run
```

For a focused two-action turn, add `--scenarios queue,queuedecline,queuestale,queuetimeout`.
These scenarios require `--interface tui --tool-search off`. Each opens and
snapshots two distinct inert tabs, then emits both directly advertised action
calls in **one model response**. This offers concurrency through the public
protocol; it does not force Hermes to run calls concurrently.

`--tui-dir` supplies documented `HERMES_TUI_DIR` and requires existing
`dist/entry.js` and `node_modules`. `--runtime` supplies `HERMES_RUNTIME_DIR`.
The output must be new, outside the Hermes root and candidate directories.
`--borrow-default-root` creates a fresh owned
`~/.hermes/vanilla-approval-<32 hex digits>` home to share committed dependencies.
Optional `--owned-home` accepts only a previously nonexistent name of that form
immediately beneath the default root. Existing homes are never adopted.
An arbitrary external home failed before `--version` on this installation; no
installation facts are copied or edited to bypass dependency selection.

## Configuration and confinement

One Seatbelt child policy denies external IP connections, permits loopback and
Unix transports, and denies writes across the **entire existing Hermes root**,
including root state WAL/SHM, profiles, config/auth, source, payloads, tools,
facts, and installation inputs. Exceptions cover the fresh owned home, exactly
the existing install `.install.lock` and PM `.prepare.lock`, and new direct UUID
leases in the two already committed app/PM generations. Every observed existing
install lease is individually denied writes, including unlink/pruning. No
payload, dependency provisioning, repair, selection, or generation-pruning
permission is added. Candidate directories, fixture workspace outside the output directory,
existing runtime/TUI assets, and the Chrome executable directory are protected.
The resolved public launcher is also write-protected and write-open probed.

**Before any public Hermes command**, the fixture requires kernel `EPERM` for
bounded file write-open probes and a connection to the documentation-only
external address `192.0.2.1`. File probes use `O_WRONLY` without create,
truncate, or write; they neither read nor change existing profile/config
contents. `confinement-proof.json` and the exact policy preserve this evidence.
Failure stops the run; there is no unconfined fallback. Do not wrap the fixture
in another Seatbelt policy: the tested nested sandbox failed before Hermes
`--version`, and also prevented controller process observation.

Public help/config capability output is recorded after those proofs. The
fixture configures only its owned home through `hermes config set`, passing
strings as raw arguments and nonstrings as JSON. It copies that home's actual
`config.yaml` to `effective-config.yaml`; `config show` exits zero with help on
the tested CLI and is not configuration proof. The tested effective values are
`tools.tool_search.enabled: "off"`, disabled memory/profile-memory booleans,
`toolsets: []`, a custom loopback `chat_completions` provider with a placeholder
key and model discovery disabled, and the local workspace MCP server with
elicitation enabled. False, zero, null, list, and object arguments retain their
types in the command regression check.

With `--tool-search off`, actual model requests must declare direct workspace
MCP tools without `tool_search`, `tool_describe`, or `tool_call` wrappers.
`discovered-tools.json` and `effective-discovery.json` record those declarations.
Additional built-in tools were advertised despite the saved empty `toolsets`
list; the inert transport emitted no calls to them. It uses interactive
`hermes chat --tui --native`, with no one-shot, yolo, or approval bypass.

The configured MCP command uses a test-only stdio observer that launches the
matching unmodified workspace router with explicit `ALANS_WAY_AGENTS`. It
forwards exact bytes and records timestamped public JSON-RPC lines in
`mcp-wire.jsonl`; it does not inject, reorder, answer, or modify protocol messages.
Its byte-preservation regression uses a real child process. The observer and
router inherit the same child confinement.

Every scenario-bearing model request validates its current declarations before
selecting a tool, including later action requests. Missing/empty declarations
and eager-mode discovery wrappers fail the fixture. The observed tool-free
session-title request has a separate explicit branch: it has only system/user
messages and the public title prompt, even though it quotes `FIXTURE approve`.
Other ancillary requests without a scenario select no tool. The focused handler
regression uses actual loopback HTTP without starting Hermes or a browser:

```sh
python3 -B -m unittest discover -s desktop/test -p test_vanilla_fixture_contract.py -v
```

The controller, its loopback model/page servers, and filesystem
setup/export/audit helpers run **outside Seatbelt**. Public config/help and chat
children, inherited backend/MCP children, browser host, and headless Chromium
run inside it. Other filesystem locations and the parent environment are not a
global confinement or profile-invariance claim. No visible app, OS focus,
hotkey, permission, or clipboard interaction is performed.

## Evidence and cleanup

The default conversation offers eight normal flows: Allow once, Deny, Escape,
ordinary page self-refresh during approval, fresh review of that same tab,
session choice, another explicit approval, and unanswered timeout. `--scenarios`
selects a bounded subset. Inert pages record trusted input and local requests.
Accepts require exactly one trusted click and one destination request; refusals
require zero input and destination requests. Only the router creates receipts.

The four opt-in two-action scenarios select session choice then Deny (`queue`),
Deny then Allow once (`queuedecline`), ordinary self-refresh of the first reviewed
tab then Allow once for each (`queuestale`), and no answers (`queuetimeout`).
Checkpoints require zero effects before the first answer and zero effects on
the second target before its own answer. Final checks require exactly two
public action requests, distinct elicitation IDs, results bound to their tool
call IDs, and the expected per-target click/request counts. Final results may
arrive in a different order; the inert transport binds them by `tool_call_id`
and emits no repeat. These are bounded observations with an inert transport,
not a guarantee about another model's retry behavior.

`transcript.ansi` is authoritative real PTY output. The text/HTML derivatives
are ANSI-stripped redraw streams, not reconstructed screens or GUI screenshots.
Pending texts, input timestamps, real model/tool conversation, snapshots,
decisions, effect counts, capabilities, source hashes, and cleanup receipts are
saved. `declaration-validation.json` indexes every validated scenario request;
the model log retains all requests and scenario responses. `outcome.json` includes
wall time, model-request count, and PTY byte count as bounded performance metadata.
The scripted matcher accepts the action summary or the card's unique reviewed
URL, since differential redraw streams can omit unchanged characters. It checks
settlement before matching and requires a still-pending public elicitation before
each two-action choice. Matching these bytes does not reconstruct a terminal screen.
Generated profiles/connection files contain ephemeral private runtime
data and must remain ignored; publish only reviewed source and documentation.

Cleanup requires positive direct exits, exited observed descendants using
parent/group relationships and process start identities, no unknown command
markers for the owned home/output, no owned-home handles, closed recorded
loopback endpoints, and no surviving positively owned lease. Lease ownership
requires a new path held open by an observed owned process identity; filenames
alone grant no ownership. Unknown shared-install lease changes are reported
with attribution unknown, never signaled/deleted, and do not require global
quiescence. Owned identity/handle/endpoint uncertainty retains the home and
fails. Only after those checks is the owned home exported and its original
deleted. Review `owned-home-cleanup.json`, `observed-process-tree.json`,
`owned-home-handles.json`, `endpoint-cleanup.json`, and `lease-cleanup.json`.
These observations do not exclude every unobserved detached process.

## Observed compatibility and limits

The earlier default-discovery TUI builder run covered all eight cases. Its
purported eager run used a quoted `off` string and did **not** establish eager
behavior. The corrected config/confinement revision passed focused eager public TUI
Allow once (one trusted click/one destination request) and a separate
stale-document refusal (zero input/requests) followed by fresh-review recovery
on that same tab (one click/one request). Both controllers exited zero and
cleaned their owned homes against the immutable `control-receipts-round1`
desktop/plugin products, with actual declarations saved. These three cases do
not establish a new eight-case matrix.

The independently observed classic interactive `--cli` limitation is inherited
compatibility evidence: actual eager tools returned `declined` with no panel or
browser input, logging a missing thread-local approval callback while
prompt_toolkit was active. This source revision does not rerun that classic
case. To investigate it separately, replace the TUI options with
`--interface cli --tool-search off --scenarios approve`; the fixture correctly
exits nonzero when no approval panel appears.

Earlier TUI session-choice evidence still required a later elicitation to be
answered; Escape became `declined`. Stale-document refusal appended a generic
“may have executed” caution despite zero observed input. Generic “Allow this
session / Always allow” labels do not establish durable MCP consent scope.

A focused eager public TUI run now submits two actions together. The observed
public MCP path **serializes them**: the first action's result precedes the
second action request and elicitation. Selecting “Allow this session” sends an
ordinary MCP `accept` for the first action; the second still displays its own
approval panel. Denying it produces zero input and destination requests. This
establishes the visible session option's observed limit on this path; it does
not establish durable consent or the scope of “Always allow”.

The focused matrix also observes first-target decline followed by a separately
approved second target, first-target stale-document refusal followed by a
separately approved second target, and two successive unanswered timeouts.
Refused/timed-out targets have zero observed input and destination requests;
each accepted target has one trusted click and one destination request. The
second action is never transmitted before the first result on this tested path.
Two simultaneously pending elicitations, concurrent TUI queue order, and a
refusal/timeout/stale document while another elicitation is already pending
remain untested because this public path serializes calls. No concurrent queue
was manufactured. Also untested are native/human handoff, remote hosts, real
accounts/providers, SSH, Telegram/gateway, session transfer/failover, malformed transport, and forged or
replayed receipts. These results establish no universal browser/business safety
or global existing-profile invariance.

# Experimental keeper: bounded protocol research, not live ingress

`hermes_companion.experimental.keeper` is a standard-library-only public
JSON-RPC client. It imports no native Hermes implementation, starts no process
or listener, and has no CLI integration or installation path. This is research
code, not an always-on session owner, agent, approval surface, or messaging
courier.

**Do not attach it to a live conversation until server-request routing is
separately handled and tested.** Returning an unsupported-request error can
withdraw an approval or clarify question even though it never auto-approves.
A passing attachment test is not permission to connect to a user's session.

## Identity and allowed operations

The caller must independently review and supply the exact `profile`, stored
`session_key`, and process-local live `session_id`, plus `reviewed=True`.
Empty or whitespace-padded identifiers are refused, not repaired. The profile
label is caller metadata, **not server attestation**. The client does not
perform transport authentication or verify the server's profile.

A supplied wire must implement `send(frame)` and `receive(timeout)` and honor
bounded I/O. Attachment waits for `gateway.ready` with a replay epoch, requires
`per_session_exclusive_submit is True`, negotiates server requests, checks the
exact live ID/key pair, and verifies the activation response. No discovery,
resume, fallback creation, key rotation following, or lineage guessing occurs.

The only outbound RPC methods are:

```text
gateway.capabilities
client.capabilities
session.active_list
session.activate
session.events.since
ping
```

Activation uses `omit_messages: true`. No prompt submission, creation, automatic
retry, approval success, platform send, native internal import, database write,
or server patch is implemented by the keeper. Activation and unsupported-request
responses are nevertheless **not side-effect-free**: they alter subscription
and can affect request lifecycle.

A separate native launcher process is **not authenticated attachment to an
existing cloud owner**. It has a separate runtime and epoch. Never launch a
second gateway against a real profile in an attempt to join an existing stdio
connection.

## Fail-closed observation and limits

`Keeper.attach(wire)` explicitly negotiates a caller-supplied transport.
`Keeper.keep(seconds=..., interval=...)` periodically probes `ping` and the
reviewed live identity while pumping events. `pump_once()` requires attached
state. Detected contract drift, missing identity, malformed relevant frames,
RPC errors, epoch changes, replay gaps, and replay truncation block observation.
Transport EOF detected by `pump_once()` marks disconnected. Idle receive timeout
alone is not a failure; a send timeout while answering a request is a failure.
Failures during attachment or an RPC may be reported as blocked rather than
classified as disconnected. There is no automatic reconnection.

Explicit reattachment on the same object uses the captured watermark with
`session.events.since`. A changed epoch blocks before activation. Same-epoch
replay checks epoch, truncation, sequence type/non-regression, and collection
shapes, then reconciles request metadata. If a review is needed, do not repeatedly
reattach hoping to bypass a block. State is in memory; there is no restart
checkpoint. **A keeper cannot make ordinary sessions restart-durable.** Event
ring replay is not durable prompt admission or completion evidence.

Bounds and responsibilities:

- Observation duration: `0 < interval <= seconds <= 3600`.
- RPC timeout, pump timeout, and stdio send timeout: `(0, 60]` seconds; booleans,
  nonnumeric values, NaN, and infinity are refused.
- The observation duration is **not a strict total wall-clock deadline**.
  Handshake/probes comprise several separately bounded receive/send operations.
- `StdioWire` caps outgoing frames and its incoming buffer at 1 MiB. It uses
  caller-owned exclusive binary **POSIX pipes**, changes the writer descriptor
  to nonblocking, and does not close it. Do not share readers or buffered writers.
- `StdioWire.receive(timeout)` is a low-level caller-supplied deadline; the keeper
  supplies validated finite timeouts. A custom wire must enforce its own framing,
  bounds, authentication, and resource ownership. Blocking custom code can defeat
  keeper deadlines.
- At most 128 open-request metadata records are retained. Only request ID,
  method, and error-sent status are retained; command/question bodies are not.
  RPC remote error text/data is omitted from keeper errors. Caller identities
  and request IDs in state are still sensitive; do not publish raw state.
- This is single-threaded observation code, not a general concurrent JSON-RPC
  multiplexer. Unexpected response IDs and unknown notifications fail closed;
  unrelated session events are ignored. No arbitrary future-version compatibility
  is promised.

`state` reports status, reviewed identity, epoch, sequence watermark, request
metadata, reconnect count, truncation/epoch-change flags, and
`durable_admission: false`. It is not a durable store or server authority claim.

## Unsupported requests are not consent

The client advertises `client.capabilities({"server_requests": true})`. Each
valid server request, including activation/replay snapshots, receives JSON-RPC
`-32601` with the same string request ID. A mismatched supplied session identity
or malformed request blocks before a reply. Cancellation clears only the matching
ID for the reviewed session. Error-sent records are observations, not proof the
server resolved a request.

**This behavior can withdraw native approval/clarify requests.** It does not
implement human consent, mobile delivery, vault prompts, or cooperation with an
approval UI. Repeated snapshot replies also have lifecycle effects. Before any
live pilot, replace the negative-only handler with separately authorized and
native-tested human-request routing; do not merely disable negotiation and
assume that becomes harmless.

The authoritative programmatic integration guide was fetched for contract
review. Its server-to-client request section documents negotiation,
unsupported-method errors, cancellation, and request replay:

```text
https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration
```

This experimental implementation is checked against actual public wire shapes,
not dependent on importing native implementation symbols.

## Portable focused tests

From the repository root, with Python 3.11 or later:

```sh
PYTHONPATH=src PYTHONDONTWRITEBYTECODE=1 \
  python -S -m unittest discover -s tests -p test_keeper.py -v
```

The default suite requires only the standard library. `ScriptWire` is an
in-memory **public-wire fake**, not native/model proof. POSIX-only real pipe tests
check framing, receive timeout/EOF, and full-pipe send failure; they are skipped
on non-POSIX platforms. No native Hermes package is imported. The native process
test is skipped unless explicitly opted in.

Additional safety-review regressions exercise blocked-state pumping,
mid-observation epoch drift, ambiguous envelopes, malformed/cross-session frames, finite numeric
bounds, replay sequence/collection drift, and omission of remote error payloads.
The regressions were observed failing before their fixes.

### Optional isolated native research test

The optional process fixture currently requires macOS `sandbox-exec`. Other
platforms can run the default suite; opting into the native test without the
required sandbox fails rather than running without network denial. It is not
required for public CI and installs nothing.

Choose a reviewed stock checkout and an existing interpreter with that checkout's
normal dependencies. Supply both absolute paths explicitly; there is no machine,
source, interpreter, profile, or credential fallback:

```sh
# HERMES_SOURCE and HERMES_PYTHON must already be explicitly set.
RUN_HERMES_KEEPER_NATIVE=1 \
HERMES_SOURCE="$HERMES_SOURCE" HERMES_PYTHON="$HERMES_PYTHON" \
PYTHONPATH=src PYTHONDONTWRITEBYTECODE=1 \
  python -m unittest discover -s tests -p test_keeper.py -v
```

The fixture refuses source-tree dotenv files. It supplies an allowlisted child
environment with temporary `HOME`, `HERMES_HOME`, XDG directories, and `TMPDIR`;
no provider credentials are passed. A sandbox denies network and named live
credential/config/history/profile paths discovered from the caller's home.
A network-denial preflight must succeed before launching the native server.
This is not a general malicious-source or full-filesystem containment sandbox.

The fixture invokes the stock `python -m tui_gateway.entry` launcher over real
stdio. Fixture-only public create/title calls establish a zero-message synthetic
session; they are **not keeper operations**. Public cwd change produces a real
session event, replay inspects its epoch/sequence, and session close induces
runtime loss. The already-consumed ready event is handed back through the same
real pipe, not a second client or reconnect. No provider turn is requested.

Cleanup closes stdin, waits two seconds for EOF exit, and may need bounded
SIGTERM, then bounded SIGKILL fallback in the final cleanup. Natural EOF exit is
not guaranteed. The test reports actual `eof_exit` and `cleanup_exit` separately;
a green test after termination is **not proof of natural shutdown**. Synthetic
processes and temporary homes are cleaned up.

## Actual focused verification

The package-focused default run with site packages disabled returned:

```text
Ran 20 tests in 0.063s
OK (skipped=1)
```

The separately opted-in sandboxed native run returned:

```text
Ran 20 tests in 2.848s
OK
transport: stdio
per_session_exclusive_submit: true
last_seen: 1
replay_latest_seq: 1
runtime_loss: blocked
eof_exit: 0
cleanup_exit: 0
model_turns: 0
network: sandbox denied
multiple_clients: not tested
```

These are sanitized synthetic fixture observations, not user session evidence.
An additional guard check confirmed that missing either explicit native path
is refused before launching a process. A focused scan found no private path,
legacy machine fallback, or copied private runtime identifier in the three files;
the keeper's imports were checked to be standard-library-only.
The recorded native run exited naturally, but does not establish universal
clean-EOF behavior; the test keeps its bounded termination fallback. A subsequent
independent run observed the process still alive after two seconds of EOF and
used bounded SIGTERM cleanup (`cleanup_exit: -15`), while the 20-test harness
still passed. See [independent verification](verification.md). No private
source paths, real profiles, runtime IDs, epoch tokens, transcripts, or source
patch artifacts are included in this document.

Native proof is limited to one client: startup, negotiation, exact ID/key
activation, finite liveness probing, a real event watermark, same-process replay
shape, and failure after synthetic runtime closure. Reconnect/truncation,
nonempty request replay, negative-only approvals, and cancellation are fake-wire
tested. No live session, authenticated cloud attachment, Desktop disconnect
survival, native multi-client handoff, real model completion, mobile approval,
long-lived residency/reaper exemption, or crash/restart recovery was verified.

Promotion requires separately reviewed authentication to the same existing owner,
canonical identity binding, native multi-client/disconnect/replay tests,
authorized human-request routing, and idle/restart behavior tests on the target
release. Until then, this remains an importable research component, not a live
ingress or installation recommendation.

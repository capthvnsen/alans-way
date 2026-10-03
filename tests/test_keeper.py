"""Stdlib public-wire/pipe tests; optional isolated native research, not live proof."""
import importlib.util
import os
import unittest
from pathlib import Path



class ScriptWire:
    """In-memory scripted JSON-RPC peer; never a native Hermes server."""
    def __init__(self, replies=None, epoch="epoch-a"):
        self.incoming = [{"jsonrpc": "2.0", "method": "event", "params": {
            "type": "gateway.ready", "payload": {"replay_epoch": epoch}}}]
        self.sent = []
        self.replies = replies or {}

    def send(self, frame):
        self.sent.append(frame)
        if "method" in frame and "id" in frame:
            method = frame["method"]
            defaults = {
                "gateway.capabilities": {"per_session_exclusive_submit": True},
                "client.capabilities": {"server_requests": ["approval"]},
                "session.active_list": {"sessions": [{"id": "live-1", "session_key": "saved-1"}]},
                "session.activate": {"session_id": "live-1", "session_key": "saved-1", "open_requests": []},
                "session.events.since": {"events": [], "latest_seq": 0, "truncated": False,
                                         "epoch": "epoch-a", "open_requests": []},
                "ping": {"pong": True},
            }
            result = self.replies.get(method, defaults.get(method))
            self.incoming.append({"jsonrpc": "2.0", "id": frame["id"], "result": result})

    def receive(self, timeout):
        if not self.incoming:
            raise TimeoutError("scripted wire empty")
        return self.incoming.pop(0)


class KeeperWireTests(unittest.TestCase):
    def test_attaches_only_explicit_reviewed_live_identity(self):
        self.assertIsNotNone(importlib.util.find_spec("hermes_companion.experimental.keeper"), "keeper implementation missing")
        from hermes_companion.experimental.keeper import Keeper
        wire = ScriptWire()
        keeper = Keeper(profile="fixture-profile", session_key="saved-1", session_id="live-1", reviewed=True)
        keeper.attach(wire)
        self.assertEqual(keeper.state["status"], "attached")
        self.assertEqual(keeper.state["identity"], {"profile": "fixture-profile", "session_key": "saved-1", "session_id": "live-1"})
        self.assertEqual([f["method"] for f in wire.sent], ["gateway.capabilities", "client.capabilities", "session.active_list", "session.activate"])
        self.assertEqual(wire.sent[1]["params"], {"server_requests": True})
        self.assertEqual(wire.sent[3]["params"], {"session_id": "live-1", "omit_messages": True})

    def test_refuses_unreviewed_or_unavailable_identity_and_contract_drift(self):
        from hermes_companion.experimental.keeper import Keeper, KeeperError
        cases = [
            ({"reviewed": False}, {}),
            ({"profile": ""}, {}),
            ({"session_id": ""}, {}),
            ({}, {"gateway.capabilities": {"per_session_exclusive_submit": False}}),
            ({}, {"gateway.capabilities": {"per_session_exclusive_submit": 1}}),
            ({}, {"session.active_list": {"sessions": []}}),
            ({}, {"session.active_list": {"sessions": [{"id": "live-1", "session_key": "other"}]}}),
            ({}, {"session.activate": {"session_id": "other", "session_key": "saved-1"}}),
        ]
        for overrides, replies in cases:
            with self.subTest(overrides=overrides, replies=replies):
                args = dict(profile="fixture-profile", session_key="saved-1", session_id="live-1", reviewed=True)
                args.update(overrides)
                wire = ScriptWire(replies)
                keeper = None
                with self.assertRaises(KeeperError):
                    keeper = Keeper(**args)
                    keeper.attach(wire)
                if keeper is not None:
                    self.assertEqual(keeper.state["status"], "blocked")
                self.assertFalse(any(f.get("method") in {"session.create", "session.resume", "prompt.submit"} for f in wire.sent))

    def test_errors_every_server_request_and_tracks_only_matching_cancellation(self):
        from hermes_companion.experimental.keeper import Keeper
        request = lambda rid: {"jsonrpc": "2.0", "id": rid, "method": "approval", "params": {
            "session_id": "live-1", "command": "secret command not retained"}}
        wire = ScriptWire({"session.activate": {"session_id": "live-1", "session_key": "saved-1",
                                                "open_requests": [request("srq-1"), request("srq-2")]}})
        keeper = Keeper(profile="fixture-profile", session_key="saved-1", session_id="live-1", reviewed=True)
        keeper.attach(wire)
        replies = [f for f in wire.sent if "error" in f]
        self.assertEqual([f["id"] for f in replies], ["srq-1", "srq-2"])
        self.assertTrue(all(f["error"]["code"] == -32601 and "result" not in f for f in replies))
        self.assertNotIn("secret command", str(keeper.state))
        wire.incoming.append({"jsonrpc": "2.0", "method": "event", "params": {
            "type": "request.cancel", "session_id": "live-1", "seq": 7, "payload": {"id": "srq-1"}}})
        keeper.pump_once()
        self.assertEqual(set(keeper.state["open_requests"]), {"srq-2"})
        self.assertEqual(keeper.state["last_seen"], 7)
        wire.incoming.append(request("srq-3"))
        keeper.pump_once()
        self.assertEqual(wire.sent[-1]["error"]["code"], -32601)

    def test_same_epoch_reconnect_uses_watermark_and_blocks_truncated_or_changed_epoch(self):
        from hermes_companion.experimental.keeper import Keeper, KeeperError
        keeper = Keeper(profile="fixture-profile", session_key="saved-1", session_id="live-1", reviewed=True)
        keeper.attach(ScriptWire())
        self.assertEqual(keeper.state.get("epoch"), "epoch-a")
        keeper.state["last_seen"] = 8
        request = {"jsonrpc": "2.0", "id": "srq-replay", "method": "clarify", "params": {"session_id": "live-1"}}
        wire = ScriptWire({"session.events.since": {
            "events": [{"type": "message.complete", "session_id": "live-1", "seq": 9, "payload": {}}],
            "latest_seq": 9, "truncated": False, "epoch": "epoch-a", "open_requests": [request]}})
        keeper.attach(wire)
        replay = next(f for f in wire.sent if f.get("method") == "session.events.since")
        self.assertEqual(replay["params"], {"session_id": "live-1", "last_seen": 8})
        self.assertEqual(keeper.state["last_seen"], 9)
        self.assertEqual(keeper.state["reconnects"], 1)
        self.assertFalse(keeper.state["durable_admission"])
        self.assertEqual(wire.sent[-1]["error"]["code"], -32601)
        with self.assertRaises(KeeperError):
            keeper.attach(ScriptWire({"session.events.since": {
                "events": [], "latest_seq": 30, "truncated": True, "epoch": "epoch-a", "open_requests": []}}))
        self.assertTrue(keeper.state["truncated"])
        self.assertEqual(keeper.state["status"], "blocked")
        drift = ScriptWire(epoch="new-process")
        with self.assertRaises(KeeperError):
            keeper.attach(drift)
        self.assertTrue(keeper.state["epoch_changed"])
        self.assertEqual(drift.sent, [])

    def test_bounded_keep_probes_and_marks_transport_loss_or_runtime_loss(self):
        from hermes_companion.experimental.keeper import Keeper, KeeperError
        wire = ScriptWire()
        keeper = Keeper(profile="fixture-profile", session_key="saved-1", session_id="live-1", reviewed=True)
        keeper.attach(wire)
        self.assertTrue(callable(getattr(keeper, "keep", None)), "bounded keep loop missing")
        keeper.keep(seconds=0.025, interval=0.01)
        self.assertEqual(keeper.state["status"], "attached")
        self.assertTrue(any(f.get("method") == "ping" for f in wire.sent))
        wire.replies["session.active_list"] = {"sessions": []}
        with self.assertRaises(KeeperError):
            keeper.keep(seconds=0.025, interval=0.01)
        self.assertEqual(keeper.state["status"], "blocked")
        wire = ScriptWire()
        keeper.attach(wire)
        wire.receive = lambda timeout: (_ for _ in ()).throw(EOFError("peer closed"))
        with self.assertRaises(KeeperError):
            keeper.pump_once()
        self.assertEqual(keeper.state["status"], "disconnected")

    def test_malformed_wire_and_negotiation_fail_closed(self):
        from hermes_companion.experimental.keeper import Keeper, KeeperError
        for replies in [
            {"client.capabilities": {}},
            {"client.capabilities": {"server_requests": "approval"}},
        ]:
            with self.subTest(replies=replies):
                keeper = Keeper(profile="fixture-profile", session_key="saved-1", session_id="live-1", reviewed=True)
                with self.assertRaises(KeeperError):
                    keeper.attach(ScriptWire(replies))
                self.assertEqual(keeper.state["status"], "blocked")
        keeper = Keeper(profile="fixture-profile", session_key="saved-1", session_id="live-1", reviewed=True)
        wire = ScriptWire()
        keeper.attach(wire)
        wire.incoming.append({"jsonrpc": "1.0", "method": "event", "params": {}})
        with self.assertRaises(KeeperError):
            keeper.pump_once()
        self.assertEqual(keeper.state["status"], "blocked")
        wire = ScriptWire()
        keeper.attach(wire)
        for i in range(129):
            wire.incoming.append({"jsonrpc": "2.0", "id": f"srq-{i}", "method": "approval", "params": {}})
        with self.assertRaises(KeeperError):
            for _ in range(129):
                keeper.pump_once()
        self.assertLessEqual(len(keeper.state["open_requests"]), 128)
        self.assertEqual(keeper.state["status"], "blocked")

    def test_keeper_cannot_submit_and_rpc_noise_cannot_extend_deadline(self):
        import time
        from hermes_companion.experimental.keeper import Keeper, KeeperError
        wire = ScriptWire()
        keeper = Keeper(profile="fixture-profile", session_key="saved-1", session_id="live-1", reviewed=True, timeout=0.01)
        keeper.attach(wire)
        before = len(wire.sent)
        with self.assertRaises(KeeperError):
            keeper._call("prompt.submit", {"text": "never admitted"})
        self.assertEqual(len(wire.sent), before)
        wire.receive = lambda timeout: {"jsonrpc": "2.0", "method": "event", "params": {"type": "noise"}}
        started = time.monotonic()
        with self.assertRaises(KeeperError):
            keeper.keep(seconds=0.02, interval=0.01)
        self.assertLess(time.monotonic() - started, 0.2)
        self.assertEqual(keeper.state["status"], "blocked")

    def test_ready_noise_is_bounded_and_timeout_values_are_finite(self):
        import time
        from hermes_companion.experimental.keeper import Keeper, KeeperError
        for timeout in [float("inf"), float("nan"), 0, 61]:
            with self.subTest(timeout=timeout), self.assertRaises(KeeperError):
                Keeper(profile="fixture-profile", session_key="saved-1", session_id="live-1", reviewed=True, timeout=timeout)
        keeper = Keeper(profile="fixture-profile", session_key="saved-1", session_id="live-1", reviewed=True, timeout=0.01)
        wire = ScriptWire()
        wire.receive = lambda timeout: {"jsonrpc": "2.0", "method": "event", "params": {"type": "noise"}}
        started = time.monotonic()
        with self.assertRaises(KeeperError):
            keeper.attach(wire)
        self.assertLess(time.monotonic() - started, 0.2)
        self.assertEqual(keeper.state["status"], "blocked")

    def test_server_request_send_timeout_blocks_instead_of_becoming_idle_timeout(self):
        from hermes_companion.experimental.keeper import Keeper, KeeperError
        keeper = Keeper(profile="fixture-profile", session_key="saved-1", session_id="live-1", reviewed=True)
        wire = ScriptWire()
        keeper.attach(wire)
        wire.incoming.append({"jsonrpc": "2.0", "id": "srq-1", "method": "approval", "params": {}})
        wire.send = lambda frame: (_ for _ in ()).throw(TimeoutError("send failed"))
        with self.assertRaises(Exception) as raised:
            keeper.pump_once()
        self.assertIsInstance(raised.exception, KeeperError)
        self.assertEqual(keeper.state["status"], "blocked")


class SafetyReviewTests(unittest.TestCase):
    def test_ambiguous_ready_and_rpc_response_envelopes_block(self):
        from hermes_companion.experimental.keeper import Keeper, KeeperError
        identity = dict(profile="fixture-profile", session_key="saved-1", session_id="live-1", reviewed=True)
        for field, value in (("id", "synthetic-request"), ("result", {}), ("error", {})):
            with self.subTest(ready_field=field):
                wire = ScriptWire()
                wire.incoming[0][field] = value
                keeper = Keeper(**identity)
                with self.assertRaises(KeeperError):
                    keeper.attach(wire)
                self.assertEqual(wire.sent, [])
                self.assertEqual(keeper.state["status"], "blocked")
        class AmbiguousResponseWire(ScriptWire):
            def send(self, frame):
                super().send(frame)
                if frame.get("method") == "gateway.capabilities":
                    self.incoming[-1]["method"] = "ambiguous-request"
        keeper = Keeper(**identity)
        with self.assertRaises(KeeperError):
            keeper.attach(AmbiguousResponseWire())
        self.assertEqual(keeper.state["status"], "blocked")

    def test_snapshot_collections_require_lists(self):
        from hermes_companion.experimental.keeper import Keeper, KeeperError
        identity = dict(profile="fixture-profile", session_key="saved-1", session_id="live-1", reviewed=True)
        keeper = Keeper(**identity)
        with self.assertRaises(KeeperError):
            keeper.attach(ScriptWire({"session.activate": {
                "session_id": "live-1", "session_key": "saved-1", "open_requests": {}}}))
        for field in ("events", "open_requests"):
            with self.subTest(field=field):
                keeper = Keeper(**identity)
                keeper.attach(ScriptWire())
                replay = {"events": [], "latest_seq": 0, "truncated": False,
                          "epoch": "epoch-a", "open_requests": []}
                replay[field] = {}
                with self.assertRaises(KeeperError):
                    keeper.attach(ScriptWire({"session.events.since": replay}))
                self.assertEqual(keeper.state["status"], "blocked")

    def test_remote_error_payload_is_not_retained(self):
        from hermes_companion.experimental.keeper import Keeper, KeeperError
        keeper = Keeper(profile="fixture-profile", session_key="saved-1", session_id="live-1", reviewed=True)
        wire = ScriptWire()
        keeper.attach(wire)
        response_id = "keeper-" + str(keeper.counter + 1)
        wire.receive = lambda timeout: {"jsonrpc": "2.0", "id": response_id, "error": {
            "code": -1, "message": "synthetic-sensitive-detail", "data": "synthetic-detail"}}
        with self.assertRaises(KeeperError) as raised:
            keeper.keep(seconds=0.01, interval=0.005)
        self.assertNotIn("synthetic-sensitive-detail", str(raised.exception))
        self.assertNotIn("synthetic-detail", str(keeper.state))
        self.assertEqual(keeper.state["status"], "blocked")

    def test_malformed_or_cross_session_frames_block_before_reply(self):
        from hermes_companion.experimental.keeper import Keeper, KeeperError
        frames = [
            {"jsonrpc": "2.0", "id": None, "method": "approval", "params": {}},
            {"jsonrpc": "2.0", "id": True, "method": "approval", "params": {}},
            {"jsonrpc": "2.0", "id": "srq-1", "method": 7, "params": {}},
            {"jsonrpc": "2.0", "id": "srq-1", "method": "approval", "params": {
                "session_id": "foreign-fixture"}},
            {"jsonrpc": "2.0", "method": "unexpected.notification", "params": {}},
            {"jsonrpc": "2.0", "id": "unexpected-response", "result": {}},
            {"jsonrpc": "2.0", "method": "event", "params": {
                "type": "message.complete", "session_id": "live-1", "seq": True}},
        ]
        for frame in frames:
            with self.subTest(frame=frame):
                keeper = Keeper(profile="fixture-profile", session_key="saved-1", session_id="live-1", reviewed=True)
                wire = ScriptWire()
                keeper.attach(wire)
                before = len(wire.sent)
                wire.incoming.append(frame)
                with self.assertRaises(KeeperError):
                    keeper.pump_once()
                self.assertEqual(keeper.state["status"], "blocked")
                self.assertEqual(len(wire.sent), before)

    def test_duration_inputs_are_finite_numbers_not_booleans(self):
        from hermes_companion.experimental.keeper import Keeper, KeeperError, StdioWire
        identity = dict(profile="fixture-profile", session_key="saved-1", session_id="live-1", reviewed=True)
        for value in (True, False, None, "10", float("inf"), float("nan")):
            with self.subTest(value=value), self.assertRaises(KeeperError):
                Keeper(**identity, timeout=value)
            with self.subTest(send_timeout=value), self.assertRaises(KeeperError):
                StdioWire(None, None, send_timeout=value)
        keeper = Keeper(**identity)
        wire = ScriptWire()
        keeper.attach(wire)
        for value in (True, None, "10", float("inf"), float("nan")):
            if value is not None:  # None explicitly means the configured default.
                with self.subTest(pump_timeout=value), self.assertRaises(KeeperError):
                    keeper.pump_once(timeout=value)
            with self.subTest(seconds=value), self.assertRaises(KeeperError):
                keeper.keep(seconds=value, interval=0.001)
            with self.subTest(interval=value), self.assertRaises(KeeperError):
                keeper.keep(seconds=1, interval=value)
        self.assertEqual(keeper.state["status"], "attached")
        with self.assertRaises(TimeoutError):
            keeper.pump_once(timeout=None)

    def test_replay_sequence_contract_drift_blocks(self):
        from hermes_companion.experimental.keeper import Keeper, KeeperError
        for sequence in (True, -1, "9"):
            with self.subTest(sequence=sequence):
                keeper = Keeper(profile="fixture-profile", session_key="saved-1", session_id="live-1", reviewed=True)
                keeper.attach(ScriptWire())
                keeper.state["last_seen"] = 8
                replay = {"events": [], "latest_seq": sequence, "truncated": False,
                          "epoch": "epoch-a", "open_requests": []}
                with self.assertRaises(KeeperError):
                    keeper.attach(ScriptWire({"session.events.since": replay}))
                self.assertEqual(keeper.state["status"], "blocked")
                self.assertEqual(keeper.state["last_seen"], 8)

    def test_new_ready_epoch_on_attached_wire_blocks(self):
        from hermes_companion.experimental.keeper import Keeper, KeeperError
        keeper = Keeper(profile="fixture-profile", session_key="saved-1", session_id="live-1", reviewed=True)
        wire = ScriptWire()
        keeper.attach(wire)
        wire.incoming.append({"jsonrpc": "2.0", "method": "event", "params": {
            "type": "gateway.ready", "payload": {"replay_epoch": "changed"}}})
        with self.assertRaises(KeeperError):
            keeper.pump_once()
        self.assertTrue(keeper.state["epoch_changed"])
        self.assertEqual(keeper.state["status"], "blocked")

    def test_blocked_keeper_cannot_pump_more_frames(self):
        from hermes_companion.experimental.keeper import Keeper, KeeperError
        keeper = Keeper(profile="fixture-profile", session_key="saved-1", session_id="live-1", reviewed=True)
        wire = ScriptWire()
        keeper.attach(wire)
        wire.incoming.append({"jsonrpc": "1.0", "method": "event", "params": {}})
        with self.assertRaises(KeeperError):
            keeper.pump_once()
        wire.incoming.append({"jsonrpc": "2.0", "id": "srq-blocked", "method": "approval", "params": {}})
        sent = len(wire.sent)
        with self.assertRaises(KeeperError):
            keeper.pump_once()
        self.assertEqual(len(wire.sent), sent)
        self.assertEqual(len(wire.incoming), 1)


@unittest.skipUnless(os.name == "posix", "StdioWire requires POSIX pipes")
class StdioWireTests(unittest.TestCase):
    def test_real_pipe_transport_handles_framing_timeout_and_eof(self):
        import json
        import os
        from hermes_companion.experimental import keeper as keeper_module
        self.assertTrue(hasattr(keeper_module, "StdioWire"), "real stdio wire missing")
        read_fd, peer_write_fd = os.pipe()
        peer_read_fd, write_fd = os.pipe()
        with os.fdopen(read_fd, "rb", buffering=0) as reader, os.fdopen(write_fd, "wb", buffering=0) as writer:
            wire = keeper_module.StdioWire(reader, writer)
            try:
                frame = {"jsonrpc": "2.0", "method": "ping", "id": "test", "params": {}}
                wire.send(frame)
                self.assertEqual(json.loads(os.read(peer_read_fd, 4096)), frame)
                os.write(peer_write_fd, b'{"jsonrpc":"2.0","id":1,"result":{}}\n{"jsonrpc":"2.0","id":2,"result":{}}\n')
                self.assertEqual(wire.receive(0.1)["id"], 1)
                self.assertEqual(wire.receive(0.1)["id"], 2)
                with self.assertRaises(TimeoutError):
                    wire.receive(0.001)
                os.close(peer_write_fd)
                peer_write_fd = None
                with self.assertRaises(EOFError):
                    wire.receive(0.1)
            finally:
                if peer_write_fd is not None:
                    os.close(peer_write_fd)
                os.close(peer_read_fd)
    def test_full_pipe_send_fails_within_deadline_instead_of_dropping_frame(self):
        import os
        import time
        from hermes_companion.experimental.keeper import StdioWire
        read_fd, write_fd = os.pipe()
        with os.fdopen(read_fd, "rb", buffering=0) as reader, os.fdopen(write_fd, "wb", buffering=0) as writer:
            os.set_blocking(write_fd, False)
            while True:
                try:
                    os.write(write_fd, b"x" * 4096)
                except BlockingIOError:
                    break
            self.assertIn("send_timeout", __import__("inspect").signature(StdioWire).parameters,
                          "bounded send deadline missing")
            wire = StdioWire(reader, writer, send_timeout=0.01)
            started = time.monotonic()
            with self.assertRaises(TimeoutError):
                wire.send({"jsonrpc": "2.0", "id": "srq-1", "error": {"code": -32601, "message": "unsupported"}})
            self.assertLess(time.monotonic() - started, 0.2)



@unittest.skipUnless(os.environ.get("RUN_HERMES_KEEPER_NATIVE") == "1", "opt-in isolated native test")
class StockNativeTests(unittest.TestCase):
    """Real native launcher in an empty home; NOT existing cloud-owner attachment."""

    def test_stock_stdio_attach_keep_runtime_loss_and_bounded_cleanup(self):
        import json
        import shutil
        import subprocess
        import sys
        import tempfile
        import time
        from hermes_companion.experimental.keeper import Keeper, KeeperError, StdioWire

        # No source, interpreter, real profile or credential fallback.
        for name in ("HERMES_SOURCE", "HERMES_PYTHON"):
            self.assertTrue(os.environ.get(name), f"explicit {name} required for native opt-in")
            self.assertTrue(Path(os.environ[name]).is_absolute(), f"{name} must be absolute")
        source = Path(os.environ["HERMES_SOURCE"]).resolve(strict=True)
        # Preserve the venv executable path: resolving its symlink can discard
        # the environment whose installed dependencies the caller reviewed.
        python = os.environ["HERMES_PYTHON"]
        self.assertTrue(Path(python).is_file() and os.access(python, os.X_OK), "explicit interpreter unavailable")
        self.assertTrue((source / "tui_gateway" / "entry.py").is_file(), "stock launcher missing")
        for name in (".env", ".op.env"):
            self.assertFalse((source / name).exists(), "refuse source dotenv credential fallback")
        # Native optional proof needs OS network denial; public CI does not need it.
        self.assertEqual(sys.platform, "darwin", "native opt-in currently requires macOS sandbox-exec")
        sandbox_exec = shutil.which("sandbox-exec")
        self.assertIsNotNone(sandbox_exec, "network-denying sandbox-exec required")
        with tempfile.TemporaryDirectory(prefix="hermes-keeper-") as tmp:
            home = Path(tmp)
            denied_names = (".env", ".op.env", "auth.json", "config.yaml", "state.db", "sessions",
                            "profiles", "memories", "skills", "plugins", "logs")
            roots = {Path.home() / ".hermes"}
            if os.environ.get("HERMES_HOME"):
                roots.add(Path(os.environ["HERMES_HOME"]).resolve())
            sandbox = "(version 1)(allow default)(deny network*)" + "".join(
                "(deny file-read* file-write* (subpath " + json.dumps(str(root / name)) + "))"
                for root in sorted(roots) for name in denied_names)
            env = {"PATH": os.defpath, "HOME": str(home), "HERMES_HOME": str(home / "hermes"),
                   "XDG_CONFIG_HOME": str(home / "config"), "XDG_CACHE_HOME": str(home / "cache"),
                   "PYTHONPATH": str(source), "PYTHONDONTWRITEBYTECODE": "1", "PYTHONUNBUFFERED": "1",
                   "TMPDIR": str(home)}
            # Verify network denial before launching the real server. No remote target.
            probe = subprocess.run([sandbox_exec, "-p", sandbox, python, "-c",
                "import socket\ntry:\n s=socket.socket(); s.bind(('',0))\nexcept PermissionError:\n raise SystemExit(0)\nraise SystemExit(1)"],
                cwd=home, env=env, capture_output=True, timeout=10)
            self.assertEqual(probe.returncode, 0, "sandbox network-denial preflight failed")
            with (home / "stderr.log").open("wb") as stderr:
                proc = subprocess.Popen([sandbox_exec, "-p", sandbox, python, "-m", "tui_gateway.entry"],
                                        cwd=home, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr)
                try:
                    wire = StdioWire(proc.stdout, proc.stdin)
                    deadline = time.monotonic() + 20
                    while True:
                        ready = wire.receive(max(0, deadline - time.monotonic()))
                        if ready.get("params", {}).get("type") == "gateway.ready":
                            break
                    event_handler = None

                    def fixture_call(method, params=None):
                        # Fixture lifecycle only, not a keeper creation/submission lane.
                        rid = "fixture-" + method
                        wire.send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}})
                        deadline = time.monotonic() + 10
                        while True:
                            frame = wire.receive(max(0, deadline - time.monotonic()))
                            if frame.get("id") == rid:
                                self.assertNotIn("error", frame, "native fixture RPC failed")
                                return frame["result"]
                            if event_handler is not None:
                                event_handler(frame)
                            elif "method" in frame and "id" in frame:
                                wire.send({"jsonrpc": "2.0", "id": frame["id"], "error": {
                                    "code": -32601, "message": "test fixture unsupported"}})

                    capabilities = fixture_call("gateway.capabilities")
                    created = fixture_call("session.create", {"title": "synthetic transport draft", "cwd": str(home)})
                    sid, key = created["session_id"], created["stored_session_id"]
                    fixture_call("session.title", {"session_id": sid, "title": "synthetic saved fixture"})

                    class PrefetchedReady:
                        # Same real pipe, not reconnect or another subscriber.
                        def __init__(self):
                            self.ready = ready

                        def send(self, frame):
                            wire.send(frame)

                        def receive(self, timeout):
                            if self.ready is not None:
                                value, self.ready = self.ready, None
                                return value
                            return wire.receive(timeout)

                    keeper = Keeper(profile="synthetic-fixture", session_key=key, session_id=sid, reviewed=True)
                    keeper.attach(PrefetchedReady())
                    event_handler = keeper._handle
                    fixture_call("session.cwd.set", {"session_id": sid, "cwd": str(home)})
                    keeper.keep(seconds=0.15, interval=0.05)
                    self.assertGreater(keeper.state["last_seen"], 0)
                    self.assertIsNone(proc.poll())
                    self.assertEqual(keeper.state["status"], "attached")
                    replay = fixture_call("session.events.since", {"session_id": sid, "last_seen": 0})
                    self.assertEqual(replay["epoch"], keeper.state["epoch"])
                    self.assertFalse(replay["truncated"])
                    self.assertIsInstance(replay["open_requests"], list)
                    fixture_call("session.close", {"session_id": sid})
                    with self.assertRaises(KeeperError):
                        keeper.keep(seconds=0.1, interval=0.05)
                    self.assertEqual(keeper.state["status"], "blocked")
                    proc.stdin.close()
                    try:
                        eof_rc = proc.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        eof_rc = "still running after 2s"
                        proc.terminate()
                        proc.wait(timeout=5)
                    self.assertIsNotNone(proc.poll(), "isolated process cleanup failed")
                    # No IDs, epoch tokens, paths, transcripts or full native capability dump.
                    print("KEEPER_NATIVE_RESULT", json.dumps({"transport": "stdio",
                        "per_session_exclusive_submit": capabilities.get("per_session_exclusive_submit"),
                        "last_seen": keeper.state["last_seen"], "replay_latest_seq": replay["latest_seq"],
                        "runtime_loss": keeper.state["status"], "eof_exit": eof_rc, "cleanup_exit": proc.returncode,
                        "model_turns": 0, "network": "sandbox denied", "multiple_clients": "not tested"}))
                finally:
                    if proc.poll() is None:
                        proc.terminate()
                        try:
                            proc.wait(timeout=5)
                        except subprocess.TimeoutExpired:
                            proc.kill()
                            proc.wait(timeout=5)
                    if not proc.stdin.closed:
                        proc.stdin.close()
                    proc.stdout.close()


if __name__ == "__main__":
    unittest.main()

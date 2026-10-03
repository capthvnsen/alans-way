"""Connection policy tests; SDK boundary doubles never contact private hosts."""
import asyncio
from contextlib import asynccontextmanager, contextmanager, redirect_stderr, redirect_stdout
import importlib.metadata
import io
import json
import os
from pathlib import Path
import platform
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from hermes_companion.config import MAC_TOOLS, build_mcp_config


class VerifyTests(unittest.TestCase):
    def sdk(self, *, tools=None, status=None, read=None, fail=None, pause=False):
        calls, transport = [], {}
        default_tools = [SimpleNamespace(name=name, annotations=SimpleNamespace(read_only_hint=True))
                         for name in MAC_TOOLS]
        listing = SimpleNamespace(tools=tools if tools is not None else default_tools, next_cursor=None)
        status = status if status is not None else {"execution_host": "mac", "system": "Darwin"}

        class Session:
            def __init__(self, *streams, **kwargs):
                transport["session_options"] = kwargs

            async def __aenter__(self):
                return self

            async def __aexit__(self, *exc):
                transport["closed"] = True

            async def initialize(self):
                calls.append("initialize")
                if fail:
                    raise RuntimeError(fail)
                if pause:
                    await asyncio.sleep(60)

            async def list_tools(self):
                calls.append("list_tools")
                return listing

            async def call_tool(self, name, arguments=None):
                calls.append((name, arguments))
                data = status if name == "mac_device_status" else read
                return SimpleNamespace(is_error=False, structured_content=data, content=[])

        @asynccontextmanager
        async def stdio(params, errlog):
            transport["params"] = params
            transport["errlog"] = errlog
            errlog.write("private stderr /home/operator token=never_echo_this\n")
            yield (object(), object())

        @contextmanager
        def deadline(seconds):
            # Standard-library test boundary, so base tests need no MCP/AnyIO.
            task = asyncio.current_task()
            timer = asyncio.get_running_loop().call_later(seconds, task.cancel)
            try:
                yield
            except asyncio.CancelledError:
                raise TimeoutError("synthetic timeout") from None
            finally:
                timer.cancel()

        return (Session, SimpleNamespace, stdio,
                lambda: {"PATH": "/safe/bin", "HOME": "/safe/home"}, deadline), calls, transport

    def run_verification(self, sdk, **kwargs):
        from hermes_companion.cli import verify_mac
        with patch("hermes_companion.cli._load_sdk", return_value=sdk):
            return verify_mac("operator@private-mac", "/opt/python", "/srv/approved", **kwargs)

    def test_validates_tools_and_mac_status_without_reading_any_file(self):
        sdk, calls, transport = self.sdk()
        with patch.dict(os.environ, {"SSH_AUTH_SOCK": "/safe/agent.sock", "API_TOKEN": "never_echo_this"}):
            report = self.run_verification(sdk)
        self.assertTrue(report["connection_verified"])
        self.assertFalse(report["full_integration_ready"])
        self.assertEqual(report["execution_host"], "mac")
        self.assertEqual(report["system"], "Darwin")
        self.assertEqual(report["tools"], list(MAC_TOOLS))
        self.assertFalse(report["read_performed"])
        self.assertEqual(calls, ["initialize", "list_tools", ("mac_device_status", {})])
        params = transport["params"]
        expected = build_mcp_config("operator@private-mac", "/opt/python", "/srv/approved")["mcp_servers"]["mac_companion"]
        self.assertEqual((params.command, params.args), (expected["command"], expected["args"]))
        self.assertEqual(params.env["SSH_AUTH_SOCK"], "/safe/agent.sock")
        self.assertNotIn("API_TOKEN", params.env)
        self.assertEqual(transport["session_options"]["read_timeout_seconds"], 10.0)
        self.assertTrue(transport["closed"])
        self.assertTrue(transport["errlog"].closed)
        self.assertNotIn("private", json.dumps(report))

    def test_opt_in_read_returns_byte_count_never_content(self):
        content = "synthetic fixture π\n"
        sdk, calls, _ = self.sdk(read={"execution_host": "mac", "path": "fixture.txt", "content": content})
        report = self.run_verification(sdk, read_path="fixture.txt")
        self.assertTrue(report["read_performed"])
        self.assertEqual(report["read"], {"bytes_read": len(content.encode("utf-8")), "encoding": "utf-8"})
        self.assertEqual(calls[-1], ("mac_workspace_read_file", {"path": "fixture.txt"}))
        self.assertNotIn(content, json.dumps(report))
        self.assertNotIn("fixture.txt", json.dumps(report))

    def test_invalid_read_paths_fail_before_loading_sdk(self):
        from hermes_companion.cli import verify_mac
        for path in ["/etc/file", "../fixture.txt", "a/../fixture.txt", "a//file",
                     "a\\file", "a/./file", "", ".", "a\x00file"]:
            with self.subTest(path=path), patch("hermes_companion.cli._load_sdk") as loader:
                with self.assertRaises(ValueError):
                    verify_mac("operator@private-mac", "/opt/python", "/srv/approved", read_path=path)
                loader.assert_not_called()

    def test_invalid_timeouts_fail_before_loading_sdk(self):
        from hermes_companion.cli import verify_mac
        for key in ["request_timeout", "overall_timeout"]:
            for value in [0, -1, float("inf"), float("nan"), 100000, True]:
                with self.subTest(key=key, value=value), patch("hermes_companion.cli._load_sdk") as loader:
                    with self.assertRaises(ValueError):
                        verify_mac("operator@private-mac", "/opt/python", "/srv/approved", **{key: value})
                    loader.assert_not_called()

    def test_unknown_identity_stops_before_requested_read(self):
        from hermes_companion.cli import VerificationError
        for status in [{"execution_host": "cloud", "system": "Linux"},
                       {"execution_host": "mac"}, {"system": "Darwin"}]:
            with self.subTest(status=status):
                sdk, calls, _ = self.sdk(status=status)
                with self.assertRaises(VerificationError):
                    self.run_verification(sdk, read_path="fixture.txt")
                self.assertEqual(calls[-1], ("mac_device_status", {}))

    def test_unexpected_or_duplicate_tools_stop_before_status(self):
        from hermes_companion.cli import VerificationError
        default = [SimpleNamespace(name=name, annotations=SimpleNamespace(read_only_hint=True))
                   for name in MAC_TOOLS]
        for tools in [default[:-1], default + [default[0]], default[:-1] + [default[0]],
                      default + [SimpleNamespace(name="mac_write_file")]]:
            with self.subTest(count=len(tools)):
                sdk, calls, _ = self.sdk(tools=tools)
                with self.assertRaises(VerificationError):
                    self.run_verification(sdk)
                self.assertEqual(calls, ["initialize", "list_tools"])

    def test_read_only_annotation_is_mandatory(self):
        from hermes_companion.cli import VerificationError
        for hint in [None, False, "true"]:
            tools = [SimpleNamespace(name=name, annotations=SimpleNamespace(read_only_hint=hint))
                     for name in MAC_TOOLS]
            sdk, calls, _ = self.sdk(tools=tools)
            with self.subTest(hint=hint), self.assertRaises(VerificationError):
                self.run_verification(sdk)
            self.assertEqual(calls, ["initialize", "list_tools"])

    def test_connection_failure_is_sanitized_and_not_retried(self):
        from hermes_companion.cli import VerificationError
        sdk, calls, _ = self.sdk(fail="SECRET /home/operator user@private-host token=SECRET")
        with self.assertRaises(VerificationError) as caught:
            self.run_verification(sdk)
        self.assertNotIn("SECRET", str(caught.exception))
        self.assertNotIn("/home", str(caught.exception))
        self.assertEqual(calls, ["initialize"])

    def test_missing_sdk_is_a_clean_failure(self):
        from hermes_companion.cli import verify_mac, VerificationError
        with patch("hermes_companion.cli._load_sdk", side_effect=ImportError("SECRET")):
            with self.assertRaises(VerificationError) as caught:
                verify_mac("operator@private-mac", "/opt/python", "/srv/approved")
        self.assertNotIn("SECRET", str(caught.exception))
        self.assertIn("[mcp]", str(caught.exception))

    def test_overall_deadline_cancels_initialization(self):
        from hermes_companion.cli import VerificationError
        import time
        sdk, calls, transport = self.sdk(pause=True)
        start = time.monotonic()
        with self.assertRaises(VerificationError):
            self.run_verification(sdk, overall_timeout=0.05)
        self.assertLess(time.monotonic() - start, 1.0)
        self.assertEqual(calls, ["initialize"])
        self.assertTrue(transport["closed"])


try:
    SDK_INSTALLED = importlib.metadata.version("mcp") == "2.0.0"
except importlib.metadata.PackageNotFoundError:
    SDK_INSTALLED = False


@unittest.skipUnless(SDK_INSTALLED and os.name == "posix", "requires optional mcp==2.0.0 and POSIX subprocess transport")
class RealVerifierProtocolTests(unittest.TestCase):
    """Real SDK transport over local test-only SSH shims, never a network call."""
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR"))
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.workspace = self.root / "workspace"
        self.workspace.mkdir()
        self.bin = self.root / "bin"
        self.bin.mkdir()

    def install_shim(self, body):
        shim = self.bin / "ssh"
        shim.write_text(f"#!{sys.executable}\n" + body, encoding="utf-8")
        shim.chmod(0o700)

    def invoke(self, **kwargs):
        from hermes_companion.cli import verify_mac
        with patch.dict(os.environ, {"PATH": str(self.bin) + os.pathsep + os.environ.get("PATH", "")}):
            return verify_mac("operator@private-mac", sys.executable, str(self.workspace), **kwargs)

    @unittest.skipUnless(platform.system() == "Darwin", "real successful Mac verification requires Darwin")
    def test_real_sdk_verifies_actual_server_and_opt_in_fixture(self):
        from hermes_companion.config import SSH_OPTIONS
        source = str(Path(__file__).resolve().parents[1] / "src")
        self.install_shim(
            "import os, shlex, sys\n"
            f"assert sys.argv[1:-2] == {list(SSH_OPTIONS)!r}\n"
            "assert sys.argv[-2] == 'operator@private-mac'\n"
            f"os.environ['PYTHONPATH'] = {source!r}\n"
            "tokens = shlex.split(sys.argv[-1])\n"
            "os.execv(tokens[0], tokens)\n"
        )
        content = "Synthetic verifier fixture café π\n"
        (self.workspace / "fixture.txt").write_text(content, encoding="utf-8")
        report = self.invoke()
        self.assertTrue(report["connection_verified"])
        self.assertFalse(report["read_performed"])
        report = self.invoke(read_path="fixture.txt")
        self.assertEqual(report["read"]["bytes_read"], len(content.encode("utf-8")))
        self.assertNotIn(content, json.dumps(report))
        self.assertNotIn(str(self.workspace), json.dumps(report))

    def test_real_offline_transport_failure_does_not_echo_stderr(self):
        from hermes_companion.cli import VerificationError
        self.install_shim("import sys\nsys.stderr.write('SECRET user@host /home/user token=SECRET\\n')\nsys.exit(255)\n")
        out, err = io.StringIO(), io.StringIO()
        start = time.monotonic()
        with redirect_stdout(out), redirect_stderr(err), self.assertRaises(VerificationError) as caught:
            self.invoke(request_timeout=0.5, overall_timeout=1.0)
        self.assertLess(time.monotonic() - start, 5.0)
        self.assertEqual(out.getvalue() + err.getvalue(), "")
        self.assertNotIn("SECRET", str(caught.exception))

    def test_real_malformed_protocol_logs_are_not_echoed(self):
        from hermes_companion.cli import VerificationError
        self.install_shim("import sys\nprint('SECRET malformed protocol')\nsys.stderr.write('SECRET diagnostics\\n')\n")
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err), self.assertRaises(VerificationError) as caught:
            self.invoke(request_timeout=0.5, overall_timeout=1.0)
        self.assertEqual(out.getvalue() + err.getvalue(), "")
        self.assertNotIn("SECRET", str(caught.exception))

    def test_real_request_timeout_reaps_transport_process(self):
        from hermes_companion.cli import VerificationError
        pid_file = self.root / "transport.pid"
        self.install_shim("import os, time\n" + f"open({str(pid_file)!r}, 'w').write(str(os.getpid()))\n" + "time.sleep(60)\n")
        start = time.monotonic()
        with self.assertRaises(VerificationError):
            self.invoke(request_timeout=0.15, overall_timeout=2.0)
        self.assertLess(time.monotonic() - start, 6.0)
        pid = int(pid_file.read_text())
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)

    def test_real_overall_timeout_reaps_transport_process(self):
        from hermes_companion.cli import VerificationError
        pid_file = self.root / "transport.pid"
        self.install_shim("import os, time\n" + f"open({str(pid_file)!r}, 'w').write(str(os.getpid()))\n" + "time.sleep(60)\n")
        start = time.monotonic()
        with self.assertRaises(VerificationError):
            self.invoke(request_timeout=10.0, overall_timeout=0.15)
        self.assertLess(time.monotonic() - start, 6.0)
        pid = int(pid_file.read_text())
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)


if __name__ == "__main__":
    unittest.main()

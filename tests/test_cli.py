"""Public CLI is inert by default and exposes no machine identifiers."""
from contextlib import redirect_stderr, redirect_stdout
import io
import json
import os
import subprocess
import sys
import unittest
from unittest.mock import patch


class CLITests(unittest.TestCase):
    def invoke(self, argv):
        from hermes_companion.cli import main
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            status = main(argv)
        return status, out.getvalue(), err.getvalue()

    def test_version_does_not_import_sdk_or_server(self):
        with patch.dict(sys.modules, {"mcp": None, "hermes_companion.mac_server": None}):
            status, out, err = self.invoke(["--version"])
        self.assertEqual(status, 0)
        self.assertEqual(out.strip(), "hermes-companion 0.1.0a2")
        self.assertEqual(err, "")

    def test_no_subcommand_shows_help_without_side_effects(self):
        with patch("subprocess.Popen", side_effect=AssertionError("no subprocess")):
            status, out, err = self.invoke([])
        self.assertEqual(status, 0)
        self.assertIn("mcp-config", out)
        self.assertEqual(err, "")

    def test_config_command_outputs_only_json_without_connecting(self):
        with patch("subprocess.Popen", side_effect=AssertionError("no subprocess")):
            status, out, err = self.invoke([
                "mcp-config", "--mac-host", "operator@private-mac",
                "--mac-python", "/opt/companion/bin/python", "--workspace", "/srv/approved",
            ])
        self.assertEqual(status, 0)
        self.assertEqual(err, "")
        self.assertEqual(json.loads(out)["mcp_servers"]["mac_companion"]["command"], "ssh")

    def test_module_entry_point(self):
        result = subprocess.run([sys.executable, "-m", "hermes_companion", "--version"],
                                capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "hermes-companion 0.1.0a2")
        self.assertEqual(result.stderr, "")

    def test_bad_config_is_nonzero_and_does_not_echo_input(self):
        status, out, err = self.invoke([
            "mcp-config", "--mac-host", "user@SECRET.invalid;echo token=SECRET",
            "--mac-python", "/opt/python", "--workspace", "/srv/approved",
        ])
        self.assertEqual(status, 2)
        self.assertEqual(out, "")
        self.assertNotIn("SECRET", err)

    def test_parser_errors_do_not_echo_unknown_secret_arguments(self):
        status, out, err = self.invoke(["mcp-config", "--password=VERY_SECRET"])
        self.assertEqual(status, 2)
        self.assertEqual(out, "")
        self.assertNotIn("VERY_SECRET", err)

    def test_doctor_is_local_only_and_not_full_integration_ready(self):
        with patch("subprocess.Popen", side_effect=AssertionError("no subprocess")), \
                patch("hermes_companion.cli.shutil.which", return_value="/private/user/bin/tool"), \
                patch("hermes_companion.cli._sdk_available", return_value=True):
            status, out, err = self.invoke(["doctor"])
        self.assertEqual(status, 0)
        report = json.loads(out)
        self.assertEqual(report["component_version"], "0.1.0a2")
        self.assertTrue(report["sdk_available"])
        self.assertTrue(report["ssh_available"])
        self.assertTrue(report["hermes_available"])
        self.assertFalse(report["connection_verified"])
        self.assertFalse(report["full_integration_ready"])
        self.assertEqual(err, "")
        self.assertNotIn("/private", out)
        self.assertNotIn(os.path.expanduser("~"), out)

    def test_doctor_reports_missing_sdk_as_nonzero(self):
        with patch("hermes_companion.cli._sdk_available", return_value=False):
            status, out, err = self.invoke(["doctor"])
        self.assertNotEqual(status, 0)
        self.assertFalse(json.loads(out)["sdk_available"])
        self.assertEqual(err, "")

    def test_serve_mac_lazily_delegates_validated_workspace(self):
        from types import SimpleNamespace
        from unittest.mock import Mock
        server_main = Mock(return_value=0)
        with patch.dict(sys.modules, {"hermes_companion.mac_server": SimpleNamespace(main=server_main)}):
            status, out, err = self.invoke(["serve-mac", "--workspace", "/srv/approved"])
        self.assertEqual(status, 0)
        server_main.assert_called_once_with(["--workspace", "/srv/approved"])
        self.assertEqual(out + err, "")

    def test_serve_mac_rejects_traversal_before_delegation(self):
        with patch.dict(sys.modules, {"hermes_companion.mac_server": None}):
            status, out, err = self.invoke(["serve-mac", "--workspace", "/srv/../private"])
        self.assertEqual(status, 2)
        self.assertEqual(out, "")
        self.assertNotIn("/srv", err)

    def test_verify_cli_is_explicit_and_outputs_safe_metadata(self):
        safe_report = {"connection_verified": True, "execution_host": "mac", "system": "Darwin",
                       "read_performed": False, "full_integration_ready": False}
        with patch("hermes_companion.cli.verify_mac", return_value=safe_report) as verify:
            status, out, err = self.invoke([
                "verify-mac", "--mac-host", "operator@private-mac", "--mac-python", "/opt/python",
                "--workspace", "/srv/approved",
            ])
        self.assertEqual(status, 0)
        self.assertEqual(json.loads(out), safe_report)
        self.assertEqual(err, "")
        verify.assert_called_once_with("operator@private-mac", "/opt/python", "/srv/approved",
                                       host_os="mac", read_path=None, request_timeout=10.0, overall_timeout=30.0)

    def test_verify_cli_optional_read_and_timeout_arguments(self):
        with patch("hermes_companion.cli.verify_mac", return_value={"read_performed": True}) as verify:
            status, out, err = self.invoke([
                "verify-mac", "--mac-host", "operator@private-mac", "--mac-python", "/opt/python",
                "--workspace", "/srv/approved", "--read", "fixture.txt",
                "--request-timeout", "2", "--overall-timeout", "8",
            ])
        self.assertEqual(status, 0)
        verify.assert_called_once_with("operator@private-mac", "/opt/python", "/srv/approved",
                                       host_os="mac", read_path="fixture.txt", request_timeout=2.0, overall_timeout=8.0)

    def test_verify_cli_failure_is_nonzero_without_private_diagnostics(self):
        from hermes_companion.cli import VerificationError
        with patch("hermes_companion.cli.verify_mac", side_effect=VerificationError("Mac connection verification failed")):
            status, out, err = self.invoke([
                "verify-mac", "--mac-host", "operator@private-mac", "--mac-python", "/opt/python",
                "--workspace", "/srv/approved",
            ])
        self.assertEqual(status, 1)
        self.assertEqual(out, "")
        self.assertNotIn("operator", err)
        self.assertNotIn("/opt", err)


if __name__ == "__main__":
    unittest.main()

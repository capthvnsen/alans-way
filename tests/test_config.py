"""Portable tests for a pure, print-only SSH configuration generator."""
import json
import shlex
import unittest


class ConfigTests(unittest.TestCase):
    def test_generates_scoped_ssh_fragment(self):
        from hermes_companion.config import MAC_TOOLS, build_mcp_config

        config = build_mcp_config(
            "operator@private-mac", "/opt/companion/bin/python", "/srv/approved workspace"
        )
        server = json.loads(json.dumps(config))["mcp_servers"]["mac_companion"]
        self.assertEqual(server["command"], "ssh")
        self.assertEqual(server["args"][:-2], [
            "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
            "-o", "ConnectTimeout=5",
        ])
        self.assertEqual(server["args"][-2], "operator@private-mac")
        self.assertEqual(shlex.split(server["args"][-1]), [
            "/opt/companion/bin/python", "-m", "hermes_companion.mac_server",
            "--workspace", "/srv/approved workspace",
        ])
        self.assertEqual(server["trust"], "untrusted")
        self.assertEqual(server["env"], {"SSH_AUTH_SOCK": "${SSH_AUTH_SOCK}"})
        self.assertEqual(server["sampling"], {"enabled": False})
        self.assertEqual(server["tools"], {
            "include": list(MAC_TOOLS), "resources": False, "prompts": False,
        })
        self.assertEqual(len(MAC_TOOLS), 3)

    def test_rejects_unsafe_host_without_echoing_it(self):
        from hermes_companion.config import build_mcp_config

        hosts = ["-oProxyCommand=bad", "user@host;touch", "user@host/name",
                 "user@host name", "user@host\n", "user@$(secret)",
                 "user@@host", "user@host:22", "user@-host", "host", "", "u@host${X}"]
        for host in hosts:
            with self.subTest(host=host):
                with self.assertRaises(ValueError) as caught:
                    build_mcp_config(host, "/opt/python", "/srv/approved")
                if host:
                    self.assertNotIn(repr(host), str(caught.exception))

    def test_rejects_non_absolute_traversal_and_control_paths(self):
        from hermes_companion.config import build_mcp_config

        paths = ["relative", "~/approved", "/srv/../private", "/srv/./approved",
                 "/srv/approved\x00", "/srv/approved\n", "//srv/approved",
                 "/srv/${PRIVATE}", "/srv/\x85secret", ""]
        for path in paths:
            for field in ("python", "workspace"):
                with self.subTest(field=field, path=path):
                    args = ["user@private-mac", "/opt/python", "/srv/approved"]
                    args[1 if field == "python" else 2] = path
                    with self.assertRaises(ValueError):
                        build_mcp_config(*args)

    def test_shell_metacharacters_in_paths_are_quoted_not_executed(self):
        from hermes_companion.config import build_mcp_config

        python = "/opt/my env/python';touch sentinel;#"
        workspace = "/srv/approved workspace; echo 'not executed'"
        command = build_mcp_config("user@private-mac", python, workspace)[
            "mcp_servers"]["mac_companion"]["args"][-1]
        self.assertEqual(shlex.split(command), [python, "-m", "hermes_companion.mac_server",
                                                "--workspace", workspace])


if __name__ == "__main__":
    unittest.main()

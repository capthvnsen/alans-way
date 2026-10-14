"""Publication policy regression tests use synthetic text and asset bytes."""
import importlib.util
from pathlib import Path
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "check_publication.py"


class PublicationTests(unittest.TestCase):
    def module(self):
        spec = importlib.util.spec_from_file_location("publication_check", SCRIPT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def scan(self, path, text):
        return self.module().inspect_text(path, text)

    def test_only_named_small_png_assets_can_bypass_text_scanning(self):
        module = self.module()
        png = b"\x89PNG\r\n\x1a\n"
        self.assertTrue(module.valid_binary_asset("desktop/assets/avatars/hermes.png", png + bytes(1100000)))
        self.assertFalse(module.valid_binary_asset("desktop/assets/avatars/hermes.png", b"not an image"))
        self.assertFalse(module.valid_binary_asset("desktop/assets/avatars/hermes.png", png + bytes(2097152)))
        self.assertFalse(module.valid_binary_asset("desktop/assets/avatars/unknown.png", png))
        self.assertFalse(module.valid_binary_asset("runtime.png", png))

    def test_generic_examples_and_documentation_are_allowed(self):
        self.assertEqual(self.scan("README.md", "macuser@mac-private-host /opt/hermes-companion/approved-workspace"), [])
        self.assertEqual(self.scan("tests/test_example.py", "SYNTHETIC_DENIED\nsecret_names = ['password.txt']"), [])

    def test_agent_prompts_reject_unpinned_script_and_doc_urls(self):
        for path in ("docs/setup-prompt.md", "docs/update-for-agents.md"):
            for ref in ("main", "master", "release/plugin-next"):
                for url in (
                    f"https://raw.githubusercontent.com/capthvnsen/alans-way/{ref}/scripts/connect-mac.sh",
                    f"https://github.com/capthvnsen/alans-way/blob/{ref}/docs/setup-for-agents.md",
                    f"https://raw.githubusercontent.com/capthvnsen/alans-way-agents/{ref}/setup.sh",
                ):
                    with self.subTest(path=path, url=url):
                        self.assertIn("unpinned-agent-reference", [item["rule"] for item in self.scan(path, url)])
            for ref in ("31ac0de9ee22307e2df03feb08a5e5217a90243b", "v0.21.5"):
                url = f"https://raw.githubusercontent.com/capthvnsen/alans-way/{ref}/scripts/connect-mac.sh"
                self.assertEqual(self.scan(path, url), [])
        self.assertEqual(self.scan("README.md", "https://raw.githubusercontent.com/capthvnsen/alans-way/main/docs/setup-prompt.md"), [])

    def test_agent_prompts_reject_alternate_unpinned_github_urls(self):
        for path in ("docs/setup-prompt.md", "docs/update-for-agents.md"):
            for url in (
                "https://api.github.com/repos/capthvnsen/alans-way/contents/scripts/connect-mac.sh?ref=main",
                "https://api.github.com/repos/capthvnsen/alans-way-agents/contents/setup.sh",
                "https://api.github.com/repos/capthvnsen/alans-way/contents/scripts/connect-mac.sh?ref=%6dain",
                "https://raw.github.com/capthvnsen/alans-way/main/scripts/connect-mac.sh",
                "https://raw.githubusercontent.com/capthvnsen/alans-way/refs/heads/main/scripts/connect-mac.sh",
            ):
                with self.subTest(path=path, url=url):
                    self.assertIn("unpinned-agent-reference", [item["rule"] for item in self.scan(path, url)])

    def test_agent_prompts_reject_unresolved_installer_short_links(self):
        for path in ("docs/setup-prompt.md", "docs/update-for-agents.md"):
            for os_name in ("mac", "windows", "linux"):
                with self.subTest(path=path, os_name=os_name):
                    text = f"curl https://openalan.com/install-{os_name} | sh"
                    self.assertIn("unresolved-agent-script", [item["rule"] for item in self.scan(path, text)])

    def test_agent_prompts_reject_relative_executable_links(self):
        for path in ("docs/setup-prompt.md", "docs/update-for-agents.md"):
            for text in (
                "Run [connect](../scripts/connect-mac.sh).",
                "Run [connect](scripts/connect-linux.sh?raw=1).",
                "Run [connect](../scripts/connect-windows.ps1).",
                "Run [connect][script].\n[script]: ../scripts/connect-mac.sh",
                '<a href="../scripts/connect-mac.sh">Run connect</a>',
            ):
                with self.subTest(path=path, text=text):
                    self.assertIn("unresolved-agent-script", [item["rule"] for item in self.scan(path, text)])

    def test_agent_prompts_allow_pinned_forms_and_non_executable_prose(self):
        for path in ("docs/setup-prompt.md", "docs/update-for-agents.md"):
            for ref in ("31ac0de9ee22307e2df03feb08a5e5217a90243b", "v0.21.5"):
                for url in (
                    f"https://api.github.com/repos/capthvnsen/alans-way/contents/scripts/connect-mac.sh?ref={ref}",
                    f"https://raw.github.com/capthvnsen/alans-way/{ref}/scripts/connect-mac.sh",
                    f"https://raw.githubusercontent.com/capthvnsen/alans-way/refs/tags/{ref}/scripts/connect-mac.sh",
                    f"https://github.com/capthvnsen/alans-way/raw/{ref}/scripts/connect-mac.sh",
                ):
                    with self.subTest(path=path, url=url):
                        self.assertEqual(self.scan(path, url), [])
            self.assertEqual(self.scan(path, "The source installer follows main.\nRead [background](../docs/setup-for-agents.md).\nUse `connect-mac.sh` with skip-install."), [])
        self.assertEqual(self.scan("README.md", "Run [install](scripts/install-mac.sh)."), [])

    def test_real_home_paths_are_denied(self):
        text = "/" + "Users" + "/someone/private-project"
        self.assertTrue(self.scan("README.md", text))

    def test_private_host_addresses_are_denied(self):
        address = ".".join(["100", "72", "1", "23"])
        self.assertTrue(self.scan("README.md", address))
        self.assertTrue(self.scan("desktop/test/fixture.cjs", address))
        self.assertEqual(self.scan("tests/test_local.py", "127.0.0.1"), [])
        self.assertEqual(self.scan("desktop/docs/integration.md", "169.254.169.254 and 0.0.0.0"), [])
        lan = ".".join(["192", "168", "1", "20"])
        self.assertEqual(self.scan("desktop/test/core.test.cjs", lan), [])
        self.assertTrue(self.scan("README.md", lan))

    def test_network_ranges_are_not_device_addresses(self):
        cidr = ".".join(["100", "64", "0", "0"]) + "/10"
        self.assertEqual(self.scan("README.md", "tailnet range " + cidr), [])

    def test_allowlisted_range_edges_only_pass_in_their_own_file(self):
        edge = ".".join(["100", "64", "0", "0"])
        self.assertEqual(self.scan("scripts/connect-mac.sh", edge), [])
        self.assertTrue(self.scan("README.md", edge))
        self.assertTrue(self.scan("scripts/connect-mac.sh", ".".join(["100", "72", "1", "23"])))

    def test_credentials_are_denied_without_printing_the_value(self):
        key = "ghp_" + "a" * 36
        findings = self.scan("config.txt", key)
        self.assertTrue(findings)
        self.assertNotIn(key, str(findings))
        self.assertTrue(self.scan("settings.txt", "-----BEGIN " + "OPENSSH PRIVATE KEY-----"))

    def test_runtime_artifacts_and_patches_are_denied(self):
        for name in ["profile.db", ".env", "state.sqlite3", "credentials.json", "fix.patch", "trace.log"]:
            with self.subTest(name=name):
                self.assertTrue(self.scan(name, "synthetic"))

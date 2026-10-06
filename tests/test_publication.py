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

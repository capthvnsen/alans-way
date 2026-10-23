"""Inspect a real compiled iOS app; skip on hosts without a simulator build."""
from pathlib import Path
import plistlib
import re
import unittest


ROOT = Path(__file__).resolve().parents[1]
BUNDLE_INFO = ROOT / "ios/.build/DerivedData/Build/Products/Debug-iphonesimulator/AlanWorkspace.app/Info.plist"


@unittest.skipUnless(BUNDLE_INFO.is_file(), "Build the iOS simulator app first")
class IOSBundleConfigurationTests(unittest.TestCase):
    def test_app_version_matches_project_build_settings(self):
        info = plistlib.loads(BUNDLE_INFO.read_bytes())
        project = (ROOT / "ios/project.yml").read_text()
        for field, setting in (("CFBundleShortVersionString", "MARKETING_VERSION"), ("CFBundleVersion", "CURRENT_PROJECT_VERSION")):
            expected = re.search(r"^\s*" + setting + r":\s*['\"]?([^'\"\s]+)", project, re.MULTILINE)
            self.assertIsNotNone(expected)
            self.assertEqual(info.get(field), expected.group(1))

    def test_app_contains_telegram_application_fields(self):
        info = plistlib.loads(BUNDLE_INFO.read_bytes())
        for key in ("TELEGRAM_API_ID", "TELEGRAM_API_HASH"):
            with self.subTest(field=key):
                self.assertIsInstance(info.get(key), str)

    def test_local_application_configuration_reaches_the_compiled_app(self):
        config = ROOT / "ios/LocalConfiguration.xcconfig"
        if not config.is_file():
            self.skipTest("No private application configuration supplied")
        info = plistlib.loads(BUNDLE_INFO.read_bytes())
        source = config.read_text()
        for key in ("TELEGRAM_API_ID", "TELEGRAM_API_HASH"):
            with self.subTest(field=key):
                expected = re.search(r"^\s*" + key + r"\s*=\s*(\S+)\s*$", source, re.MULTILINE)
                self.assertIsNotNone(expected, "Local application configuration is incomplete")
                # Never include actual credential values in assertion messages.
                self.assertTrue(info.get(key) == expected.group(1), "Compiled application configuration does not match its input")

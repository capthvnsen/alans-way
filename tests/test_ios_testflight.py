"""Exercise the release script without contacting Apple or building a binary."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "ios/scripts/testflight.sh"


class TestFlightUploadTests(unittest.TestCase):
    def run_upload(self, *, team="TESTTEAM01", fail_archive=False, extra_env=None, local_config=None):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            log = root / "commands.jsonl"
            for executable in ("xcodegen", "xcodebuild"):
                tool = root / executable
                tool.write_text(
                    "#!/usr/bin/env python3\n"
                    "import json,os,pathlib,plistlib,sys\n"
                    "row={'tool':pathlib.Path(sys.argv[0]).name,'args':sys.argv[1:]}\n"
                    "if '-exportOptionsPlist' in sys.argv:\n"
                    " p=sys.argv[sys.argv.index('-exportOptionsPlist')+1]\n"
                    " row['export']=plistlib.loads(pathlib.Path(p).read_bytes())\n"
                    "with open(os.environ['TESTFLIGHT_COMMAND_LOG'],'a') as f: f.write(json.dumps(row)+'\\n')\n"
                    "if os.environ.get('TESTFLIGHT_FAIL_ARCHIVE')=='1' and sys.argv[-1]=='archive': sys.exit(65)\n"
                )
                tool.chmod(0o755)
            env = dict(os.environ, PATH=str(root) + os.pathsep + os.environ["PATH"],
                       TESTFLIGHT_COMMAND_LOG=str(log), TESTFLIGHT_FAIL_ARCHIVE=str(int(fail_archive)),
                       TESTFLIGHT_BUILD_DIR=str(root / "build"))
            env.pop("TELEGRAM_API_HASH", None)
            env["LOCAL_CONFIGURATION"] = str(root / "Local.xcconfig")
            if local_config is not None:
                (root / "Local.xcconfig").write_text(local_config)
            env.update(extra_env or {})
            env.pop("APPLE_TEAM_ID", None)
            if team is not None:
                env["APPLE_TEAM_ID"] = team
            result = subprocess.run(["sh", str(SCRIPT)], env=env, capture_output=True, text=True)
            commands = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
            return result, commands

    def test_missing_team_stops_before_apple_operations(self):
        result, commands = self.run_upload(team=None)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("APPLE_TEAM_ID", result.stderr)
        self.assertEqual(commands, [])

    def test_refuses_to_archive_with_a_telegram_api_hash(self):
        for kwargs in ({"extra_env": {"TELEGRAM_API_HASH": "synthetic-hash"}},
                       {"local_config": "TELEGRAM_API_HASH = synthetic-hash\n"}):
            result, commands = self.run_upload(**kwargs)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("TELEGRAM_API_HASH", result.stderr)
            self.assertNotIn("synthetic-hash", result.stderr)
            self.assertEqual(commands, [])
        result, _ = self.run_upload(local_config="TELEGRAM_API_HASH =\n// note\n")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_failed_archive_is_never_uploaded(self):
        result, commands = self.run_upload(fail_archive=True)
        self.assertEqual(result.returncode, 65)
        self.assertFalse(any("-exportArchive" in command["args"] for command in commands))

    def test_upload_is_internal_only_and_uses_signed_archive(self):
        result, commands = self.run_upload()
        self.assertEqual(result.returncode, 0, result.stderr)
        archive = next(command for command in commands if command["args"][-1] == "archive")
        self.assertIn("DEVELOPMENT_TEAM=TESTTEAM01", archive["args"])
        self.assertNotIn("CODE_SIGNING_ALLOWED=NO", archive["args"])
        export = next(command for command in commands if "-exportArchive" in command["args"])
        self.assertEqual(export["export"]["method"], "app-store-connect")
        self.assertEqual(export["export"]["destination"], "upload")
        self.assertEqual(export["export"]["teamID"], "TESTTEAM01")
        self.assertIs(export["export"]["testFlightInternalTestingOnly"], True)

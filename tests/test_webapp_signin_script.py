"""scripts/webapp-signin.sh against fake tailscale and hermes commands and a scratch HERMES_HOME."""
import base64
import hashlib
import hmac
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "webapp-signin.sh"


def verify(password, encoded):
    scheme, n, r, p, salt, dk = encoded.split("$")
    actual = hashlib.scrypt(password.encode(), salt=base64.b64decode(salt), n=int(n), r=int(r), p=int(p),
                            dklen=32, maxmem=0)
    return scheme == "scrypt" and hmac.compare_digest(actual, base64.b64decode(dk))


class WebappSigninScriptTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.home = self.tmp / "hermes"
        self.home.mkdir()
        self.bin = self.tmp / "bin"
        self.bin.mkdir()
        self.log = self.tmp / "calls.log"
        self.fake("tailscale", 'if [ "$1" = status ]; then printf \'%s\' "$TS_STATUS"; '
                               'elif [ "$1" = funnel ]; then printf \'%s\\n\' "$TS_FUNNEL"; fi')
        self.fake("hermes", "")

    def fake(self, name, body):
        path = self.bin / name
        path.write_text(f'#!/bin/sh\nprintf \'%s\\n\' "{name} $*" >> "{self.log}"\n{body}\n')
        path.chmod(0o755)

    def run_script(self, *args, dns="box.tail1234.ts.net.", funnel="https://box.tail1234.ts.net (tailnet only)"):
        env = {**os.environ, "PATH": f"{self.bin}:{os.environ['PATH']}", "HERMES_HOME": str(self.home), "SUDO": "",
               "TS_STATUS": f'{{"Self": {{"DNSName": "{dns}"}}}}', "TS_FUNNEL": funnel}
        return subprocess.run(["sh", str(SCRIPT), *args], capture_output=True, text=True, env=env, check=False)

    def calls(self):
        return self.log.read_text() if self.log.exists() else ""

    def test_sets_up_sign_in_without_printing_secrets(self):
        (self.home / ".env").write_text("OPENROUTER_API_KEY=keep-me\nexport HERMES_DASHBOARD_BASIC_AUTH_PASSWORD=old\n"
                                        "HERMES_DASHBOARD_BASIC_AUTH_SECRET=old\n")
        result = self.run_script("--user", "sam")
        self.assertEqual(result.returncode, 0, result.stderr)

        signin = self.home / "webapp-signin.txt"
        password = re.search(r"^password: (\S+)$", signin.read_text(), re.M).group(1)
        self.assertGreaterEqual(len(password), 24)
        self.assertIn("address: https://box.tail1234.ts.net\nusername: sam\n", signin.read_text())
        env = (self.home / ".env").read_text()
        secret = re.search(r"^HERMES_DASHBOARD_BASIC_AUTH_SECRET=(\S+)$", env, re.M).group(1)
        password_hash = re.search(r"^HERMES_DASHBOARD_BASIC_AUTH_PASSWORD_HASH=(\S+)$", env, re.M).group(1)
        self.assertTrue(verify(password, password_hash))
        self.assertEqual(len(base64.b64decode(secret)), 32)
        self.assertIn("OPENROUTER_API_KEY=keep-me\n", env)
        self.assertNotIn("PASSWORD=old", env, "a plaintext password would override the hash")
        self.assertNotIn("SECRET=old", env)
        for path in (signin, self.home / ".env"):
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600, path)

        for secret_text in (password, password_hash, secret):
            self.assertNotIn(secret_text, result.stdout + result.stderr)
            self.assertNotIn(secret_text, self.calls(), "secrets never go on a command line")
        self.assertIn("https://box.tail1234.ts.net", result.stdout)
        for call in ("hermes config set webapp.enabled true", "hermes config set webapp.host 127.0.0.1",
                     "hermes config set webapp.port 9120",
                     "hermes config set webapp.public_url https://box.tail1234.ts.net",
                     "hermes config set dashboard.basic_auth.username sam",
                     "tailscale serve --bg --https=443 http://127.0.0.1:9120", "hermes webapp --build-only"):
            self.assertIn(call + "\n", self.calls())
        self.assertNotIn("gateway", self.calls(), "the gateway is never restarted")
        self.assertEqual(list(self.home.glob(".webapp-signin-*")), [], "no temp files left")

        first = password
        self.assertEqual(self.run_script("--port", "9300").returncode, 0)
        self.assertNotIn(first, signin.read_text(), "a re-run rotates the password")
        self.assertEqual((self.home / ".env").read_text().count("PASSWORD_HASH="), 1)
        self.assertIn("tailscale serve --bg --https=443 http://127.0.0.1:9300\n", self.calls())

    def test_refuses_funnel_and_non_tailnet_names_before_writing(self):
        for kwargs, why in (({"funnel": "https://box.tail1234.ts.net (Funnel on)"}, "Funnel is on"),
                            ({"dns": "box.example.com."}, "not a .ts.net name"),
                            ({"dns": ""}, "no Tailscale name")):
            result = self.run_script(**kwargs)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(why, result.stderr)
            self.assertFalse((self.home / "webapp-signin.txt").exists())
            self.assertFalse((self.home / ".env").exists())
            self.assertNotIn("config set", self.calls())

    def test_rejects_unsafe_arguments(self):
        for args in (["--user", "a b"], ["--user", "$(id)"], ["--port", "9120;id"]):
            self.assertNotEqual(self.run_script(*args).returncode, 0, args)
        self.assertEqual(self.calls(), "")


if __name__ == "__main__":
    unittest.main()

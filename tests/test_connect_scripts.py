"""The connect scripts only accept Tailscale addresses and only authorize the VPS key from the tailnet."""
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample root@vps"
OTHER = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOther someone@laptop"
FROM = 'from="100.64.0.0/10,fd7a:115c:a1e0::/48"'


def helpers(name="connect-mac.sh"):
    text = (SCRIPTS / name).read_text(encoding="utf-8")
    return re.search(r"# --- tailnet helpers begin.*?# --- tailnet helpers end", text, re.S).group(0)


def sh(script):
    return subprocess.run(["sh", "-c", script], capture_output=True, text=True, check=False)


def run_key_install(keys, key, name="connect-mac.sh"):
    # The key travels as an argv word, the same way desktop/src/main.cjs passes it.
    return subprocess.run(
        ["sh", "-c", helpers(name) + '\ninstall_tailnet_key "$1" "$2"', "sh", str(keys), key],
        capture_output=True, text=True, check=False)


class TailnetHelperTests(unittest.TestCase):
    def accepts(self, host, name="connect-mac.sh"):
        return sh(f"{helpers(name)}\nis_tailnet_host '{host}'").returncode == 0

    def test_mac_and_linux_share_one_copy(self):
        self.assertEqual(helpers("connect-mac.sh"), helpers("connect-linux.sh"))

    def test_tailnet_addresses_and_names_pass(self):
        for host in ("100.64.0.1", "100.100.1.2", "100.127.255.254", "fd7a:115c:a1e0::1", "FD7A:115C:A1E0:ab12::5",
                     "hermes-vps", "hermes-vps.tail1234.ts.net", "box.ts.net", "Box.Tail1.TS.NET"):
            self.assertTrue(self.accepts(host), host)

    def test_public_and_private_addresses_are_refused(self):
        for host in ("8.8.8.8", "100.63.255.255", "100.128.0.1", "100.1.1.1", "10.0.0.5", "192.168.1.9", "127.0.0.1",
                     "100.64.0.256", "100.64.1", "100.64.0.1.5", "2001:db8::1", "fd7b:115c:a1e0::1",
                     "100.064.0.1", "100.64.00.1", "100.64.0.01", "0100.64.0.1", "vps.example.com", "hermes.local", "1.2.3.4.ts.net.evil.com", ".ts.net", "a..ts.net", ""):
            self.assertFalse(self.accepts(host), host)

    def test_key_is_restricted_to_the_tailnet_and_reruns_do_not_duplicate(self):
        with tempfile.TemporaryDirectory() as tmp:
            keys = Path(tmp) / "authorized_keys"
            keys.write_text(f"{OTHER}\n", encoding="utf-8")
            for _ in range(2):
                result = sh(f"{helpers()}\ninstall_tailnet_key '{keys}' '{KEY}'")
                self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(keys.read_text(encoding="utf-8").splitlines(), [OTHER, f"{FROM} {KEY}"])

    def test_an_old_unrestricted_line_for_the_same_key_is_replaced(self):
        with tempfile.TemporaryDirectory() as tmp:
            keys = Path(tmp) / "authorized_keys"
            keys.write_text(f"{KEY}\n{OTHER}\n{KEY}\n", encoding="utf-8")
            result = sh(f"{helpers()}\ninstall_tailnet_key '{keys}' '{KEY}'")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(keys.read_text(encoding="utf-8").splitlines(), [f"{FROM} {KEY}", OTHER])

    def test_an_empty_file_gets_exactly_one_line(self):
        with tempfile.TemporaryDirectory() as tmp:
            keys = Path(tmp) / "authorized_keys"
            keys.touch()
            sh(f"{helpers()}\ninstall_tailnet_key '{keys}' '{KEY}'")
            self.assertEqual(keys.read_text(encoding="utf-8").splitlines(), [f"{FROM} {KEY}"])

    def test_the_wanted_line_reaches_awk_through_the_environment(self):
        # awk -v interprets backslash escapes, so a key containing \n could
        # print an unrestricted second line into authorized_keys.
        for name in ("connect-mac.sh", "connect-linux.sh"):
            body = helpers(name).split("install_tailnet_key() {", 1)[1]
            self.assertIn('ENVIRON["WANT"]', body)
            self.assertNotIn("awk -v", body)

    def test_a_key_with_escapes_or_quotes_is_rejected_outright(self):
        hostile_keys = (
            'ssh-ed25519 AAAABBB \\ncommand="id" ssh-rsa CCC',  # awk -v escape injection
            "ssh-ed25519 AAAABBB\nssh-rsa CCC",  # a real newline
            'ssh-ed25519 "AAAABBB"',
            "ssh-ed25519 AA'AA'BBB",
        )
        for name in ("connect-mac.sh", "connect-linux.sh"):
            with tempfile.TemporaryDirectory() as tmp:
                keys = Path(tmp) / "authorized_keys"
                keys.write_text(f"{OTHER}\n", encoding="utf-8")
                for hostile in hostile_keys:
                    result = run_key_install(keys, hostile, name)
                    self.assertNotEqual(result.returncode, 0, (name, hostile))
                self.assertEqual(keys.read_text(encoding="utf-8").splitlines(), [OTHER])

    def test_a_failed_write_returns_nonzero(self):
        for name in ("connect-mac.sh", "connect-linux.sh"):
            result = run_key_install("/no/such/dir/authorized_keys", KEY, name)
            self.assertNotEqual(result.returncode, 0, name)


class KnownHostsTests(unittest.TestCase):
    def test_a_line_is_appended_on_its_own_line(self):
        with tempfile.TemporaryDirectory() as tmp:
            known = Path(tmp) / "known_hosts"
            known.write_text("a ssh-ed25519 AAAA", encoding="utf-8")
            sh(f"{helpers()}\nappend_known_host '{known}' 'b ssh-ed25519 BBBB'")
            sh(f"{helpers()}\nappend_known_host '{known}' 'c ssh-ed25519 CCCC'")
            self.assertEqual(known.read_text(encoding="utf-8").splitlines(),
                             ["a ssh-ed25519 AAAA", "b ssh-ed25519 BBBB", "c ssh-ed25519 CCCC"])

    def test_an_empty_file_gets_no_blank_line(self):
        with tempfile.TemporaryDirectory() as tmp:
            known = Path(tmp) / "known_hosts"
            known.touch()
            sh(f"{helpers()}\nappend_known_host '{known}' 'a ssh-ed25519 AAAA'")
            self.assertEqual(known.read_text(encoding="utf-8"), "a ssh-ed25519 AAAA\n")

    def test_both_scripts_use_it(self):
        for name in ("connect-mac.sh", "connect-linux.sh"):
            text = (SCRIPTS / name).read_text(encoding="utf-8")
            self.assertIn('append_known_host "$HOME/.ssh/known_hosts"', text)
            self.assertNotIn(">> \"$HOME/.ssh/known_hosts\"", text)


class ScriptShapeTests(unittest.TestCase):
    def test_shell_scripts_parse(self):
        for name in ("connect-mac.sh", "connect-linux.sh"):
            subprocess.run(["sh", "-n", str(SCRIPTS / name)], check=True)

    def test_windows_usage_names_real_parameters(self):
        text = (SCRIPTS / "connect-windows.ps1").read_text(encoding="utf-8-sig")
        header = text.split("[CmdletBinding()]")[0]
        for old in ("--vps", "--vps-host-key", "--vps-key"):
            self.assertNotIn(old, header + text.split("param(")[1].split(")")[0])
        for flag in ("-Vps ", "-VpsHostKey ", "-VpsKey "):
            self.assertIn(flag, header)
        self.assertIn('from="100.64.0.0/10,fd7a:115c:a1e0::/48"', text)

    def test_windows_script_keeps_its_byte_order_mark(self):
        self.assertTrue((SCRIPTS / "connect-windows.ps1").read_bytes().startswith(b"\xef\xbb\xbf"))

    def test_linux_script_builds_the_builder_output_and_has_no_em_dashes(self):
        text = (SCRIPTS / "connect-linux.sh").read_text(encoding="utf-8")
        self.assertIn("npm run package:linux", text)
        self.assertIn('dist/linux-unpacked"', text)
        self.assertNotIn("\u2014", text)

    def test_linux_script_needs_node_22_12_and_x86_64(self):
        text = (SCRIPTS / "connect-linux.sh").read_text(encoding="utf-8")
        self.assertIn("22.12", text)
        self.assertNotIn("Node 20", text)
        self.assertIn('uname -m', text)
        self.assertIn("x86_64", text)
        for doc in ("README.md", "docs/setup-prompt.md", "docs/setup-for-agents.md"):
            body = (ROOT / doc).read_text(encoding="utf-8")
            self.assertNotRegex(body, r"(?i)node 20", doc)

    def test_linux_script_checks_the_app_stayed_up_and_keeps_its_log(self):
        text = (SCRIPTS / "connect-linux.sh").read_text(encoding="utf-8")
        self.assertNotIn('"$DEST/$APP_NAME" >/dev/null 2>&1 &', text)
        self.assertIn("pgrep -f", text)
        self.assertIn("--no-sandbox", text)

    def test_windows_script_never_truncates_existing_key_files(self):
        text = (SCRIPTS / "connect-windows.ps1").read_text(encoding="utf-8-sig")
        self.assertNotRegex(text, r"New-Item -ItemType File[^\n]*-Force")
        for var in ("$keysFile", "$knownHosts"):
            self.assertRegex(text, r"if \(-not \(Test-Path " + re.escape(var) + r"\)\) \{ New-Item -ItemType File")

    def test_linux_script_probes_sshd_before_touching_units(self):
        text = (SCRIPTS / "connect-linux.sh").read_text(encoding="utf-8")
        probe = text.index("ssh-keyscan -T 3 127.0.0.1")
        self.assertLess(probe, text.index("systemctl enable --now"))
        self.assertLess(probe, text.index("list-unit-files"))
        self.assertIn("ssh.socket", text)

    def test_windows_keys_file_is_written_without_a_byte_order_mark(self):
        text = (SCRIPTS / "connect-windows.ps1").read_text(encoding="utf-8-sig")
        self.assertIn("UTF8Encoding($false)", text)
        self.assertNotIn("-Encoding ascii", text)
        self.assertIn("(0|[1-9]", text)

    def test_readme_intro_has_no_em_dash(self):
        intro = (ROOT / "README.md").read_text(encoding="utf-8").splitlines()[7]
        self.assertNotIn("\u2014", intro)

    def test_linux_script_is_executable_like_the_others(self):
        self.assertTrue((SCRIPTS / "connect-linux.sh").stat().st_mode & 0o111)


# A fake ssh runs the remote command locally with sh, so the quoting that
# connect-server.sh builds goes through a real shell round trip. lsh stands in
# for the login shell, which would reset PATH and lose the fake curl. Like the
# real ssh, it reads stdin, which under curl | sh is the rest of the script.
FAKE_SSH = r"""#!/bin/sh
while [ $# -gt 0 ]; do case "$1" in -o|-O) shift 2;; -t) shift;; *) break;; esac; done
shift
case "$*" in
  "") exit 0;;
  "sh -s") cat >/dev/null; printf 'VPS_SSH=root@hermes-vps\nVPS_KEY=%s\nVPS_HOST_KEY=ssh-ed25519 AAAAhost\n' "$VPS_KEY";;
  test\ -e*) cat >/dev/null; echo ok;;
  true|exit) cat >/dev/null;;
  *) SHELL="$(dirname "$0")/lsh" sh -c "$*";;
esac
"""
FAKE_CONNECT = r"""#!/bin/sh
printf '%s\n' "$*" > "$HOME/connect-args"
echo "connect: pinned"
echo "===== Copy everything between these lines and send it to your agent ====="
echo "MAC_SSH=me@my-mac.ts.net"
echo "MAC_TZ=America/Denver"
echo "MAC_HOST_KEY=ssh-ed25519 AAAAmachost"
echo "MAC_KEY=ssh-ed25519 AAAAmac me@mac"
echo "===== end ====="
"""


class ConnectServerTests(unittest.TestCase):
    def test_server_setup_gets_this_computers_values_through_the_quoting(self):
        for piped in (False, True):
            with self.subTest(piped=piped):
                self.run_wizard(piped)

    def run_wizard(self, piped):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            for name, body in (("bin/ssh", FAKE_SSH), ("bin/curl", '#!/bin/sh\ncase "$2" in *connect-*) cp "$HOME/connect.sh" "$4";; *) cp "$HOME/setup.sh" "$4";; esac\n'),
                               ("bin/lsh", '#!/bin/sh\nexec sh -c "$2"\n'),
                               ("scripts/connect-mac.sh", FAKE_CONNECT), ("scripts/connect-linux.sh", FAKE_CONNECT),
                               ("connect.sh", FAKE_CONNECT),
                               ("setup.sh", '#!/bin/sh\nprintf "%s\\n" "$@" > "$HOME/setup-args"\n')):
                (tmp / name).parent.mkdir(parents=True, exist_ok=True)
                (tmp / name).write_text(body, encoding="utf-8")
                (tmp / name).chmod(0o755)
            (tmp / "scripts/connect-server.sh").write_text((SCRIPTS / "connect-server.sh").read_text(encoding="utf-8"))
            args = ["--server", "root@hermes-vps", "--", "--profile", "it's"]
            script = (tmp / "scripts/connect-server.sh").read_text()
            # A new session has no /dev/tty, as when an agent runs the script.
            result = subprocess.run(
                ["sh", "-s", "--", *args] if piped else ["sh", str(tmp / "scripts/connect-server.sh"), *args],
                env={"HOME": str(tmp), "PATH": f"{tmp}/bin:/usr/bin:/bin", "VPS_KEY": KEY}, cwd=tmp,
                input=script if piped else "", capture_output=True, text=True, check=False, start_new_session=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("Connected.", result.stdout)
            self.assertNotIn("send it to your agent", result.stdout)
            self.assertIn(f"--vps root@hermes-vps --vps-host-key ssh-ed25519 AAAAhost --vps-key {KEY}",
                          (tmp / "connect-args").read_text())
            self.assertEqual((tmp / "setup-args").read_text().splitlines(), [
                "--mac-ssh", "me@my-mac.ts.net", "--host-os", "mac" if "Darwin" in subprocess.check_output(["uname", "-s"], text=True) else "linux",
                "--timezone", "America/Denver", "--mac-key", "ssh-ed25519 AAAAmac me@mac",
                "--mac-host-key", "ssh-ed25519 AAAAmachost", "--restart", "--profile", "it's"])

    def test_connect_mac_keeps_the_installer_from_asking(self):
        self.assertIn("ALANS_WAY_SKIP_CONNECT=1 sh", (SCRIPTS / "connect-mac.sh").read_text(encoding="utf-8"))
        self.assertIn("ALANS_WAY_SKIP_CONNECT", (SCRIPTS / "install-mac.sh").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()

"""The reboot smoke test defaults to a safe check and only kills managed services."""
import os
from pathlib import Path
import pty
import signal
import subprocess
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "reboot-smoke.sh"

NODE = r"""#!/bin/sh
case "$*" in
  *HERMES_VPS_BROWSER_DATA*) printf '%s\n' "$HERMES_VPS_BROWSER_DATA";;
  *user-data-dir*) printf '%s\n' "$FAKE_PROFILE";;
  */v1/status*) exit 0;;
  *) exit 1;;
esac
"""

PGREP = r"""#!/bin/sh
[ "$1" = -f ] && [ "$2" = -- ] && [ "$#" = 3 ] || exit 2
pattern=$3
tmp="$PROCS.tmp.$$"
matches="$PROCS.matches.$$"
restarted="$PROCS.restarted.$$"
PATTERN="$pattern" STATE_OUT="$tmp" MATCHES_OUT="$matches" RESTARTED_OUT="$restarted" awk -F '\t' -v OFS='\t' '
{
  pid = $1
  wanted = index($4, ENVIRON["PATTERN"])
  alive = system("kill -0 " pid " >/dev/null 2>&1") == 0
  if (wanted && !alive && $3 == "1") {
    command = "sh -c '\''sleep 600 </dev/null >/dev/null 2>&1 & echo $!'\''"
    command | getline pid
    close(command)
    $1 = pid
    alive = 1
    if (index(ENVIRON["PATTERN"], "user-data-dir=")) print "1" > ENVIRON["RESTARTED_OUT"]
  }
  print > ENVIRON["STATE_OUT"]
  if (wanted && alive) print pid > ENVIRON["MATCHES_OUT"]
}
' "$PROCS"
mv "$tmp" "$PROCS"
[ ! -f "$matches" ] || cat "$matches"
if [ -f "$restarted" ]; then
  PATTERN='vps-browser-host.cjs serve' awk -F '\t' '$2 == "node" && index($4, ENVIRON["PATTERN"]) { print $1 }' "$PROCS" |
    while IFS= read -r pid; do kill -9 "$pid" 2>/dev/null || true; done
fi
rm -f "$matches" "$restarted"
"""

PS = r"""#!/bin/sh
[ "$1" = -o ] && [ "$2" = comm= ] && [ "$3" = -p ] && [ "$#" = 4 ] || exit 2
PID=$4 awk -F '\t' '$1 == ENVIRON["PID"] { print $2; found = 1 } END { exit !found }' "$PROCS"
"""


@unittest.skipIf(os.name == "nt", "requires Unix process and pty behavior")
class RebootSmokeTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory(dir=ROOT / "tests", prefix=".reboot-smoke-")
        self.tmp = Path(self.tempdir.name)
        self.bin = self.tmp / "bin"
        self.bin.mkdir()
        self._stub("node", NODE)
        self._stub("pgrep", PGREP)
        self._stub("ps", PS)
        self.data = self.tmp / "data"
        self.data.mkdir()
        (self.data / "config.json").write_text("{}\n", encoding="utf-8")
        self.profile = self.tmp / "profile"
        self.profile.mkdir()
        self.procs = self.tmp / "procs"
        self.all_pids = set()
        self.original = {}
        self.entries = []
        self._add("chrome", "chrome", 1, f"{self.bin}/chrome --user-data-dir={self.profile}")
        self._add("helper", "Google Chrome Helper (Renderer)", 1,
                  f"{self.bin}/chrome --user-data-dir={self.profile} --type=renderer")
        self._add("broker", "node", 1, "node /x/vps-browser-host.cjs serve")
        self._add("keeper", "node", 1, "node /x/vps-chromium-host.cjs")
        self._add("tail", "tail", 0, "tail -f /x/vps-chromium-host.cjs.log")
        self._add("vim", "vim", 0, "vim /x/vps-browser-host.cjs serve")
        self._write_entries()
        self.env = {
            **os.environ,
            "PATH": f"{self.bin}:/usr/bin:/bin",
            "HERMES_VPS_BROWSER_DATA": str(self.data),
            "FAKE_PROFILE": str(self.profile),
            "PROCS": str(self.procs),
            "SMOKE_TIMEOUT": "20",
        }

    def tearDown(self):
        if self.procs.exists():
            self.all_pids.update(entry[0] for entry in self._read_entries())
        for pid in self.all_pids:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        self.tempdir.cleanup()

    def _stub(self, name, body):
        path = self.bin / name
        path.write_text(body, encoding="utf-8")
        path.chmod(0o755)

    def _start_sleep(self):
        result = subprocess.run(
            ["sh", "-c", "sleep 600 </dev/null >/dev/null 2>&1 & echo $!"],
            capture_output=True, text=True, check=True)
        pid = int(result.stdout)
        self.all_pids.add(pid)
        return pid

    def _add(self, name, comm, restart, cmdline):
        pid = self._start_sleep()
        self.original[name] = pid
        self.entries.append((pid, comm, restart, cmdline))

    def _write_entries(self):
        self.procs.write_text("".join(f"{pid}\t{comm}\t{restart}\t{cmdline}\n"
                                      for pid, comm, restart, cmdline in self.entries), encoding="utf-8")

    def _read_entries(self):
        return [(int(pid), comm, int(restart), cmdline)
                for pid, comm, restart, cmdline in
                (line.split("\t", 3) for line in self.procs.read_text(encoding="utf-8").splitlines())]

    def _run(self, *args, stdin=subprocess.DEVNULL):
        result = subprocess.run(
            ["sh", str(SCRIPT), *args], env=self.env, stdin=stdin,
            capture_output=True, text=True, check=False, timeout=60)
        self.all_pids.update(entry[0] for entry in self._read_entries())
        return result

    def _run_pty(self, answer):
        master, slave = pty.openpty()
        try:
            os.write(master, answer)
            process = subprocess.Popen(
                ["sh", str(SCRIPT), "--crash"], env=self.env, stdin=slave,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            os.close(slave)
            slave = None
            stdout, stderr = process.communicate(timeout=60)
        finally:
            if slave is not None:
                os.close(slave)
            os.close(master)
        self.all_pids.update(entry[0] for entry in self._read_entries())
        return subprocess.CompletedProcess(process.args, process.returncode, stdout, stderr)

    def assert_alive(self, pid):
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            self.fail(f"pid {pid} is not alive")

    def assert_dead(self, pid):
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return
            time.sleep(0.02)
        self.fail(f"pid {pid} is still alive")

    def assert_all_original_alive(self):
        for name, pid in self.original.items():
            with self.subTest(process=name):
                self.assert_alive(pid)

    def assert_services_replaced_and_bystanders_alive(self):
        current = {cmdline: pid for pid, _comm, _restart, cmdline in self._read_entries()}
        for name in ("chrome", "helper", "broker", "keeper"):
            with self.subTest(process=name):
                self.assert_dead(self.original[name])
                cmdline = next(entry[3] for entry in self.entries if entry[0] == self.original[name])
                self.assertNotEqual(current[cmdline], self.original[name])
                self.assert_alive(current[cmdline])
        self.assert_alive(self.original["tail"])
        self.assert_alive(self.original["vim"])

    def test_no_args_only_checks_health(self):
        result = self._run()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("reboot-smoke: passed", result.stdout)
        self.assert_all_original_alive()

    def test_check_only_checks_health(self):
        result = self._run("--check")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("reboot-smoke: passed", result.stdout)
        self.assert_all_original_alive()

    def test_noninteractive_crash_requires_yes(self):
        result = self._run("--crash")
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("--yes", result.stderr)
        self.assert_all_original_alive()

    def test_crash_can_be_declined_on_a_terminal(self):
        result = self._run_pty(b"n\n")
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("nothing killed", result.stderr)
        self.assert_all_original_alive()

    def test_crash_can_be_confirmed_on_a_terminal(self):
        result = self._run_pty(b"y\n")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("reboot-smoke: passed", result.stdout)
        self.assert_services_replaced_and_bystanders_alive()

    def test_yes_crashes_without_prompting(self):
        result = self._run("--crash", "--yes")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotIn("[y/N]", result.stderr)
        self.assert_services_replaced_and_bystanders_alive()

    def test_crash_kills_chrome_for_testing(self):
        comms = {self.original["chrome"]: "Google Chrome for Testing",
                 self.original["helper"]: "Google Chrome for Testing Helper (Renderer)"}
        self.entries = [(pid, comms.get(pid, comm), restart, cmdline)
                        for pid, comm, restart, cmdline in self.entries]
        self._write_entries()
        result = self._run("--crash", "--yes")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assert_services_replaced_and_bystanders_alive()

    def test_a_bystander_is_not_a_keeper(self):
        self.entries = [entry for entry in self.entries if entry[0] != self.original["keeper"]]
        self._write_entries()
        result = self._run()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("Chromium keeper", result.stderr)
        self.assertIn("is not running", result.stderr)
        self.assert_all_original_alive()

    def test_invalid_argument_combinations_are_usage_errors(self):
        for args in (("--check", "--crash"), ("--yes",), ("--bogus",)):
            with self.subTest(args=args):
                result = self._run(*args)
                self.assertEqual(result.returncode, 64, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()

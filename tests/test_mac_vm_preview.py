"""VM preview cleanup tests use shell doubles; no VM or service is launched."""
from pathlib import Path
import subprocess
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "mac-vm-preview.sh"


class PreviewCleanupTests(unittest.TestCase):
    def test_vm_failure_is_reported_as_a_failed_preview(self):
        source = SCRIPT.read_text(encoding="utf-8")
        footer = "rc=0; wait" + source.split("rc=0; wait", 1)[1]
        result = subprocess.run(["sh", "-c", """set -eu
say() { printf '%s\\n' "$*"; }
wait() { return 23; }
tail() { :; }
TART_PID=123 LOG=fixture.log
""" + footer], capture_output=True, text=True, timeout=5, check=False)
        self.assertEqual(result.returncode, 23, result.stdout + result.stderr)
        self.assertIn("tart exited with status 23", result.stdout)

    def test_exited_bridge_does_not_skip_vm_shutdown_or_log_cleanup(self):
        source = SCRIPT.read_text(encoding="utf-8")
        cleanup = source.split("cleanup() {", 1)[1].split("\ntrap 'cleanup' EXIT", 1)[0]
        # Model a bridge that exited before the still-running VM. All process
        # and filesystem commands are doubles, including shell builtins.
        harness = """set -eu
exec 3>&1
say() { :; }
kill() {
  if [ "$1" = -0 ]; then return 0; fi
  return 1
}
tart() { printf 'VM_STOPPED\\n' >&3; }
wait() { :; }
rm() { printf 'LOGS_REMOVED\\n'; }
TART_PID=123 WS_PID=456 NAME=fixture LOG=fixture.log WSLOG=fixture-ws.log
cleanup() {""" + cleanup + "\ncleanup\n"
        result = subprocess.run(["sh", "-c", harness], capture_output=True,
                                text=True, timeout=5, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines(), ["VM_STOPPED", "LOGS_REMOVED"])


if __name__ == "__main__":
    unittest.main()

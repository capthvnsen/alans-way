#!/usr/bin/env python3
"""Opt-in live Telegram call + simulator WebContent crash recovery gate."""
import argparse
import os
from pathlib import Path
import signal
import subprocess
import time


def terminate_call_content(device):
    rows = []
    for line in subprocess.check_output(["ps", "-axo", "pid,ppid,comm"], text=True).splitlines()[1:]:
        parts = line.strip().split(None, 2)
        if len(parts) == 3:
            rows.append((int(parts[0]), int(parts[1]), parts[2]))
    parents = {parent for _, parent, command in rows
               if f"/Devices/{device}/" in command and command.endswith("/AlanWorkspace.app/AlanWorkspace")}
    targets = [pid for pid, parent, command in rows
               if parent in parents and command.endswith("/com.apple.WebKit.WebContent")]
    if len(parents) != 1 or len(targets) != 1:
        raise RuntimeError("Cannot uniquely identify the selected simulator's call WebContent process; no process was terminated.")
    os.kill(targets[0], signal.SIGKILL)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("device", help="UUID of the opted-in, signed-in simulator")
    args = parser.parse_args()
    chat = os.environ.get("ALAN_CALL_SMOKE_CHAT_ID")
    if not chat:
        parser.error("Set ALAN_CALL_SMOKE_CHAT_ID to the existing bot chat to test.")
    root = Path(__file__).resolve().parents[1]
    log = root / ".build" / f"call-recovery-{time.time_ns()}.log"
    log.parent.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, TEST_RUNNER_ALAN_CALL_SMOKE_CHAT_ID=chat,
               TEST_RUNNER_ALAN_CALL_SMOKE_TERMINATE="1")
    command = ["xcodebuild", "-project", "AlanWorkspace.xcodeproj", "-scheme", "AlanWorkspace",
               "-destination", f"platform=iOS Simulator,id={args.device}",
               "-derivedDataPath", ".build/DerivedData", "-clonedSourcePackagesDirPath", ".build/SourcePackages",
               "-parallel-testing-enabled", "NO", "-collect-test-diagnostics", "never",
               "-only-testing:AlanWorkspaceUITests/WorkspaceLaunchTests/testAuthenticatedCallStaysActiveAndRecoversFromWebContentTermination",
               "CODE_SIGNING_ALLOWED=YES", "CODE_SIGN_IDENTITY=-", "test"]
    with log.open("w") as output:
        process = subprocess.Popen(command, cwd=root, env=env, stdout=output, stderr=subprocess.STDOUT)
        deadline = time.monotonic() + 240
        terminated = False
        try:
            while process.poll() is None:
                if not terminated and "ready for WebContent termination." in log.read_text(errors="replace"):
                    terminate_call_content(args.device)
                    terminated = True
                    print("Terminated only the selected simulator's call WebContent after the stability gate.", flush=True)
                if time.monotonic() > deadline:
                    raise TimeoutError("Call recovery gate exceeded four minutes.")
                time.sleep(0.25)
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
    print(f"{'PASS' if process.returncode == 0 and terminated else 'FAIL'}: live call stability and native crash recovery. Log: {log}")
    return 0 if process.returncode == 0 and terminated else 1


if __name__ == "__main__":
    raise SystemExit(main())

"""Single required check for the tests workflow.

Reads the `needs` context as JSON from $NEEDS (`toJSON(needs)`), exits 1 unless
every job succeeded. A job may be skipped only when `changes` succeeded and said
desktop=false, and only the jobs named in SKIPPABLE. A failed, cancelled or
unexpectedly skipped job fails the gate, so a skip can never hide a failure.
"""
import json
import os
import sys

SKIPPABLE = {"desktop", "desktop-electron", "desktop-windows"}


def problems(needs):
    changes = needs.get("changes", {})
    may_skip = changes.get("result") == "success" and changes.get("outputs", {}).get("desktop") == "false"
    found = []
    for name, job in sorted(needs.items()):
        result = job.get("result")
        if result == "success" or (result == "skipped" and name in SKIPPABLE and may_skip):
            continue
        found.append(f"{name}: {result}")
    return found


if __name__ == "__main__":
    bad = problems(json.loads(os.environ["NEEDS"]))
    for line in bad:
        print(f"::error::{line}")
    sys.exit(1 if bad else 0)

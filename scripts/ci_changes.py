"""Decide which CI job families a pull request can affect.

Reads changed file paths (one per line) on stdin and prints `desktop=true|false`.
`false` only when every path is under ios/: nothing under desktop/ reads ios/
(checked by grep when this was written), while desktop tests do read docs/*.md,
README.md, scripts/ and tests/, so those never skip anything. Empty input, or
any other path, keeps the full set.
"""
import sys


def desktop_affected(paths):
    paths = [p.strip() for p in paths if p.strip()]
    return not paths or any(not p.startswith("ios/") for p in paths)


if __name__ == "__main__":
    print(f"desktop={'true' if desktop_affected(sys.stdin) else 'false'}")

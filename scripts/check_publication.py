"""Check tracked files before publication; findings never echo matched secrets.

This is a conservative repository policy check, not a complete secret detector.
Run after git add and before committing/pushing. CI runs it on a clean checkout.
"""
from __future__ import annotations

import ast
import ipaddress
from pathlib import Path
import re
import stat
import subprocess
import sys

RULES = (
    ("private-key", re.compile(r"-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----")),
    ("github-credential", re.compile(r"(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}")),
    ("personal-home-path", re.compile(
        "/" + r"Users/(?!user/|macuser/|your-name/|you/)[^/\s'\"<>]+/"
        + "|/" + r"home/(?!user/|macuser/|your-name/|you/)[^/\s'\"<>]+/")),
)
IPV4 = re.compile(r"(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.]|/\d)")
TAILNET = ipaddress.ip_network((0x64400000, 10))
EXAMPLE_NETWORKS = tuple(ipaddress.ip_network(value) for value in (
    (0xC0000200, 24), (0xC6336400, 24), (0xCB007100, 24),
))
# Tailnet-range boundary addresses that connect-*.sh document and test_connect_scripts.py
# feeds to the tailnet-host validator. They are range edges, not machines. Written as
# octets so this file does not trip its own check.
def _ips(*addresses):
    return frozenset(".".join(map(str, octets)) for octets in addresses)


_RANGE_EDGES = _ips((100, 64, 0, 0), (100, 127, 255, 255))
ALLOWED_ADDRESSES = {
    "scripts/connect-linux.sh": _RANGE_EDGES,
    "scripts/connect-mac.sh": _RANGE_EDGES,
    "scripts/connect-windows.ps1": _RANGE_EDGES,
    "tests/test_connect_scripts.py": _ips((100, 64, 0, 1), (100, 100, 1, 2), (100, 127, 255, 254)),
    # Parser fixtures for the alansway://setup deep-link validator: boundary
    # and in-range tailnet literals, not real machines.
    "desktop/test/setup-link.test.cjs": _ips((100, 64, 0, 1), (100, 127, 255, 254)),
}
FORBIDDEN_SUFFIXES = {".db", ".sqlite", ".sqlite3", ".pem", ".key", ".patch", ".diff", ".log"}
FORBIDDEN_IMPORTS = {"gateway", "tui_gateway", "hermes_cli", "hermes_state", "run_agent", "model_tools", "tools", "agent"}
BINARY_ASSETS = {"desktop/assets/icon.png": b"\x89PNG\r\n\x1a\n", "desktop/assets/icon.icns": b"icns",
                 "desktop/assets/icon.ico": b"\x00\x00\x01\x00",
                 "desktop/src/newtab-backdrop.png": b"\x89PNG\r\n\x1a\n"}
AVATAR_ASSETS = frozenset(f"desktop/assets/avatars/{name}.png" for name in (
    "apollo", "artemis", "athena", "faun", "hades", "hermes", "medusa",
    "minotaur", "poseidon", "zeus",
))
BINARY_ASSETS.update({name: b"\x89PNG\r\n\x1a\n" for name in AVATAR_ASSETS})
BINARY_LIMITS = {"desktop/src/newtab-backdrop.png": 4194304, "desktop/assets/icon.icns": 2097152}


def valid_binary_asset(path: str, blob: bytes) -> bool:
    signature = BINARY_ASSETS.get(path)
    limit = BINARY_LIMITS.get(path, 2097152 if path in AVATAR_ASSETS else 1048576)
    return bool(signature and blob.startswith(signature) and len(blob) <= limit)


def inspect_text(path: str, text: str) -> list[dict]:
    """Return locations/rule labels only, never matching text or secret values."""
    name = Path(path).name.casefold()
    findings = []
    if (Path(path).suffix.casefold() in FORBIDDEN_SUFFIXES
            or name == ".env" or name.startswith(".env.")
            or name in {"credentials.json", "auth.json", "tokens.json"}):
        findings.append({"file": path, "line": 0, "rule": "runtime-or-private-artifact"})
    for number, line in enumerate(text.splitlines(), 1):
        for label, pattern in RULES:
            if pattern.search(line):
                findings.append({"file": path, "line": number, "rule": label})
        for match in IPV4.finditer(line):
            try:
                address = ipaddress.ip_address(match.group())
            except ValueError:
                continue
            if address.is_loopback or address.is_unspecified or address.is_link_local or any(address in network for network in EXAMPLE_NETWORKS):
                continue
            if match.group() in ALLOWED_ADDRESSES.get(path, ()):
                continue
            if address.is_private or address in TAILNET:
                # Security tests name RFC1918 ranges on purpose. A tailnet
                # address is still a real machine, including inside a test.
                if address not in TAILNET and path.startswith(("desktop/test/", "tests/")):
                    continue
                findings.append({"file": path, "line": number, "rule": "private-device-address"})
    if path.startswith("src/") and path.endswith(".py"):
        try:
            tree = ast.parse(text)
        except SyntaxError:
            findings.append({"file": path, "line": 0, "rule": "python-syntax"})
        else:
            for node in ast.walk(tree):
                modules = []
                if isinstance(node, ast.Import):
                    modules = [alias.name for alias in node.names]
                elif isinstance(node, ast.ImportFrom):
                    modules = [node.module or ""]
                if any(module.split(".")[0] in FORBIDDEN_IMPORTS for module in modules):
                    findings.append({"file": path, "line": getattr(node, "lineno", 0), "rule": "private-hermes-import"})
    return findings


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    result = subprocess.run(["git", "ls-files", "-z"], cwd=root, capture_output=True, check=True)
    paths = [value.decode("utf-8") for value in result.stdout.split(b"\x00") if value]
    if not paths:
        print("Publication check refused: no tracked files.", file=sys.stderr)
        return 1
    findings = []
    for path in paths:
        item = root / path
        mode = item.lstat().st_mode
        if not stat.S_ISREG(mode):
            findings.append({"file": path, "line": 0, "rule": "nonregular-file"})
            continue
        if path in BINARY_ASSETS:
            blob = item.read_bytes()
            if not valid_binary_asset(path, blob):
                findings.append({"file": path, "line": 0, "rule": "invalid-static-asset"})
            continue
        try:
            text = item.read_text(encoding="utf-8")
        except (UnicodeError, OSError):
            findings.append({"file": path, "line": 0, "rule": "unreadable-or-binary"})
            continue
        findings.extend(inspect_text(path, text))
    for finding in findings:
        print(f"{finding['file']}:{finding['line']}: {finding['rule']}", file=sys.stderr)
    if findings:
        print(f"Publication check failed: {len(findings)} finding(s).", file=sys.stderr)
        return 1
    print(f"Publication policy passed for {len(paths)} tracked files. Not a complete secret audit.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

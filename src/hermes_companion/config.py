"""Pure, non-mutating Hermes MCP configuration generation.

The include/resources/prompts keys are documented in the official Hermes MCP
reference. The trust key is also implemented by Hermes' MCP registration policy.
No Hermes runtime imports, config writes, subprocesses, or network discovery.
"""
from __future__ import annotations

import re
import shlex
import unicodedata

MAC_TOOLS = (
    "mac_device_status",
    "mac_workspace_read_file",
    "mac_workspace_list",
)
WINDOWS_TOOLS = (
    "windows_device_status",
    "windows_workspace_read_file",
    "windows_workspace_list",
)
SSH_OPTIONS = (
    "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
    "-o", "ConnectTimeout=5",
)


def validate_host(value: str) -> str:
    """Accept a literal user@hostname/IPv4 or SSH alias, never SSH options."""
    user = r"[A-Za-z_][A-Za-z0-9_.-]*"
    label = r"[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?"
    if not isinstance(value, str) or not re.fullmatch(rf"{user}@{label}(?:\.{label})*", value):
        raise ValueError("--mac-host must be a literal user@host with no options or shell syntax")
    return value


def _has_control(value: str) -> bool:
    return any(unicodedata.category(char).startswith("C") for char in value)


def validate_absolute_path(value: str) -> str:
    """Validate remote POSIX spelling without resolving or normalizing locally."""
    if (not isinstance(value, str) or not value.startswith("/")
            or value.startswith("//") or _has_control(value)
            or any(part in (".", "..") for part in value.split("/"))
            or "${" in value):
        # Hermes expands ${...} throughout args, even inside shell quotes.
        raise ValueError("remote paths must be absolute POSIX paths without traversal, control characters, or interpolation")
    return value


def validate_windows_path(value: str) -> str:
    """Validate remote Windows spelling: drive-lettered, no traversal or device names."""
    normalized = value.rstrip("/\\") if isinstance(value, str) else value
    if (not isinstance(normalized, str) or not re.fullmatch(r"[A-Za-z]:[\\/][^<>\"|?*]*", normalized)
            or _has_control(normalized)
            or any(part in ("", ".", "..") for part in re.split(r"[\\/]", normalized[3:]))
            or "${" in normalized):
        raise ValueError("remote paths must be absolute Windows paths (X:\\...) without traversal, control characters, or interpolation")
    return normalized


def _ps_join(argv: list[str]) -> str:
    """Quote for the remote PowerShell: single-quoted literals, & call operator."""
    return "& " + " ".join("'" + arg.replace("'", "''") + "'" for arg in argv)


def build_mcp_config(host: str, host_python: str, workspace: str, host_os: str = "mac") -> dict:
    """Return a JSON-serializable fragment; never apply it or contact the host."""
    validate_host(host)
    if host_os == "windows":
        validate_windows_path(host_python)
        validate_windows_path(workspace)
        remote_command = _ps_join([
            host_python, "-m", "hermes_companion.windows_server", "--workspace", workspace,
        ])
        tools, key = WINDOWS_TOOLS, "windows_companion"
    elif host_os == "mac":
        validate_absolute_path(host_python)
        validate_absolute_path(workspace)
        remote_command = shlex.join([
            host_python, "-m", "hermes_companion.mac_server", "--workspace", workspace,
        ])
        tools, key = MAC_TOOLS, "mac_companion"
    else:
        raise ValueError('host_os must be "mac" or "windows"')
    return {"mcp_servers": {key: {
        "command": "ssh",
        "connect_timeout": 10,
        "timeout": 20,
        "lazy": True,
        "args": [*SSH_OPTIONS, host, remote_command],
        # Keep the caller's SSH agent usable through Hermes' filtered env without
        # serializing its machine-specific socket path into the generated file.
        "env": {"SSH_AUTH_SOCK": "${SSH_AUTH_SOCK}"},
        "trust": "untrusted",
        "sampling": {"enabled": False},
        "tools": {"include": list(tools), "resources": False, "prompts": False},
    }}}

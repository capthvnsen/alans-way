"""Exercise an installed wheel, not a PYTHONPATH source checkout.

No private SSH destination, provider turn, or existing Hermes session is used.
"""
import asyncio
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import tempfile
from typing import TextIO, cast

import hermes_companion


def invoke(*arguments):
    result = subprocess.run([sys.executable, "-m", "hermes_companion", *arguments],
                            capture_output=True, text=True, timeout=15)
    return result


async def mac_protocol(workspace):
    from mcp import ClientSession, StdioServerParameters
    from mcp.types import TextContent
    from mcp.client.stdio import stdio_client
    params = StdioServerParameters(command=sys.executable,
                                  args=["-m", "hermes_companion.mac_server", "--workspace", str(workspace)])
    with tempfile.TemporaryFile(mode="w+", dir=workspace.parent) as errors:
        async with stdio_client(params, errlog=cast(TextIO, errors)) as (reader, writer):
            async with ClientSession(reader, writer, read_timeout_seconds=10) as session:
                await session.initialize()
                tools = (await session.list_tools()).tools
                assert len(tools) == 3
                assert {tool.name for tool in tools} == {
                    "mac_device_status", "mac_workspace_read_file", "mac_workspace_list"}
                assert all(tool.annotations is not None and tool.annotations.read_only_hint is True for tool in tools)
                status = await session.call_tool("mac_device_status", {})
                assert not status.is_error
                assert isinstance(status.content[0], TextContent)
                assert json.loads(status.content[0].text)["system"] == "Darwin"
                read = await session.call_tool("mac_workspace_read_file", {"path": "proof.txt"})
                assert not read.is_error
                assert isinstance(read.content[0], TextContent)
                assert json.loads(read.content[0].text)["content"] == "Synthetic installed-wheel proof\n"
                denied = await session.call_tool("mac_workspace_read_file", {"path": "../outside.txt"})
                assert denied.is_error
                unsupported = await session.call_tool("mac_shell", {"command": "echo forbidden"})
                assert unsupported.is_error


def main():
    root = Path(__file__).resolve().parents[1]
    module = Path(hermes_companion.__file__).resolve()
    assert not module.is_relative_to(root / "src"), "Smoke check must use the installed wheel"
    assert importlib.metadata.version("hermes-companion") == "0.1.0a1"
    version = invoke("--version")
    assert version.returncode == 0 and version.stdout.strip() == "hermes-companion 0.1.0a1"
    config = invoke("mcp-config", "--mac-host", "macuser@mac-private-host",
                    "--mac-python", "/opt/hermes-companion/.venv/bin/python",
                    "--workspace", "/opt/hermes-companion/approved-workspace")
    assert config.returncode == 0
    server = json.loads(config.stdout)["mcp_servers"]["mac_companion"]
    assert server["command"] == "ssh" and server["trust"] == "untrusted"
    doctor = invoke("doctor")
    report = json.loads(doctor.stdout)
    assert report["distribution_installed"] and report["sdk_available"] and report["ssh_available"]
    assert report["connection_verified"] is False and report["full_integration_ready"] is False
    # CI intentionally does not install native Hermes. Doctor reports that as 1.
    expected_exit = 0 if report["hermes_available"] else 1
    assert doctor.returncode == expected_exit
    with tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR")) as temp:
        workspace = Path(temp) / "workspace"
        workspace.mkdir()
        (workspace / "proof.txt").write_text("Synthetic installed-wheel proof\n", encoding="utf-8")
        if platform.system() == "Darwin":
            asyncio.run(mac_protocol(workspace))
            print("Installed wheel: CLI, config, diagnostics and real Mac stdio protocol passed.")
        else:
            denied = invoke("serve-mac", "--workspace", str(workspace))
            assert denied.returncode != 0 and not denied.stdout
            assert "Darwin" in denied.stderr and "Traceback" not in denied.stderr
            print("Installed wheel: CLI, config, diagnostics and real non-Mac startup denial passed.")


if __name__ == "__main__":
    main()

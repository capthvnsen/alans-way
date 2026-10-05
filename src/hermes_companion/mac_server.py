"""Narrow read-only Mac workspace executor; optional MCP over stdio."""


import argparse
import importlib.metadata
import os
import platform
import stat
from contextlib import contextmanager
from pathlib import Path

from . import __version__

MAX_FILE_BYTES = 65536
MAX_PATH_CHARS = 1024
SENSITIVE_NAMES = (
    'auth', 'secret', 'password', 'passwd', 'credential', 'token', 'private',
    'otp', 'cookie', 'keychain', 'api_key', 'api-key', 'apikey',
)
SENSITIVE_SUFFIXES = ('.pem', '.key', '.p12', '.pfx', '.kdbx')


class MacExecutor:
    """Standard-library workspace policy, independent of the optional SDK."""

    def __init__(self, workspace):
        self.require_mac()  # Refuse other hosts before probing the supplied path.
        try:
            root = Path(workspace)
            if not root.is_absolute():
                raise ValueError('absolute directory required')
            info = root.lstat()
            if not stat.S_ISDIR(info.st_mode):
                raise ValueError('real directory required')
            self.workspace = root.resolve(strict=True)
            self.workspace_identity = (info.st_dev, info.st_ino)
        except (OSError, TypeError, ValueError):
            raise PermissionError(
                'Explicit existing absolute non-symlink workspace directory required'
            ) from None

    @staticmethod
    def require_mac():
        if platform.system() != 'Darwin':
            raise PermissionError('Darwin Mac required; no execution-host fallback')

    @staticmethod
    def path_parts(path, allow_root=False):
        """Accept only visible, non-sensitive slash-separated relative names."""
        if allow_root and path == '.':
            return []
        if (not isinstance(path, str) or not path or len(path) > MAX_PATH_CHARS
                or path.startswith('/') or '\\' in path or ':' in path
                or any(ord(char) < 32 or ord(char) == 127 for char in path)):
            raise PermissionError('Unapproved workspace path')
        parts = path.split('/')
        try:
            for part in parts:
                lower = part.casefold()
                if (not part or part.startswith('.') or len(part.encode('utf-8')) > 255
                        or any(word in lower for word in SENSITIVE_NAMES)
                        or lower.endswith(SENSITIVE_SUFFIXES)):
                    raise PermissionError('Unapproved workspace path')
        except UnicodeError:
            raise PermissionError('Unapproved workspace path') from None
        return parts

    @contextmanager
    def open_path(self, parts, directory=False):
        """Traverse relative to descriptors; never follow a child symlink."""
        descriptors = []
        flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
        try:
            descriptors.append(os.open(self.workspace, flags | os.O_DIRECTORY))
            info = os.fstat(descriptors[0])
            if (info.st_dev, info.st_ino) != self.workspace_identity:
                raise PermissionError('Approved workspace identity changed; restart required')
            for index, part in enumerate(parts):
                is_directory = directory or index < len(parts) - 1
                descriptors.append(os.open(
                    part, flags | (os.O_DIRECTORY if is_directory else 0),
                    dir_fd=descriptors[-1],
                ))
            yield descriptors[-1]
        except OSError:
            raise PermissionError('Workspace object unavailable or denied') from None
        finally:
            for descriptor in reversed(descriptors):
                os.close(descriptor)

    def read_file(self, path):
        self.require_mac()
        parts = self.path_parts(path)
        with self.open_path(parts) as descriptor:
            info = os.fstat(descriptor)
            if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                    or info.st_size > MAX_FILE_BYTES):
                raise PermissionError('Only single-link regular bounded UTF-8 text is allowed')
            with os.fdopen(os.dup(descriptor), 'rb') as stream:
                data = stream.read(MAX_FILE_BYTES + 1)
            after = os.fstat(descriptor)
            observed_fields = ('st_dev', 'st_ino', 'st_mode', 'st_nlink', 'st_size',
                               'st_mtime_ns', 'st_ctime_ns')
            if any(getattr(info, field) != getattr(after, field) for field in observed_fields):
                raise PermissionError('Workspace file changed during read; retry required')
            if (len(data) > MAX_FILE_BYTES
                    or any((byte < 32 and byte not in (9, 10, 13)) or byte == 127 for byte in data)):
                raise PermissionError('Only bounded UTF-8 text is allowed')
            try:
                content = data.decode('utf-8', errors='strict')
            except UnicodeError:
                raise PermissionError('Only bounded UTF-8 text is allowed') from None
        return {'execution_host': 'mac', 'path': path, 'content': content}

    def list_directory(self, path='.'):
        self.require_mac()
        parts = self.path_parts(path, allow_root=True)
        entries = []
        truncated = False
        with self.open_path(parts, directory=True) as descriptor:
            with os.scandir(descriptor) as scan:
                for index, entry in enumerate(scan):
                    # One lookahead is fetched but not validated, stat'ed or read.
                    if index >= 256 or len(entries) >= 100:
                        truncated = True
                        break
                    relative = '/'.join(parts + [entry.name])
                    try:
                        self.path_parts(relative)
                        if entry.is_dir(follow_symlinks=False):
                            kind = 'directory'
                        elif entry.is_file(follow_symlinks=False):
                            self.read_file(relative)  # Eligibility only; discard content.
                            kind = 'file'
                        else:
                            continue
                    except (OSError, UnicodeError):
                        continue
                    entries.append({'name': entry.name, 'type': kind})
        return {'execution_host': 'mac', 'path': path,
                'entries': sorted(entries, key=lambda item: item['name']),
                'truncated': truncated}

    def device_status(self):
        self.require_mac()
        return {'execution_host': 'mac', 'system': platform.system(),
                'release': platform.release(), 'machine': platform.machine()}


def build_server(workspace):
    """Build exactly three read-only tools; import the optional SDK lazily."""
    MacExecutor.require_mac()  # Before SDK import or workspace inspection.
    try:
        version = importlib.metadata.version('mcp')
    except importlib.metadata.PackageNotFoundError:
        raise RuntimeError('Mac MCP requires the optional hermes-companion[mcp] extra') from None
    if version != '2.0.0':
        raise RuntimeError('Mac MCP requires exactly mcp==2.0.0')
    try:
        from mcp.server import MCPServer
        from mcp.types import ToolAnnotations
    except ImportError:
        raise RuntimeError('Mac MCP requires the optional hermes-companion[mcp] extra') from None

    executor = MacExecutor(workspace)
    server = MCPServer('hermes-companion-mac', version=__version__, log_level='ERROR')
    annotations = ToolAnnotations(read_only_hint=True, destructive_hint=False,
                                  idempotent_hint=True, open_world_hint=False)

    @server.tool(name='mac_device_status', annotations=annotations)
    def mac_device_status() -> dict:
        """Read minimal Mac OS metadata, without an execution-host fallback."""
        return executor.device_status()

    @server.tool(name='mac_workspace_read_file', annotations=annotations)
    def mac_workspace_read_file(path: str) -> dict:
        """Read bounded UTF-8 text relative to the explicitly approved workspace."""
        return executor.read_file(path)

    @server.tool(name='mac_workspace_list', annotations=annotations)
    def mac_workspace_list(path: str = '.') -> dict:
        """List eligible text files and real directories within the workspace."""
        return executor.list_directory(path)

    return server


def main(argv=None):
    """Serve MCP over stdio only; startup failures produce no traceback."""
    parser = argparse.ArgumentParser(prog='hermes-companion serve-mac', description=__doc__)
    parser.add_argument('--workspace', required=True, help='Explicitly approved absolute local workspace')
    args = parser.parse_args(argv)
    try:
        server = build_server(args.workspace)
    except (PermissionError, RuntimeError) as error:
        parser.error(str(error))
    server.run(transport='stdio')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

"""Narrow read-only Windows workspace executor; optional MCP over stdio.

Windows has no dirfd/O_NOFOLLOW, so the Mac executor's descriptor walk is
replaced by one CreateFileW per path: FILE_FLAG_OPEN_REPARSE_POINT rejects a
reparse leaf atomically, and GetFinalPathNameByHandle must reproduce the
approved path exactly — any intermediate junction, 8.3 alias, device name or
canonicalization trick makes the final name diverge and the open is denied.
Shared policy constants and path-parts validation stay in mac_server so the
Windows contract cannot drift from the Mac one.
"""

import argparse
import ctypes
from ctypes import wintypes
import importlib.metadata
import os
import platform
from contextlib import contextmanager
from pathlib import Path

from . import __version__
from .mac_server import MAX_FILE_BYTES, MacExecutor

GENERIC_READ = 0x80000000
FILE_READ_ATTRIBUTES = 0x80
SHARE_ALL = 0x1 | 0x2 | 0x4  # READ | WRITE | DELETE — never lock a user's file.
OPEN_EXISTING = 3
BACKUP_AND_NO_REPARSE = 0x02000000 | 0x00200000  # BACKUP_SEMANTICS | OPEN_REPARSE_POINT
ATTRIBUTE_DIRECTORY = 0x10
ATTRIBUTE_DENIED_LEAF = 0x400 | 0x2 | 0x4  # REPARSE_POINT | HIDDEN | SYSTEM
FILE_TYPE_DISK = 1


class FILETIME(ctypes.Structure):
    _fields_ = [('dwLowDateTime', wintypes.DWORD), ('dwHighDateTime', wintypes.DWORD)]


class BY_HANDLE_FILE_INFORMATION(ctypes.Structure):
    _fields_ = [
        ('dwFileAttributes', wintypes.DWORD),
        ('ftCreationTime', FILETIME), ('ftLastAccessTime', FILETIME), ('ftLastWriteTime', FILETIME),
        ('dwVolumeSerialNumber', wintypes.DWORD), ('nFileSizeHigh', wintypes.DWORD),
        ('nFileSizeLow', wintypes.DWORD), ('nNumberOfLinks', wintypes.DWORD),
        ('nFileIndexHigh', wintypes.DWORD), ('nFileIndexLow', wintypes.DWORD),
    ]


def _bind():
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                   ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p]
    kernel.CreateFileW.restype = wintypes.HANDLE
    kernel.GetFileInformationByHandle.argtypes = [wintypes.HANDLE, ctypes.POINTER(BY_HANDLE_FILE_INFORMATION)]
    kernel.GetFileInformationByHandle.restype = wintypes.BOOL
    kernel.GetFinalPathNameByHandleW.argtypes = [wintypes.HANDLE, wintypes.LPWSTR, wintypes.DWORD, wintypes.DWORD]
    kernel.GetFinalPathNameByHandleW.restype = wintypes.DWORD
    kernel.GetFileType.argtypes = [wintypes.HANDLE]
    kernel.GetFileType.restype = wintypes.DWORD
    kernel.ReadFile.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD,
                                ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p]
    kernel.ReadFile.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.restype = wintypes.BOOL
    return kernel


class WindowsExecutor:
    """Standard-library workspace policy, independent of the optional SDK."""

    def __init__(self, workspace):
        self.require_windows()  # Refuse other hosts before probing the supplied path.
        self._kernel = _bind()
        try:
            root = Path(workspace)
            if not root.is_absolute():
                raise PermissionError
            # The supplied root may be non-canonical (8.3 names, case) — the
            # opened handle's final name is the truth we pin; the name check
            # only applies to workspace-relative paths opened afterwards.
            with self._open(str(root), directory=True, check_name=False) as (handle, info):
                self.workspace = self._final_name(handle)
                self.workspace_identity = self._identity(info)
        except (PermissionError, TypeError):
            raise PermissionError(
                'Explicit existing absolute non-symlink workspace directory required'
            ) from None

    @staticmethod
    def require_windows():
        if platform.system() != 'Windows':
            raise PermissionError('Windows required; no execution-host fallback')

    path_parts = staticmethod(MacExecutor.path_parts)  # Shared validation; see module docstring.

    @staticmethod
    def _identity(info):
        return (info.dwVolumeSerialNumber,
                (info.nFileIndexHigh << 32) | info.nFileIndexLow)

    @staticmethod
    def _stamp(info):
        ft = info.ftLastWriteTime
        return ((info.dwVolumeSerialNumber,), (info.nFileIndexHigh << 32) | info.nFileIndexLow,
                info.nNumberOfLinks, info.nFileSizeLow | (info.nFileSizeHigh << 32),
                (ft.dwHighDateTime << 32) | ft.dwLowDateTime)

    def _final_name(self, handle):
        buffer = ctypes.create_unicode_buffer(32768)
        length = self._kernel.GetFinalPathNameByHandleW(handle, buffer, 32768, 0)
        if not 0 < length < 32768:
            raise PermissionError('Workspace object unavailable or denied')
        name = buffer[:length]
        if name.startswith('\\\\?\\UNC\\'):
            return '\\\\' + name[8:]
        return name[4:] if name.startswith('\\\\?\\') else name

    @contextmanager
    def _open(self, target, directory=False, check_name=True):
        """Open one approved object; never follow a reparse point at any depth."""
        access = FILE_READ_ATTRIBUTES if directory else GENERIC_READ
        handle = self._kernel.CreateFileW(target, access, SHARE_ALL, None,
                                          OPEN_EXISTING, BACKUP_AND_NO_REPARSE, None)
        if not handle or handle == wintypes.HANDLE(-1).value:
            raise PermissionError('Workspace object unavailable or denied')
        try:
            info = BY_HANDLE_FILE_INFORMATION()
            if not self._kernel.GetFileInformationByHandle(handle, info):
                raise PermissionError('Workspace object unavailable or denied')
            is_dir = bool(info.dwFileAttributes & ATTRIBUTE_DIRECTORY)
            if is_dir != directory or info.dwFileAttributes & ATTRIBUTE_DENIED_LEAF:
                raise PermissionError('Workspace object unavailable or denied')
            if (check_name
                    and os.path.normcase(self._final_name(handle)) != os.path.normcase(target)):
                raise PermissionError('Unapproved workspace path')
            yield handle, info
        finally:
            self._kernel.CloseHandle(handle)

    def _approved(self, parts, directory=False):
        # Re-open the approved root every operation: a renamed/recreated
        # workspace resolves to a new volume+index and must deny, matching the
        # Mac executor's (st_dev, st_ino) re-check in open_path.
        with self._open(self.workspace, directory=True) as (handle, info):
            if self._identity(info) != self.workspace_identity:
                raise PermissionError('Approved workspace identity changed; restart required')
        target = os.path.join(self.workspace, *parts) if parts else self.workspace
        return self._open(target, directory)

    def read_file(self, path):
        self.require_windows()
        parts = self.path_parts(path)
        with self._approved(parts) as (handle, info):
            if (self._kernel.GetFileType(handle) != FILE_TYPE_DISK or info.nNumberOfLinks != 1
                    or info.nFileSizeHigh > 0 or info.nFileSizeLow > MAX_FILE_BYTES):
                raise PermissionError('Only single-link regular bounded UTF-8 text is allowed')
            chunks, remaining = [], MAX_FILE_BYTES + 1
            while remaining > 0:
                buffer = ctypes.create_string_buffer(remaining)
                count = wintypes.DWORD(0)
                if not self._kernel.ReadFile(handle, buffer, remaining, ctypes.byref(count), None):
                    raise PermissionError('Workspace object unavailable or denied')
                if count.value == 0:
                    break
                chunks.append(buffer.raw[:count.value])
                remaining -= count.value
            data = b''.join(chunks)
            after = BY_HANDLE_FILE_INFORMATION()
            if (not self._kernel.GetFileInformationByHandle(handle, after)
                    or self._stamp(info) != self._stamp(after)):
                raise PermissionError('Workspace file changed during read; retry required')
            if (len(data) > MAX_FILE_BYTES
                    or any((byte < 32 and byte not in (9, 10, 13)) or byte == 127 for byte in data)):
                raise PermissionError('Only bounded UTF-8 text is allowed')
            try:
                content = data.decode('utf-8', errors='strict')
            except UnicodeError:
                raise PermissionError('Only bounded UTF-8 text is allowed') from None
        return {'execution_host': 'windows', 'path': path, 'content': content}

    def list_directory(self, path='.'):
        self.require_windows()
        parts = self.path_parts(path, allow_root=True)
        entries, truncated = [], False
        with self._approved(parts, directory=True) as (handle, info):
            directory_path = os.path.join(self.workspace, *parts) if parts else self.workspace
            try:
                children = os.scandir(directory_path)
            except OSError:
                raise PermissionError('Workspace object unavailable or denied') from None
            with children as scan:
                for index, entry in enumerate(scan):
                    # One lookahead is fetched but not validated, stat'ed or read.
                    if index >= 256 or len(entries) >= 100:
                        truncated = True
                        break
                    relative = '/'.join(parts + [entry.name])
                    try:
                        self.path_parts(relative)
                        with self._approved(parts + [entry.name], directory=True):
                            kind = 'directory'
                    except PermissionError:
                        try:
                            self.read_file(relative)  # Eligibility only; discard content.
                            kind = 'file'
                        except PermissionError:
                            continue
                    except UnicodeError:
                        continue
                    entries.append({'name': entry.name, 'type': kind})
            if os.path.normcase(self._final_name(handle)) != os.path.normcase(directory_path):
                raise PermissionError('Approved workspace identity changed; restart required')
        return {'execution_host': 'windows', 'path': path,
                'entries': sorted(entries, key=lambda item: item['name']),
                'truncated': truncated}

    def device_status(self):
        self.require_windows()
        return {'execution_host': 'windows', 'system': platform.system(),
                'release': platform.release(), 'machine': platform.machine()}


def build_server(workspace):
    """Build exactly three read-only tools; import the optional SDK lazily."""
    WindowsExecutor.require_windows()  # Before SDK import or workspace inspection.
    try:
        version = importlib.metadata.version('mcp')
    except importlib.metadata.PackageNotFoundError:
        raise RuntimeError('Windows MCP requires the optional hermes-companion[mcp] extra') from None
    if version != '2.0.0':
        raise RuntimeError('Windows MCP requires exactly mcp==2.0.0')
    try:
        from mcp.server import MCPServer
        from mcp.types import ToolAnnotations
    except ImportError:
        raise RuntimeError('Windows MCP requires the optional hermes-companion[mcp] extra') from None

    executor = WindowsExecutor(workspace)
    server = MCPServer('hermes-companion-windows', version=__version__, log_level='ERROR')
    annotations = ToolAnnotations(read_only_hint=True, destructive_hint=False,
                                  idempotent_hint=True, open_world_hint=False)

    @server.tool(name='windows_device_status', annotations=annotations)
    def windows_device_status() -> dict:
        """Read minimal Windows OS metadata, without an execution-host fallback."""
        return executor.device_status()

    @server.tool(name='windows_workspace_read_file', annotations=annotations)
    def windows_workspace_read_file(path: str) -> dict:
        """Read bounded UTF-8 text relative to the explicitly approved workspace."""
        return executor.read_file(path)

    @server.tool(name='windows_workspace_list', annotations=annotations)
    def windows_workspace_list(path: str = '.') -> dict:
        """List eligible text files and real directories within the workspace."""
        return executor.list_directory(path)

    return server


def main(argv=None):
    """Serve MCP over stdio only; startup failures produce no traceback."""
    parser = argparse.ArgumentParser(prog='hermes-companion serve-windows', description=__doc__)
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

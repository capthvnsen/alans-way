"""Standard-library unit tests, using synthetic TMPDIR workspaces only."""
import contextlib
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from hermes_companion import windows_server


class StartupTests(unittest.TestCase):
    def test_non_windows_constructor_denies_before_filesystem_access(self):
        with patch.object(windows_server.platform, 'system', return_value='Darwin'), \
                patch.object(windows_server, '_bind', side_effect=AssertionError('must not bind')), \
                patch.object(Path, 'exists', side_effect=AssertionError('must not probe')):
            with self.assertRaisesRegex(PermissionError, 'Windows') as denied:
                windows_server.WindowsExecutor('C:\\synthetic-unopened-workspace')
            self.assertNotIn('synthetic', str(denied.exception))

    def test_path_policy_matches_the_mac_executor_exactly(self):
        denied = [None, 3, '', '.', '/outside.txt', '../outside.txt', 'safe/../note.txt',
                  'safe//note.txt', 'safe/./note.txt', '.env', '.hidden', 'auth.json',
                  'Secrets.txt', 'password.txt', 'passwd.txt', 'access_token.txt',
                  'private.pem', 'credentials.txt', 'otp.txt', 'cookies.txt',
                  'keychain.txt', 'api_key.txt', 'api-key.txt', 'apikey.txt',
                  'cert.pem', 'cert.key', 'cert.p12', 'cert.pfx', 'cert.kdbx',
                  'safe/.env', 'nul\x00.txt', 'line\n.txt', 'x' * 1025,
                  'é' * 128, 'C:\\outside.txt', 'disk:note.txt']
        for path in denied:
            with self.subTest(path=path):
                with self.assertRaises(PermissionError):
                    windows_server.WindowsExecutor.path_parts(path)
        for path in ['note.txt', 'notes/inner.txt', 'report 2024.md', 'café.txt']:
            with self.subTest(path=path):
                self.assertTrue(windows_server.WindowsExecutor.path_parts(path))

    def test_list_root_dot_is_allowed_but_traversal_is_not(self):
        self.assertEqual(windows_server.WindowsExecutor.path_parts('.', allow_root=True), [])
        for path in ['..', '../x', 'a/../b', 'a/./b']:
            with self.subTest(path=path):
                with self.assertRaises(PermissionError):
                    windows_server.WindowsExecutor.path_parts(path, allow_root=True)


@unittest.skipUnless(sys.platform == 'win32', 'real executor success requires Windows')
class WorkspaceReadTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.workspace = Path(self.temp.name) / 'workspace'
        self.workspace.mkdir()
        self.executor = windows_server.WindowsExecutor(self.workspace)

    def test_workspace_requires_absolute_existing_non_reparse_directory(self):
        root = Path(self.temp.name)
        (root / 'file.txt').write_text('synthetic', encoding='utf-8')
        for value in [None, '', 'relative', str(root / 'missing'), str(root / 'file.txt')]:
            with self.subTest(workspace=value):
                with self.assertRaises(PermissionError):
                    windows_server.WindowsExecutor(value)

    def test_read_preserves_bounded_utf8_and_newlines(self):
        (self.workspace / 'notes').mkdir()
        text = 'Synthetic café ☃\r\n'
        (self.workspace / 'notes' / 'sample.txt').write_bytes(text.encode('utf-8'))
        self.assertEqual(self.executor.read_file('notes/sample.txt'),
                         {'execution_host': 'windows', 'path': 'notes/sample.txt', 'content': text})
        (self.workspace / 'empty.txt').touch()
        self.assertEqual(self.executor.read_file('empty.txt')['content'], '')

    def test_read_rejects_links_devices_oversize_and_binary(self):
        outside = Path(self.temp.name) / 'outside'
        outside.mkdir()
        (outside / 'sample.txt').write_text('SYNTHETIC_OUTSIDE', encoding='utf-8')
        (self.workspace / '.env').write_text('SYNTHETIC_DENIED', encoding='utf-8')
        try:
            os.symlink(outside / 'sample.txt', self.workspace / 'escape.txt')
            os.symlink(outside, self.workspace / 'escape_dir', target_is_directory=True)
            os.link(outside / 'sample.txt', self.workspace / 'linked.txt')
        except OSError:
            self.skipTest('link creation needs admin or developer mode')
        for name, content in [('large.txt', b'x' * 65537), ('invalid.txt', b'\xff\xfe'),
                              ('nul.txt', b'a\x00b'), ('control.txt', b'a\x01b')]:
            (self.workspace / name).write_bytes(content)
        for path in ['escape.txt', 'escape_dir/sample.txt', 'escape_dir', 'linked.txt',
                     'large.txt', 'invalid.txt', 'nul.txt', 'control.txt', 'missing.txt',
                     '.env', 'notes/../.env']:
            with self.subTest(path=path):
                with self.assertRaises(PermissionError) as denied_error:
                    self.executor.read_file(path)
                message = str(denied_error.exception)
                self.assertNotIn('SYNTHETIC', message)

    def test_workspace_identity_replacement_denies_reads(self):
        (self.workspace / 'note.txt').write_text('original synthetic', encoding='utf-8')
        self.assertEqual(self.executor.read_file('note.txt')['content'], 'original synthetic')
        self.workspace.rename(Path(self.temp.name) / 'old_workspace')
        self.workspace.mkdir()
        (self.workspace / 'note.txt').write_text('replacement synthetic', encoding='utf-8')
        with self.assertRaises(PermissionError):
            self.executor.read_file('note.txt')

    def test_listing_filters_and_lists_nested_directories(self):
        (self.workspace / 'notes').mkdir()
        (self.workspace / 'notes' / 'inner.txt').write_text('synthetic', encoding='utf-8')
        (self.workspace / 'sample.txt').write_text('synthetic', encoding='utf-8')
        for name, content in [('.env', b'synthetic denied'), ('auth.json', b'denied'),
                              ('bad.bin', b'\xff'), ('large.txt', b'x' * 65537)]:
            (self.workspace / name).write_bytes(content)
        self.assertEqual(self.executor.list_directory(),
                         {'execution_host': 'windows', 'path': '.', 'truncated': False,
                          'entries': [{'name': 'notes', 'type': 'directory'},
                                      {'name': 'sample.txt', 'type': 'file'}]})
        self.assertEqual(self.executor.list_directory('notes')['entries'],
                         [{'name': 'inner.txt', 'type': 'file'}])
        for path in ['../outside', '/outside', '.env', 'sample.txt', None]:
            with self.subTest(path=path), self.assertRaises(PermissionError):
                self.executor.list_directory(path)

    def test_device_status_is_minimal_os_metadata(self):
        status = self.executor.device_status()
        self.assertEqual(status['execution_host'], 'windows')
        self.assertEqual(status['system'], 'Windows')

    def test_all_operations_deny_non_windows_before_access(self):
        with patch.object(windows_server.platform, 'system', return_value='Darwin'), \
                patch.object(self.executor, '_open', side_effect=AssertionError('must not open')):
            for operation in [self.executor.device_status, self.executor.list_directory,
                              lambda: self.executor.read_file('sample.txt')]:
                with self.subTest(operation=operation), self.assertRaisesRegex(PermissionError, 'Windows'):
                    operation()


class ServerStartupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR'))
        self.addCleanup(self.temp.cleanup)
        self.workspace = Path(self.temp.name)

    def test_build_server_denies_non_windows_before_sdk_or_path_probe(self):
        with patch.object(windows_server.platform, 'system', return_value='Darwin'), \
                patch('importlib.metadata.version', side_effect=AssertionError('must not inspect SDK')):
            with self.assertRaisesRegex(PermissionError, 'Windows'):
                windows_server.build_server(self.workspace)

    def test_unverified_sdk_version_is_denied(self):
        with patch.object(windows_server.platform, 'system', return_value='Windows'), \
                patch('importlib.metadata.version', return_value='999.0.0'):
            with self.assertRaisesRegex(RuntimeError, 'mcp==2.0.0'):
                windows_server.build_server(self.workspace)

    def test_main_accepts_argv_and_starts_stdio_only(self):
        with patch.object(windows_server, 'build_server') as build:
            self.assertEqual(windows_server.main(['--workspace', str(self.workspace)]), 0)
        build.assert_called_once_with(str(self.workspace))
        build.return_value.run.assert_called_once_with(transport='stdio')

    def test_main_platform_denial_is_sanitized_without_traceback(self):
        output = io.StringIO()
        errors = io.StringIO()
        with patch.object(windows_server.platform, 'system', return_value='Darwin'), \
                contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            with self.assertRaises(SystemExit) as exit_error:
                windows_server.main(['--workspace', 'C:\\workspace'])
        self.assertEqual(exit_error.exception.code, 2)
        self.assertEqual(output.getvalue(), '')
        self.assertIn('Windows', errors.getvalue())
        self.assertNotIn('Traceback', errors.getvalue())


class ConfigTests(unittest.TestCase):
    def test_windows_config_targets_windows_server_with_powershell_quoting(self):
        from hermes_companion.config import WINDOWS_TOOLS, build_mcp_config
        server = build_mcp_config(
            'operator@private-pc', 'C:\\opt\\companion\\python.exe',
            'C:\\work\\approved dir', host_os='windows')['mcp_servers']['windows_companion']
        self.assertEqual(server['tools']['include'], list(WINDOWS_TOOLS))
        command = server['args'][-1]
        self.assertTrue(command.startswith("& 'C:\\opt\\companion\\python.exe'"))
        self.assertIn('hermes_companion.windows_server', command)
        self.assertIn("'C:\\work\\approved dir'", command)

    def test_windows_config_rejects_posix_and_traversal_paths(self):
        from hermes_companion.config import build_mcp_config
        for python in ['/opt/python', 'C:\\\\server\\python', '${x}', 'python']:
            with self.subTest(python=python):
                with self.assertRaises(ValueError):
                    build_mcp_config('user@private-pc', python, 'C:\\ws', host_os='windows')
        for workspace in ['C:\\ws\\..\\x', 'C:/ok/../x', '\\\\share\\ws', '/srv/ws', 'C:${x}\\ws']:
            with self.subTest(workspace=workspace):
                with self.assertRaises(ValueError):
                    build_mcp_config('user@private-pc', 'C:\\python\\python.exe', workspace, host_os='windows')

    def test_unknown_host_os_is_rejected(self):
        from hermes_companion.config import build_mcp_config
        with self.assertRaises(ValueError):
            build_mcp_config('user@host', '/opt/python', '/srv/ws', host_os='linux')

    def test_mac_config_is_unchanged(self):
        from hermes_companion.config import MAC_TOOLS, build_mcp_config
        server = build_mcp_config(
            'operator@private-mac', '/opt/companion/python', '/srv/approved',
            host_os='mac')['mcp_servers']['mac_companion']
        self.assertEqual(server['tools']['include'], list(MAC_TOOLS))
        self.assertIn('hermes_companion.mac_server', server['args'][-1])


class ImportTests(unittest.TestCase):
    def test_executor_import_does_not_require_optional_sdk_or_windows(self):
        source = str(Path(__file__).resolve().parents[1] / 'src')
        result = subprocess.run(
            [sys.executable, '-S', '-c',
             'import sys; from hermes_companion.windows_server import WindowsExecutor; '
             'assert callable(WindowsExecutor); assert "mcp" not in sys.modules'],
            env={**os.environ, 'PYTHONPATH': source, 'PYTHONDONTWRITEBYTECODE': '1'},
            capture_output=True, text=True, timeout=10,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, '')


if __name__ == '__main__':
    unittest.main()

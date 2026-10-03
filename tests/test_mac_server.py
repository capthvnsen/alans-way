"""Standard-library unit tests, using synthetic TMPDIR workspaces only."""
import contextlib
import io
import os
from pathlib import Path
import subprocess
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch

from hermes_companion import mac_server


class StartupTests(unittest.TestCase):
    def test_non_mac_constructor_denies_before_filesystem_access(self):
        with patch.object(mac_server.platform, 'system', return_value='Linux'), \
                patch.object(Path, 'lstat', side_effect=AssertionError('must not probe')):
            with self.assertRaisesRegex(PermissionError, 'Darwin') as denied:
                mac_server.MacExecutor('/synthetic-unopened-workspace')
            self.assertNotIn('/synthetic', str(denied.exception))

    def test_workspace_requires_absolute_existing_non_symlink_directory(self):
        with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as temporary:
            root = Path(temporary)
            workspace = root / 'workspace'
            workspace.mkdir()
            (root / 'file.txt').write_text('synthetic', encoding='utf-8')
            (root / 'alias').symlink_to(workspace, target_is_directory=True)
            with patch('platform.system', return_value='Darwin'):
                for value in [None, '', 'relative', root / 'missing', root / 'file.txt', root / 'alias']:
                    with self.subTest(workspace=value):
                        try:
                            mac_server.MacExecutor(value)
                        except Exception as error:
                            self.assertIsInstance(error, PermissionError)
                            self.assertNotIn(str(root), str(error))
                        else:
                            self.fail('Invalid workspace was accepted')
                executor = mac_server.MacExecutor(workspace)
                self.assertEqual(executor.workspace, workspace.resolve())


class WorkspaceReadTests(unittest.TestCase):
    """Policy tests emulate Darwin only for synthetic files, not MCP success."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR'))
        self.addCleanup(self.temp.cleanup)
        self.workspace = Path(self.temp.name) / 'workspace'
        self.workspace.mkdir()
        self.mac = patch.object(mac_server.platform, 'system', return_value='Darwin')
        self.mac.start()
        self.addCleanup(self.mac.stop)
        self.executor = mac_server.MacExecutor(self.workspace)

    def test_read_preserves_bounded_utf8_and_newlines(self):
        (self.workspace / 'notes').mkdir()
        text = 'Synthetic café ☃\r\n'
        (self.workspace / 'notes' / 'sample.txt').write_bytes(text.encode('utf-8'))
        self.assertEqual(self.executor.read_file('notes/sample.txt'),
                         {'execution_host': 'mac', 'path': 'notes/sample.txt', 'content': text})
        (self.workspace / 'limit.txt').write_bytes(('é' * 32768).encode('utf-8'))
        self.assertEqual(self.executor.read_file('limit.txt')['content'], 'é' * 32768)
        (self.workspace / 'empty.txt').touch()
        self.assertEqual(self.executor.read_file('empty.txt')['content'], '')

    def test_read_rejects_unapproved_components_before_open(self):
        denied = [None, 3, '', '.', '/outside.txt', '../outside.txt', 'safe/../note.txt',
                  'safe//note.txt', 'safe/./note.txt', '.env', '.hidden', 'auth.json',
                  'Secrets.txt', 'password.txt', 'passwd.txt', 'access_token.txt',
                  'private.pem', 'credentials.txt', 'otp.txt', 'cookies.txt',
                  'keychain.txt', 'api_key.txt', 'api-key.txt', 'apikey.txt',
                  'cert.pem', 'cert.key', 'cert.p12', 'cert.pfx', 'cert.kdbx',
                  'safe/.env', 'nul\x00.txt', 'line\n.txt', 'x' * 1025,
                  'é' * 128, '\ud800.txt', 'C:\\outside.txt', 'disk:note.txt']
        with patch.object(mac_server.os, 'open',
                          side_effect=AssertionError('must validate before opening')):
            for path in denied:
                with self.subTest(path=path):
                    with self.assertRaises(PermissionError) as denied_error:
                        self.executor.read_file(path)
                    self.assertNotIn(str(self.workspace), str(denied_error.exception))

    def test_read_rejects_symlinks_hardlinks_nonregular_and_binary_files(self):
        outside = Path(self.temp.name) / 'outside'
        outside.mkdir()
        (outside / 'sample.txt').write_text('SYNTHETIC_OUTSIDE', encoding='utf-8')
        (self.workspace / 'escape.txt').symlink_to(outside / 'sample.txt')
        (self.workspace / 'escape_dir').symlink_to(outside, target_is_directory=True)
        (self.workspace / '.env').write_text('SYNTHETIC_DENIED', encoding='utf-8')
        (self.workspace / 'alias.txt').symlink_to(self.workspace / '.env')
        os.link(outside / 'sample.txt', self.workspace / 'linked.txt')
        os.mkfifo(self.workspace / 'pipe.txt')
        for name, content in [('large.txt', b'x' * 65537), ('invalid.txt', b'\xff\xfe'),
                              ('nul.txt', b'a\x00b'), ('control.txt', b'a\x01b')]:
            (self.workspace / name).write_bytes(content)
        for path in ['escape.txt', 'escape_dir/sample.txt', 'alias.txt', 'linked.txt',
                     'pipe.txt', 'large.txt', 'invalid.txt', 'nul.txt', 'control.txt',
                     'missing.txt', 'escape_dir']:
            with self.subTest(path=path):
                with self.assertRaises(PermissionError) as denied_error:
                    self.executor.read_file(path)
                message = str(denied_error.exception)
                self.assertNotIn(str(self.workspace), message)
                self.assertNotIn('SYNTHETIC_OUTSIDE', message)
                self.assertNotIn('SYNTHETIC_DENIED', message)
        self.assertEqual((outside / 'sample.txt').read_text(encoding='utf-8'), 'SYNTHETIC_OUTSIDE')

    def test_read_denies_file_changed_after_initial_metadata_check(self):
        note = self.workspace / 'note.txt'
        note.write_text('original synthetic', encoding='utf-8')
        original = os.fstat
        changed = False

        def stat_then_mutate(descriptor):
            nonlocal changed
            info = original(descriptor)
            if stat.S_ISREG(info.st_mode) and not changed:
                changed = True
                note.write_text('changed synthetic bytes', encoding='utf-8')
            return info

        with patch.object(mac_server.os, 'fstat', side_effect=stat_then_mutate):
            with self.assertRaises(PermissionError):
                self.executor.read_file('note.txt')
        self.assertTrue(changed)

    def test_read_denies_hardlink_added_after_initial_metadata_check(self):
        note = self.workspace / 'note.txt'
        note.write_text('synthetic', encoding='utf-8')
        original = os.fstat
        changed = False

        def stat_then_link(descriptor):
            nonlocal changed
            info = original(descriptor)
            if stat.S_ISREG(info.st_mode) and not changed:
                changed = True
                os.link(note, Path(self.temp.name) / 'new_link.txt')
            return info

        with patch.object(mac_server.os, 'fstat', side_effect=stat_then_link):
            with self.assertRaises(PermissionError):
                self.executor.read_file('note.txt')
        self.assertTrue(changed)

    def test_workspace_inode_replacement_denies_reads(self):
        (self.workspace / 'note.txt').write_text('original synthetic', encoding='utf-8')
        self.assertEqual(self.executor.read_file('note.txt')['content'], 'original synthetic')
        self.workspace.rename(Path(self.temp.name) / 'old_workspace')
        self.workspace.mkdir()
        (self.workspace / 'note.txt').write_text('replacement synthetic', encoding='utf-8')
        with self.assertRaises(PermissionError):
            self.executor.read_file('note.txt')


    def test_listing_filters_ineligible_entries_and_lists_nested_directories(self):
        (self.workspace / 'notes').mkdir()
        (self.workspace / 'notes' / 'inner.txt').write_text('synthetic', encoding='utf-8')
        (self.workspace / 'sample.txt').write_text('synthetic', encoding='utf-8')
        for name, content in [('.env', b'synthetic denied'), ('auth.json', b'denied'),
                              ('bad.bin', b'\xff'), ('large.txt', b'x' * 65537)]:
            (self.workspace / name).write_bytes(content)
        (self.workspace / 'alias.txt').symlink_to(self.workspace / 'sample.txt')
        (self.workspace / 'alias_dir').symlink_to(self.workspace / 'notes', target_is_directory=True)
        os.mkfifo(self.workspace / 'pipe.txt')
        self.assertEqual(self.executor.list_directory(),
                         {'execution_host': 'mac', 'path': '.', 'truncated': False,
                          'entries': [{'name': 'notes', 'type': 'directory'},
                                      {'name': 'sample.txt', 'type': 'file'}]})
        self.assertEqual(self.executor.list_directory('notes')['entries'],
                         [{'name': 'inner.txt', 'type': 'file'}])
        for path in ['../outside', '/outside', '.env', 'alias_dir', 'sample.txt', None]:
            with self.subTest(path=path), self.assertRaises(PermissionError):
                self.executor.list_directory(path)

    def test_listing_returns_at_most_100_eligible_entries(self):
        for index in range(450):
            (self.workspace / f'item{index:03d}.txt').write_text('synthetic', encoding='utf-8')
        with patch.object(self.executor, 'read_file', wraps=self.executor.read_file) as reads:
            result = self.executor.list_directory()
        self.assertEqual(len(result['entries']), 100)
        self.assertTrue(result['truncated'])
        self.assertLessEqual(reads.call_count, 100)
        self.assertEqual(result['entries'], sorted(result['entries'], key=lambda item: item['name']))

    def test_listing_examines_at_most_256_denied_entries(self):
        for index in range(450):
            (self.workspace / f'secret{index:03d}.txt').write_text('synthetic', encoding='utf-8')
        visited = []
        original = os.scandir

        @contextlib.contextmanager
        def counted_scan(descriptor):
            with original(descriptor) as scan:
                def entries():
                    for entry in scan:
                        visited.append(entry.name)
                        yield entry
                yield entries()

        with patch.object(mac_server.os, 'scandir', side_effect=counted_scan), \
                patch.object(self.executor, 'path_parts', wraps=self.executor.path_parts) as validation:
            result = self.executor.list_directory()
        self.assertEqual(result['entries'], [])
        self.assertTrue(result['truncated'])
        self.assertLessEqual(len(visited), 257)  # At most one unexamined lookahead.
        self.assertLessEqual(validation.call_count, 257)  # Root + 256 entry validations.

    def test_workspace_replacement_denies_listing(self):
        self.workspace.rename(Path(self.temp.name) / 'old_workspace')
        self.workspace.mkdir()
        with self.assertRaises(PermissionError):
            self.executor.list_directory()

    def test_device_status_is_minimal_os_metadata(self):
        status = self.executor.device_status()
        self.assertEqual(set(status), {'execution_host', 'system', 'release', 'machine'})
        self.assertEqual(status['execution_host'], 'mac')
        self.assertEqual(status['system'], 'Darwin')
        self.assertTrue(status['release'])
        self.assertTrue(status['machine'])

    def test_all_operations_deny_non_mac_before_access_or_metadata_probe(self):
        with patch.object(mac_server.platform, 'system', return_value='Linux'), \
                patch.object(self.executor, 'open_path', side_effect=AssertionError('must not open')), \
                patch.object(mac_server.platform, 'release', side_effect=AssertionError('must not probe')):
            for operation in [self.executor.device_status, self.executor.list_directory,
                              lambda: self.executor.read_file('sample.txt')]:
                with self.subTest(operation=operation), self.assertRaisesRegex(PermissionError, 'Darwin'):
                    operation()


class ServerStartupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR'))
        self.addCleanup(self.temp.cleanup)
        self.workspace = Path(self.temp.name)

    def test_build_server_denies_non_mac_before_sdk_or_path_probe(self):
        with patch.object(mac_server.platform, 'system', return_value='Linux'), \
                patch('importlib.metadata.version', side_effect=AssertionError('must not inspect SDK')), \
                patch.object(Path, 'lstat', side_effect=AssertionError('must not probe')):
            with self.assertRaisesRegex(PermissionError, 'Darwin'):
                mac_server.build_server(self.workspace)

    def test_unverified_sdk_version_is_denied(self):
        with patch.object(mac_server.platform, 'system', return_value='Darwin'), \
                patch('importlib.metadata.version', return_value='999.0.0'):
            with self.assertRaisesRegex(RuntimeError, 'mcp==2.0.0'):
                mac_server.build_server(self.workspace)

    def test_main_accepts_argv_and_starts_stdio_only(self):
        with patch.object(mac_server, 'build_server') as build:
            self.assertEqual(mac_server.main(['--workspace', str(self.workspace)]), 0)
        build.assert_called_once_with(str(self.workspace))
        build.return_value.run.assert_called_once_with(transport='stdio')

    def test_main_platform_denial_is_sanitized_without_traceback(self):
        output = io.StringIO()
        errors = io.StringIO()
        with patch.object(mac_server.platform, 'system', return_value='Linux'), \
                patch.object(Path, 'lstat', side_effect=AssertionError('must not probe')), \
                contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            with self.assertRaises(SystemExit) as exit_error:
                mac_server.main(['--workspace', str(self.workspace)])
        self.assertEqual(exit_error.exception.code, 2)
        self.assertEqual(output.getvalue(), '')
        self.assertIn('Darwin', errors.getvalue())
        self.assertNotIn(str(self.workspace), errors.getvalue())
        self.assertNotIn('Traceback', errors.getvalue())


class ImportTests(unittest.TestCase):
    def test_executor_import_does_not_require_optional_sdk(self):
        source = str(Path(__file__).resolve().parents[1] / 'src')
        result = subprocess.run(
            [sys.executable, '-S', '-c',
             'import sys; from hermes_companion.mac_server import MacExecutor; '
             'assert callable(MacExecutor); assert "mcp" not in sys.modules'],
            env={**os.environ, 'PYTHONPATH': source, 'PYTHONDONTWRITEBYTECODE': '1'},
            capture_output=True, text=True, timeout=10,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, '')


    @unittest.skipUnless(mac_server.platform.system() == 'Darwin', 'Real SDK-free executor success requires Darwin')
    def test_sdk_free_executor_reads_synthetic_workspace_on_real_mac(self):
        with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as temporary:
            workspace = Path(temporary) / 'workspace'
            workspace.mkdir()
            (workspace / 'sample.txt').write_text('synthetic SDK-free read', encoding='utf-8')
            source = str(Path(__file__).resolve().parents[1] / 'src')
            result = subprocess.run(
                [sys.executable, '-S', '-c',
                 'import sys; from hermes_companion.mac_server import MacExecutor; '
                 'executor = MacExecutor(sys.argv[1]); '
                 'assert executor.read_file("sample.txt")["content"] == "synthetic SDK-free read"; '
                 'assert "mcp" not in sys.modules', str(workspace)],
                env={**os.environ, 'PYTHONPATH': source, 'PYTHONDONTWRITEBYTECODE': '1'},
                capture_output=True, text=True, timeout=10,
            )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, '')


if __name__ == '__main__':
    unittest.main()

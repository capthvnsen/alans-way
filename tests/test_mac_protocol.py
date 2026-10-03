"""Real SDK subprocess tests; successful Mac calls run only on real Darwin."""
import contextlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import tempfile
import unittest

SOURCE = str(Path(__file__).resolve().parents[1] / 'src')
try:
    SDK_VERIFIED = importlib.metadata.version('mcp') == '2.0.0'
except importlib.metadata.PackageNotFoundError:
    SDK_VERIFIED = False
if SDK_VERIFIED:
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client


@unittest.skipUnless(platform.system() == 'Darwin' and SDK_VERIFIED,
                     'Real Mac protocol success requires Darwin and mcp==2.0.0')
class MacProtocolTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR'))
        self.addCleanup(self.temp.cleanup)
        self.workspace = Path(self.temp.name) / 'workspace'
        self.workspace.mkdir()

    @contextlib.asynccontextmanager
    async def session(self):
        callbacks = []

        async def reject_sampling(*args, **kwargs):
            callbacks.append('sampling')
            raise AssertionError('Server must not request model sampling')

        async def reject_elicitation(*args, **kwargs):
            callbacks.append('elicitation')
            raise AssertionError('Server must not request approval or secrets')

        params = StdioServerParameters(
            command=sys.executable,
            args=['-m', 'hermes_companion.mac_server', '--workspace', str(self.workspace)],
            env={'TMPDIR': self.temp.name, 'PYTHONPATH': SOURCE,
                 'PYTHONDONTWRITEBYTECODE': '1'},
        )
        try:
            # Keep errlog outside the exposed workspace.
            with tempfile.TemporaryFile(mode='w+', dir=self.temp.name) as errors:
                async with stdio_client(params, errlog=errors) as (read, write):
                    async with ClientSession(
                        read, write, read_timeout_seconds=10,
                        sampling_callback=reject_sampling, elicitation_callback=reject_elicitation,
                    ) as session:
                        initialized = await session.initialize()
                        yield session, initialized
            self.assertEqual(callbacks, [], 'Unexpected sampling or approval request')
        except BaseExceptionGroup as error:
            while isinstance(error, BaseExceptionGroup) and len(error.exceptions) == 1:
                error = error.exceptions[0]
            raise error

    async def test_real_initialize_list_and_mac_status(self):
        async with self.session() as (session, initialized):
            self.assertEqual(initialized.server_info.name, 'hermes-companion-mac')
            tools = (await session.list_tools()).tools
            self.assertEqual({tool.name for tool in tools},
                             {'mac_device_status', 'mac_workspace_read_file', 'mac_workspace_list'})
            self.assertEqual(len(tools), 3)
            for tool in tools:
                self.assertTrue(tool.annotations.read_only_hint)
                self.assertFalse(tool.annotations.destructive_hint)
                self.assertTrue(tool.annotations.idempotent_hint)
                self.assertFalse(tool.annotations.open_world_hint)
            result = await session.call_tool('mac_device_status', {})
            self.assertFalse(result.is_error, result.content)
            status = json.loads(result.content[0].text)
            self.assertEqual(status['system'], 'Darwin')
            self.assertEqual(status['execution_host'], 'mac')
            self.assertEqual(set(status), {'execution_host', 'system', 'release', 'machine'})


    async def test_scoped_utf8_read_and_filtered_listing(self):
        (self.workspace / 'notes').mkdir()
        (self.workspace / 'notes' / 'sample.txt').write_text('Synthetic café ☃\n', encoding='utf-8')
        (self.workspace / 'sample.txt').write_text('synthetic', encoding='utf-8')
        (self.workspace / '.env').write_text('SYNTHETIC_DENIED', encoding='utf-8')
        (self.workspace / 'auth.json').write_text('SYNTHETIC_DENIED', encoding='utf-8')
        (self.workspace / 'bad.bin').write_bytes(b'\xff')
        (self.workspace / 'alias.txt').symlink_to(self.workspace / 'sample.txt')
        async with self.session() as (session, _):
            read = await session.call_tool('mac_workspace_read_file', {'path': 'notes/sample.txt'})
            self.assertFalse(read.is_error, read.content)
            self.assertEqual(json.loads(read.content[0].text),
                             {'execution_host': 'mac', 'path': 'notes/sample.txt',
                              'content': 'Synthetic café ☃\n'})
            listed = await session.call_tool('mac_workspace_list', {})
            self.assertFalse(listed.is_error, listed.content)
            self.assertEqual(json.loads(listed.content[0].text),
                             {'execution_host': 'mac', 'path': '.', 'truncated': False,
                              'entries': [{'name': 'notes', 'type': 'directory'},
                                          {'name': 'sample.txt', 'type': 'file'}]})
            nested = await session.call_tool('mac_workspace_list', {'path': 'notes'})
            self.assertFalse(nested.is_error, nested.content)
            self.assertEqual(json.loads(nested.content[0].text)['entries'],
                             [{'name': 'sample.txt', 'type': 'file'}])

    async def test_no_sensitive_execution_or_approval_bypass(self):
        marker = self.workspace / 'marker.txt'
        marker.write_text('synthetic unchanged', encoding='utf-8')
        async with self.session() as (session, initialized):
            self.assertNotIn('sampling', initialized.capabilities.model_dump(exclude_none=True))
            for name in ['mac_workspace_write_file', 'write_file', 'shell', 'mac_shell',
                         'mac_browser', 'send_email', 'payments', 'password', 'otp', 'unknown_tool']:
                with self.subTest(tool=name):
                    result = await session.call_tool(name, {
                        'path': 'marker.txt', 'content': 'CHANGED', 'command': 'touch forbidden.txt',
                        'approved': True, 'approval_receipt': 'SYNTHETIC_NOT_AUTHORITY',
                    })
                    self.assertTrue(result.is_error, result.content)
            # An approval-shaped argument cannot override the workspace policy either.
            denied = await session.call_tool('mac_workspace_read_file', {
                'path': '../outside.txt', 'approved': True,
                'approval_receipt': 'SYNTHETIC_NOT_AUTHORITY',
            })
            self.assertTrue(denied.is_error, denied.content)
        self.assertEqual(marker.read_text(encoding='utf-8'), 'synthetic unchanged')
        self.assertEqual({entry.name for entry in self.workspace.iterdir()}, {'marker.txt'})

    async def test_real_stdio_denials_hide_workspace_and_file_contents(self):
        outside = Path(self.temp.name) / 'outside.txt'
        outside.write_text('SYNTHETIC_OUTSIDE', encoding='utf-8')
        (self.workspace / 'escape.txt').symlink_to(outside)
        (self.workspace / '.env').write_text('SYNTHETIC_DENIED', encoding='utf-8')
        (self.workspace / 'oversize.txt').write_bytes(b'x' * 65537)
        (self.workspace / 'bad.txt').write_bytes(b'\xff')
        os.link(outside, self.workspace / 'linked.txt')
        os.mkfifo(self.workspace / 'pipe.txt')
        async with self.session() as (session, _):
            for path in [str(outside), '../outside.txt', '.env', 'escape.txt', 'oversize.txt',
                         'bad.txt', 'missing.txt', 'linked.txt', 'pipe.txt']:
                with self.subTest(path=path):
                    result = await session.call_tool('mac_workspace_read_file', {'path': path})
                    self.assertTrue(result.is_error, result.content)
                    message = result.content[0].text
                    self.assertNotIn(str(self.workspace), message)
                    self.assertNotIn(str(outside), message)
                    self.assertNotIn('SYNTHETIC_OUTSIDE', message)
                    self.assertNotIn('SYNTHETIC_DENIED', message)
                    self.assertNotIn('Traceback', message)
            for path in [str(outside), '../outside', '.env', 'escape.txt']:
                with self.subTest(list_path=path):
                    result = await session.call_tool('mac_workspace_list', {'path': path})
                    self.assertTrue(result.is_error, result.content)
                    self.assertNotIn(str(self.workspace), result.content[0].text)

    async def test_real_workspace_inode_replacement_denies_access(self):
        note = self.workspace / 'note.txt'
        note.write_text('original synthetic', encoding='utf-8')
        async with self.session() as (session, _):
            first = await session.call_tool('mac_workspace_read_file', {'path': 'note.txt'})
            self.assertFalse(first.is_error, first.content)
            self.workspace.rename(Path(self.temp.name) / 'old_workspace')
            self.workspace.mkdir()
            note.write_text('replacement synthetic', encoding='utf-8')
            for tool, args in [('mac_workspace_read_file', {'path': 'note.txt'}),
                               ('mac_workspace_list', {})]:
                denied = await session.call_tool(tool, args)
                self.assertTrue(denied.is_error, denied.content)
                self.assertNotIn('replacement synthetic', denied.content[0].text)


class SubprocessStartupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR'))
        self.addCleanup(self.temp.cleanup)
        self.workspace = Path(self.temp.name) / 'workspace'
        self.workspace.mkdir()

    def run_server(self, workspace, without_sdk=False):
        args = [sys.executable]
        if without_sdk:
            args.append('-S')
        return subprocess.run(
            args + ['-m', 'hermes_companion.mac_server', '--workspace', str(workspace)],
            env={**os.environ, 'PYTHONPATH': SOURCE, 'PYTHONDONTWRITEBYTECODE': '1'},
            input='', text=True, capture_output=True, timeout=10,
        )

    def assert_safe_startup_failure(self, result, workspace):
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertEqual(result.stdout, '')
        self.assertNotIn('Traceback', result.stderr)
        self.assertNotIn(str(workspace), result.stderr)

    def test_invalid_workspace_fails_before_protocol(self):
        if platform.system() == 'Darwin' and not SDK_VERIFIED:
            self.skipTest('Workspace validation subprocess requires mcp==2.0.0 on Darwin')
        invalid = self.workspace / 'not-created'
        result = self.run_server(invalid)
        self.assert_safe_startup_failure(result, invalid)
        self.assertIn('workspace' if platform.system() == 'Darwin' else 'Darwin', result.stderr)

    def test_missing_sdk_is_actionable_or_platform_denied(self):
        result = self.run_server(self.workspace, without_sdk=True)
        self.assert_safe_startup_failure(result, self.workspace)
        expected = 'hermes-companion[mcp]' if platform.system() == 'Darwin' else 'Darwin'
        self.assertIn(expected, result.stderr)

    @unittest.skipIf(platform.system() == 'Darwin', 'Real non-Darwin startup test')
    def test_real_non_mac_startup_denies_even_existing_workspace(self):
        result = self.run_server(self.workspace)
        self.assert_safe_startup_failure(result, self.workspace)
        self.assertIn('Darwin', result.stderr)


if __name__ == '__main__':
    unittest.main()

"""Entry-point tests for the Hermes plugin. Nothing here needs aiohttp or a real Hermes."""
import subprocess
import sys
import tempfile
import types
import unittest
from email.utils import formatdate
from pathlib import Path
from unittest.mock import MagicMock, patch

from mobile.voice import hermes_plugin
from mobile.voice.hermes_plugin import MobileVoicePlugin, register

ROOT = Path(__file__).resolve().parents[2]
SECRETS = {"TELEGRAM_BOT_TOKEN": "123:own-token", "HERMES_DASHBOARD_SESSION_TOKEN": "dash-token"}
PRIVATE_DM = {"HERMES_SESSION_PLATFORM": "telegram", "HERMES_SESSION_CHAT_TYPE": "private",
              "HERMES_SESSION_CHAT_ID": "42", "HERMES_SESSION_USER_ID": "42",
              "HERMES_SESSION_KEY": "canonical-key", "HERMES_SESSION_PROFILE": "default"}


class Context:
    profile_name = "default"

    def __init__(self, **settings):
        self.settings = settings
        self.commands, self.hooks, self.tts, self.stt = {}, {}, [], []
        self.cleanup = None

    def get_config(self, key, default=None):
        return self.settings.get(key, default)

    def register_command(self, name, handler, description=""):
        self.commands[name] = handler

    def register_hook(self, name, handler):
        self.hooks[name] = handler

    def register_tts_provider(self, provider):
        self.tts.append(provider)

    def register_transcription_provider(self, provider):
        self.stt.append(provider)

    def on_unload(self, callback):
        self.cleanup = callback

    def inject_message(self, *args, **kwargs):
        return True


def hermes_modules(storage_dir=None):
    scope = types.ModuleType("agent.secret_scope")
    scope.get_secret = lambda name: SECRETS.get(name)
    tts = types.ModuleType("agent.tts_provider")
    tts.TTSProvider = type("TTSProvider", (), {})
    stt = types.ModuleType("agent.transcription_provider")
    stt.TranscriptionProvider = type("TranscriptionProvider", (), {})
    modules = {"agent.secret_scope": scope, "agent.tts_provider": tts, "agent.transcription_provider": stt}
    if storage_dir:
        storage = types.ModuleType("plugins.plugin_storage")
        storage.plugin_data_dir = lambda name: Path(storage_dir) / name
        modules["plugins.plugin_storage"] = storage
    return modules


def session(**overrides):
    values = {**PRIVATE_DM, **overrides}
    return patch.object(hermes_plugin, "_session_env", side_effect=lambda key, default="": values.get(key, default))


class RegisterTests(unittest.TestCase):
    def test_importing_the_plugin_does_not_load_aiohttp(self):
        # `hermes plugins doctor` and a host without aiohttp must still load it.
        code = "import sys, mobile.voice; assert 'aiohttp' not in sys.modules, 'aiohttp imported at plugin import'"
        done = subprocess.run([sys.executable, "-c", code], cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stderr)

    def test_register_adds_the_command_hooks_and_speech_providers_without_starting_anything(self):
        ctx = Context()
        with patch.dict(sys.modules, hermes_modules()):
            register(ctx)
        self.assertEqual(set(ctx.commands), {"call"})
        self.assertEqual(set(ctx.hooks), {"post_llm_call", "on_session_reset"})
        self.assertEqual(len(ctx.tts), 1)
        self.assertEqual(len(ctx.stt), 1)
        self.assertTrue(callable(ctx.cleanup))

    def test_register_survives_a_hermes_that_moved_the_speech_provider_api(self):
        ctx = Context()
        modules = hermes_modules()
        with patch.dict(sys.modules, {**modules, "agent.tts_provider": None}):
            with self.assertLogs(hermes_plugin.log, "WARNING") as logs:
                register(ctx)
        self.assertEqual(set(ctx.commands), {"call"})
        self.assertEqual(set(ctx.hooks), {"post_llm_call", "on_session_reset"})
        self.assertEqual(ctx.tts, [])
        self.assertIn("OpenRouter speech", "\n".join(logs.output))

    def test_register_does_not_need_plugin_storage(self):
        ctx = Context()
        with patch.dict(sys.modules, {**hermes_modules(), "plugins.plugin_storage": None}):
            register(ctx)
        self.assertIn("call", ctx.commands)


class SettingsTests(unittest.TestCase):
    def plugin(self, **settings):
        with patch.dict(sys.modules, hermes_modules()):
            return MobileVoicePlugin(Context(app_url="https://voice.example.test/call", **settings))

    def test_defaults_are_valid(self):
        plugin = self.plugin()
        self.assertEqual((plugin.config_error, plugin.port, plugin.turn_timeout), ("", 8765, 180))

    def test_string_numbers_from_yaml_are_accepted(self):
        plugin = self.plugin(port="8877", turn_timeout="60")
        self.assertEqual((plugin.config_error, plugin.port, plugin.turn_timeout), ("", 8877, 60))

    def test_bad_values_disable_voice_and_name_the_setting(self):
        for name, value in (("port", "abc"), ("port", 0), ("port", 70000), ("port", True), ("port", 8765.5),
                            ("turn_timeout", 0), ("turn_timeout", -5), ("turn_timeout", "soon")):
            with self.subTest(name=name, value=value):
                plugin = self.plugin(**{name: value})
                self.assertIn(name, plugin.config_error)

    def test_non_https_app_url_is_rejected(self):
        with patch.dict(sys.modules, hermes_modules()):
            plugin = MobileVoicePlugin(Context(app_url="http://voice.example.test/call"))
        self.assertIn("app_url", plugin.config_error)

    def test_bad_settings_never_start_the_listener_and_the_command_says_why(self):
        plugin = self.plugin(port=70000)
        with patch.dict(sys.modules, hermes_modules()):
            with self.assertRaises(RuntimeError):
                plugin.start()
            with session():
                text = self.run_call(plugin)
        self.assertIn("port", text)
        self.assertIsNone(plugin.broker)

    @staticmethod
    def run_call(plugin):
        import asyncio
        return asyncio.run(plugin.call_command())


class StartTests(unittest.TestCase):
    def plugin(self):
        with patch.dict(sys.modules, hermes_modules()):
            return MobileVoicePlugin(Context(app_url="https://voice.example.test/call"))

    def test_start_without_credentials_stays_idle(self):
        plugin = self.plugin()
        scope = types.ModuleType("agent.secret_scope")
        scope.get_secret = lambda name: None
        with patch.dict(sys.modules, {"agent.secret_scope": scope}):
            plugin.start()
        self.assertIsNone(plugin.broker)
        self.assertIsNone(plugin.listener)

    def test_start_says_what_to_install_when_aiohttp_is_missing(self):
        plugin = self.plugin()
        with tempfile.TemporaryDirectory() as temp, patch.dict(
                sys.modules, {**hermes_modules(temp), "mobile.voice.server": None}):
            with self.assertRaises(RuntimeError) as caught:
                plugin.start()
        self.assertIn("aiohttp", str(caught.exception))
        self.assertIsNone(plugin.broker)

    def test_start_says_which_hermes_api_is_missing(self):
        plugin = self.plugin()
        with patch.dict(sys.modules, {**hermes_modules(), "plugins.plugin_storage": None}):
            with self.assertRaises(RuntimeError) as caught:
                plugin.start()
        self.assertIn("plugins.plugin_storage", str(caught.exception))
        self.assertIsNone(plugin.broker)


class ConcurrentStartTests(unittest.TestCase):
    def test_simultaneous_calls_start_one_listener(self):
        import threading
        import time
        started = []

        class Listener:
            def __init__(self, *args, **kwargs):
                self.host, self.port = "127.0.0.1", kwargs.get("port")

            def start(self):
                time.sleep(0.05)
                started.append(self)

            def stop(self):
                pass

        class Broker:
            def __init__(self, **kwargs):
                self.db = MagicMock()
                self.audio = kwargs["audio"]

        stub = types.ModuleType("mobile.voice.server")
        stub.BrokerListener, stub.VoiceBroker = Listener, Broker
        stub.HermesAudio = lambda *args, **kwargs: MagicMock()
        with tempfile.TemporaryDirectory() as temp, patch.dict(
                sys.modules, {**hermes_modules(temp), "mobile.voice.server": stub}):
            plugin = MobileVoicePlugin(Context(app_url="https://voice.example.test/call"))
            threads = [threading.Thread(target=plugin.start) for _ in range(6)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()
        self.assertEqual(len(started), 1)
        self.assertIsNotNone(plugin.broker)


class CallCommandTests(unittest.IsolatedAsyncioTestCase):
    def plugin(self):
        with patch.dict(sys.modules, hermes_modules()):
            plugin = MobileVoicePlugin(Context(app_url="https://voice.example.test/call"))
        plugin.bot_token = "123:own-token"
        return plugin

    async def test_refuses_anything_but_a_verified_private_telegram_chat(self):
        cases = {
            "HERMES_SESSION_PLATFORM": "discord", "HERMES_SESSION_CHAT_TYPE": "group",
            "HERMES_SESSION_PROFILE": "other", "HERMES_SESSION_USER_ID": "7", "HERMES_SESSION_KEY": "",
        }
        for key, value in cases.items():
            with self.subTest(key=key):
                plugin = self.plugin()
                plugin.start = MagicMock()
                with session(**{key: value}):
                    text = await plugin.call_command()
                self.assertTrue(text)
                plugin.start.assert_not_called()

    async def test_clock_skew_names_the_clock_not_the_configuration(self):
        plugin = self.plugin()
        plugin.start = MagicMock()
        plugin.broker = MagicMock()
        plugin.broker.observe_telegram_time.side_effect = ValueError("Telegram and host clocks differ")
        response = MagicMock()
        response.__enter__.return_value = response
        response.headers = {"Date": formatdate(1_800_000_000 + 3600, usegmt=True)}
        response.read.return_value = b'{"ok":true,"result":{"id":9001}}'
        with session(), patch.object(hermes_plugin.urllib.request, "urlopen", return_value=response):
            text = await plugin.call_command()
        self.assertIn("clock", text)
        self.assertNotIn("configuration", text)

    async def test_a_malformed_date_header_does_not_break_the_call(self):
        response = MagicMock()
        response.__enter__.return_value = response
        response.headers = {"Date": "not a date"}
        response.read.return_value = b'{"ok":true,"result":{"id":9001}}'
        seen = []
        with patch.object(hermes_plugin.urllib.request, "urlopen", return_value=response):
            result = hermes_plugin._telegram("getMe", "t", {}, on_server_time=seen.append)
        self.assertEqual(result, {"id": 9001})
        self.assertEqual(seen, [])

    async def test_a_start_failure_is_logged_with_its_reason_and_never_with_the_token(self):
        plugin = self.plugin()
        plugin.start = MagicMock(side_effect=RuntimeError("Voice broker could not listen on 127.0.0.1:8765: address in use"))
        with session(), self.assertLogs(hermes_plugin.log, "WARNING") as logs:
            text = await plugin.call_command()
        output = "\n".join(logs.output)
        self.assertIn("address in use", output)
        self.assertNotIn("own-token", output)
        self.assertIn("address in use", text)


if __name__ == "__main__":
    unittest.main()

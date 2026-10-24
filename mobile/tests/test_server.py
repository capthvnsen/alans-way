import asyncio
import hashlib
import hmac
import json
import tempfile
import time
import unittest
import urllib.parse
import uuid
import os
import sys
import types
from unittest.mock import patch
from pathlib import Path

from aiohttp.test_utils import TestClient, TestServer
from aiohttp import web

from mobile.voice.protocol import LaunchBinding
from mobile.voice.server import BrokerListener, HermesAudio, VoiceBroker
from mobile.voice.hermes_plugin import MobileVoicePlugin, _telegram


def init_data(token, user_id="42", auth_date=None):
    auth_date = int(time.time()) if auth_date is None else auth_date
    values = {
        "auth_date": str(auth_date),
        "query_id": "AAE-call-test",
        "user": json.dumps({"id": int(user_id), "first_name": "Ada"}, separators=(",", ":")),
    }
    check = "\n".join(f"{key}={value}" for key, value in sorted(values.items()))
    secret = hmac.new(b"WebAppData", token.encode(), hashlib.sha256).digest()
    values["hash"] = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
    return urllib.parse.urlencode(values)


class FakeAudio:
    def __init__(self):
        self.transcriptions = 0

    async def capabilities(self):
        return {"ready": True, "mode": "chained", "stt": {"provider": "configured"}, "tts": {"provider": "configured"}}

    async def transcribe(self, _audio, _mime):
        self.transcriptions += 1
        return "remember this exact fact"

    async def synthesize(self, text):
        return (f"spoken:{text}".encode(), "audio/wav")


class VoiceHttpProtocolTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.injected = []
        self.transcript_bubbles = []
        self.audio = FakeAudio()
        self.broker = VoiceBroker(
            bot_token="123:secret",
            db_path=Path(self.tmp.name) / "voice.sqlite3",
            audio=self.audio,
            inject=lambda text, session_key: self.injected.append((text, session_key)) or True,
            app_url="https://voice.example.test/call",
            send_transcript=lambda binding, text: self.transcript_bubbles.append((binding.chat_id, text)) or True,
            get_bot_id=lambda: "9001",
            turn_timeout_seconds=2,
        )
        self.binding = LaunchBinding("default", "9001", "42", "42", "existing-canonical-session")
        self.ticket = self.broker.issue_launch_ticket(self.binding)
        self.assertEqual(
            self.broker.app_link("ticket+/=%"),
            "https://voice.example.test/call/?ticket=ticket%2B%2F%3D%25",
        )
        self.client = TestClient(TestServer(self.broker.build_app()))
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()
        self.tmp.cleanup()

    async def _create_call(self):
        response = await self.client.post("/v1/calls", json={
            "launch_ticket": self.ticket,
            "init_data": init_data("123:secret"),
        })
        self.assertEqual(response.status, 200)
        return await response.json()

    async def test_auth_uses_telegram_https_time_when_host_clock_is_behind(self):
        issued_at = int(time.time())
        # A genuine launch is 46 seconds ahead of the host clock. Use the
        # Telegram HTTPS response time, anchored to monotonic elapsed time.
        with patch("mobile.voice.server.time.time", return_value=issued_at - 46):
            self.broker.observe_telegram_time(issued_at)
            result = await self.client.post("/v1/calls", json={
                "launch_ticket": self.ticket,
                "init_data": init_data("123:secret", auth_date=issued_at),
            })
            self.assertEqual(result.status, 200)
            stale = await self.client.post("/v1/calls", json={
                "launch_ticket": self.ticket,
                "init_data": init_data("123:secret", auth_date=issued_at - 1000),
            })
            self.assertEqual(stale.status, 401)

    async def test_authenticated_upload_injects_once_and_returns_correlated_reply_audio(self):
        call = await self._create_call()
        turn_id = str(uuid.uuid4())
        headers = {"Authorization": f"Bearer {call['access_token']}"}

        async def upload():
            form = __import__("aiohttp").FormData()
            form.add_field("turn_id", turn_id)
            form.add_field("audio", b"synthetic audio bytes", filename="clip.wav", content_type="audio/wav")
            return await self.client.post(f"/v1/calls/{call['call_id']}/turns", data=form, headers=headers)

        first = await upload()
        self.assertEqual(first.status, 202)
        accepted = await first.json()
        self.assertEqual(accepted["status"], "accepted")
        self.assertEqual(accepted["transcript"], "remember this exact fact")
        self.assertEqual(len(self.injected), 1)
        self.assertEqual(self.transcript_bubbles, [("42", "remember this exact fact")])
        injected_text, session_key = self.injected[0]
        self.assertEqual(session_key, "existing-canonical-session")
        self.assertIn("remember this exact fact", injected_text)

        # Simulate Hermes' successful post_llm_call observer for this exact
        # injected request, as the real plugin hook does.
        captured = self.broker.turns.capture(session_key, injected_text, "The remembered fact is exact.")
        self.assertEqual(captured.reply_text, "The remembered fact is exact.")

        status = None
        for _ in range(30):
            response = await self.client.get(
                f"/v1/calls/{call['call_id']}/turns/{turn_id}", headers=headers
            )
            status = await response.json()
            if status["status"] == "completed":
                break
            await asyncio.sleep(0.05)
        self.assertEqual(status["status"], "completed")
        self.assertEqual(status["transcript"], "remember this exact fact")
        self.assertEqual(status["reply_text"], "The remembered fact is exact.")
        audio = await self.client.get(status["audio_url"], headers=headers)
        self.assertEqual(audio.status, 200)
        self.assertEqual(audio.headers["Content-Type"], "audio/wav")
        self.assertEqual(await audio.read(), b"spoken:The remembered fact is exact.")

        # A retry with the same client turn ID returns durable status and never
        # injects a duplicate canonical Hermes user turn.
        duplicate = await upload()
        self.assertEqual(duplicate.status, 202)
        self.assertEqual(len(self.injected), 1)
        self.assertEqual(len(self.transcript_bubbles), 1)

    async def test_closed_call_token_cannot_submit_or_read(self):
        call = await self._create_call()
        headers = {"Authorization": f"Bearer {call['access_token']}"}
        response = await self.client.delete(f"/v1/calls/{call['call_id']}", headers=headers)
        self.assertEqual(response.status, 200)
        refused = await self.client.get(
            f"/v1/calls/{call['call_id']}/turns/not-a-turn", headers=headers
        )
        self.assertEqual(refused.status, 401)

    async def test_interrupt_requires_matching_bearer_and_an_empty_capped_body(self):
        call = await self._create_call()
        call_id, turn_id = call["call_id"], str(uuid.uuid4())
        self.broker.turns.create(call_id, turn_id, "hello", self.binding.session_key)
        url = f"/v1/calls/{call_id}/turns/{turn_id}/interrupt"
        headers = {"Authorization": f"Bearer {call['access_token']}"}
        for auth in ({}, {"Authorization": "Bearer wrong-token"}):
            self.assertEqual((await self.client.post(url, headers=auth)).status, 401)
        self.broker.db.create_call("other-call", "other-token", self.binding)
        self.assertEqual((await self.client.post(url, headers={"Authorization": "Bearer other-token"})).status, 401)
        self.assertEqual((await self.client.post(url, data=b"x", headers=headers)).status, 400)
        self.assertEqual((await self.client.post(url, data=b"x" * 1024, headers=headers)).status, 413)
        self.assertEqual((await self.client.post(url, data=b"x", chunked=True, headers=headers)).status, 411)
        self.assertEqual((await self.client.post(url.replace(turn_id, "bad-id"), headers=headers)).status, 400)
        other_id = str(uuid.uuid4())
        self.assertEqual((await self.client.post(url.replace(turn_id, other_id), headers=headers)).status, 404)
        for _ in range(2):
            self.assertEqual((await self.client.post(url, headers=headers)).status, 200)

    async def test_interrupt_during_synthesis_suppresses_late_audio_durably(self):
        call = await self._create_call()
        call_id, turn_id = call["call_id"], str(uuid.uuid4())
        headers = {"Authorization": f"Bearer {call['access_token']}"}
        url = f"/v1/calls/{call_id}/turns/{turn_id}"
        turn, _ = self.broker.turns.create(call_id, turn_id, "hello", self.binding.session_key)
        started, release = asyncio.Event(), asyncio.Event()

        async def delayed_speech(_text):
            started.set()
            await release.wait()
            return b"stale audio", "audio/wav"

        self.audio.synthesize = delayed_speech
        self.broker.turns.capture(self.binding.session_key, turn.injected_text, "early reply text")
        task = asyncio.create_task(self.broker._finish_turn(call_id, turn_id))
        try:
            await asyncio.wait_for(started.wait(), timeout=2)
            status = await (await self.client.get(url, headers=headers)).json()
            self.assertEqual(status["reply_text"], "early reply text")
            self.assertEqual(status["status"], "synthesizing")
            response = await self.client.post(url + "/interrupt", headers=headers)
            self.assertEqual((await response.json())["agent_work"], "continues")
        finally:
            release.set()
            await task
        status = await (await self.client.get(url, headers=headers)).json()
        self.assertTrue(status["playback_interrupted"])
        self.assertNotIn("audio_url", status)
        self.assertEqual(status["reply_text"], "early reply text")
        self.assertEqual((await self.client.get(url + "/audio", headers=headers)).status, 404)
        from mobile.voice.protocol import TurnRegistry
        recovered = TurnRegistry(self.broker.db.path)
        self.assertTrue(recovered.get(call_id, turn_id).playback_interrupted)
        self.assertIsNone(recovered.get_audio(call_id, turn_id))

    async def test_interrupt_before_reply_keeps_correlation_and_skips_synthesis(self):
        call = await self._create_call()
        call_id, turn_id = call["call_id"], str(uuid.uuid4())
        headers = {"Authorization": f"Bearer {call['access_token']}"}
        url = f"/v1/calls/{call_id}/turns/{turn_id}"
        turn, _ = self.broker.turns.create(call_id, turn_id, "hello", self.binding.session_key)
        self.assertEqual((await self.client.post(url + "/interrupt", headers=headers)).status, 200)
        captured = self.broker.turns.capture(self.binding.session_key, turn.injected_text, "reply still in chat")
        self.assertIsNotNone(captured)
        with patch.object(self.audio, "synthesize", side_effect=AssertionError("stale TTS")):
            await self.broker._finish_turn(call_id, turn_id)
        status = await (await self.client.get(url, headers=headers)).json()
        self.assertEqual(status["reply_text"], "reply still in chat")
        self.assertTrue(status["playback_interrupted"])
        self.assertNotIn("audio_url", status)

    async def test_interrupt_removes_already_completed_audio_without_affecting_next_turn(self):
        call = await self._create_call()
        call_id, turn_id = call["call_id"], str(uuid.uuid4())
        headers = {"Authorization": f"Bearer {call['access_token']}"}
        turn, _ = self.broker.turns.create(call_id, turn_id, "first", self.binding.session_key)
        self.broker.turns.capture(self.binding.session_key, turn.injected_text, "first reply")
        self.broker.turns.complete_audio(call_id, turn_id, b"first audio", "audio/wav")
        url = f"/v1/calls/{call_id}/turns/{turn_id}"
        self.assertEqual((await self.client.get(url + "/audio", headers=headers)).status, 200)
        self.assertEqual((await self.client.post(url + "/interrupt", headers=headers)).status, 200)
        self.assertEqual((await self.client.get(url + "/audio", headers=headers)).status, 404)
        next_id = str(uuid.uuid4())
        next_turn, _ = self.broker.turns.create(call_id, next_id, "second", self.binding.session_key)
        self.broker.turns.capture(self.binding.session_key, next_turn.injected_text, "second reply")
        self.broker.turns.complete_audio(call_id, next_id, b"second audio", "audio/wav")
        self.assertEqual(self.broker.turns.get_audio(call_id, next_id), (b"second audio", "audio/wav"))

    async def test_hangup_during_transcription_does_not_inject_a_turn(self):
        call = await self._create_call()
        headers = {"Authorization": f"Bearer {call['access_token']}"}
        started, release = asyncio.Event(), asyncio.Event()

        async def delayed_transcription(_audio, _mime):
            started.set()
            await release.wait()
            return "this utterance was cancelled"

        self.audio.transcribe = delayed_transcription
        form = __import__("aiohttp").FormData()
        form.add_field("turn_id", str(uuid.uuid4()))
        form.add_field("audio", b"synthetic audio", filename="clip.webm", content_type="audio/webm")
        upload = asyncio.create_task(self.client.post(
            f"/v1/calls/{call['call_id']}/turns", data=form, headers=headers
        ))
        await asyncio.wait_for(started.wait(), timeout=2)
        closed = await self.client.delete(f"/v1/calls/{call['call_id']}", headers=headers)
        self.assertEqual(closed.status, 200)
        release.set()
        response = await upload
        self.assertEqual(response.status, 401)
        self.assertEqual(self.injected, [])
        self.assertEqual(self.transcript_bubbles, [])

    async def test_call_command_posts_fresh_ticket_bound_to_exact_private_session(self):
        plugin = MobileVoicePlugin.__new__(MobileVoicePlugin)
        plugin.broker = self.broker
        plugin.bot_token = "123:secret"
        plugin.profile = "default"
        values = {
            "HERMES_SESSION_PLATFORM": "telegram",
            "HERMES_SESSION_CHAT_TYPE": "private",
            "HERMES_SESSION_CHAT_ID": "42",
            "HERMES_SESSION_USER_ID": "42",
            "HERMES_SESSION_KEY": "existing-canonical-session",
            "HERMES_SESSION_ID": "generation-9",
            "HERMES_SESSION_PROFILE": "default",
            "HERMES_SESSION_THREAD_ID": "",
        }
        telegram_calls = []

        def fake_telegram(method, _token, payload, **_kwargs):
            telegram_calls.append((method, payload))
            return {"id": 9001} if method == "getMe" else {}

        with patch("mobile.voice.hermes_plugin._session_env", side_effect=lambda key, default="": values.get(key, default)), patch(
            "mobile.voice.hermes_plugin._telegram", side_effect=fake_telegram
        ):
            self.assertEqual(await plugin.call_command(), "")

        self.assertEqual([method for method, _ in telegram_calls], ["getMe", "sendMessage"])
        message = telegram_calls[-1][1]
        self.assertEqual(message["chat_id"], "42")
        app_url = message["reply_markup"]["inline_keyboard"][0][0]["web_app"]["url"]
        parsed = urllib.parse.urlparse(app_url)
        ticket = urllib.parse.parse_qs(parsed.query)["ticket"][0]
        binding = self.broker.db.consume(ticket, user_id="42")
        self.assertEqual(parsed.path, "/call/")
        self.assertEqual(binding.session_key, "existing-canonical-session")
        self.assertEqual(binding.session_generation, "generation-9")
        self.assertEqual(binding.bot_id, "9001")

    async def test_gateway_command_without_session_id_still_binds_and_reset_revokes(self):
        # Hermes slash dispatch supplies the canonical key before allocating a
        # turn, and currently leaves HERMES_SESSION_ID empty.
        plugin = MobileVoicePlugin.__new__(MobileVoicePlugin)
        plugin.broker, plugin.bot_token, plugin.profile = self.broker, "123:secret", "default"
        values = {"HERMES_SESSION_PLATFORM": "telegram", "HERMES_SESSION_CHAT_TYPE": "private",
                  "HERMES_SESSION_CHAT_ID": "42", "HERMES_SESSION_USER_ID": "42",
                  "HERMES_SESSION_KEY": "existing-canonical-session"}
        calls = []
        def telegram(method, _token, payload, **_kwargs):
            calls.append((method, payload))
            return {"id": 9001} if method == "getMe" else {}
        with patch("mobile.voice.hermes_plugin._session_env", side_effect=lambda k, default="": values.get(k, default)), patch(
            "mobile.voice.hermes_plugin._telegram", side_effect=telegram
        ):
            self.assertEqual(await plugin.call_command(), "")
        url = calls[-1][1]["reply_markup"]["inline_keyboard"][0][0]["web_app"]["url"]
        ticket = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)["ticket"][0]
        binding = self.broker.db.consume(ticket, user_id="42")
        self.assertEqual(binding.session_key, "existing-canonical-session")
        self.broker.db.create_call("active-call", "credential", binding)
        pending = self.broker.issue_launch_ticket(binding)
        plugin.on_session_reset(session_id="replacement-id", old_session_id="old-id", platform="telegram")
        self.assertIsNone(self.broker.db.get_call("active-call", "credential"))
        self.assertIsNone(self.broker.db.consume(pending, user_id="42"))

    async def test_capabilities_hide_the_describer_from_unauthenticated_callers(self):
        anonymous = await self.client.get("/v1/capabilities")
        self.assertEqual(anonymous.status, 200)
        self.assertEqual(await anonymous.json(), {"version": 1, "ready": True})
        bogus = await self.client.get("/v1/capabilities", headers={"Authorization": "Bearer nope"})
        self.assertEqual(await bogus.json(), {"version": 1, "ready": True})
        call = await self._create_call()
        full = await self.client.get("/v1/capabilities", headers={"Authorization": f"Bearer {call['access_token']}"})
        body = await full.json()
        self.assertEqual(body["stt"], {"provider": "configured"})

    async def test_turn_upload_limits_and_audio_type_whitelist(self):
        call = await self._create_call()
        headers = {"Authorization": f"Bearer {call['access_token']}"}
        url = f"/v1/calls/{call['call_id']}/turns"

        def form(turn_id=None, content_type="audio/webm", extra=()):
            data = __import__("aiohttp").FormData()
            data.add_field("turn_id", turn_id or str(uuid.uuid4()))
            for name, value in extra:
                data.add_field(name, value)
            data.add_field("audio", b"synthetic audio", filename="clip.webm", content_type=content_type)
            return data

        self.assertEqual((await self.client.post(url, data=form(content_type="audio/webm;codecs=opus"), headers=headers)).status, 202)
        self.assertEqual((await self.client.post(url, data=form(content_type="text/html"), headers=headers)).status, 400)
        self.assertEqual((await self.client.post(url, data=form(content_type="audio/x-evil"), headers=headers)).status, 400)
        self.assertEqual((await self.client.post(url, data=form(extra=[("mime_type", "x" * 1000)]), headers=headers)).status, 413)
        many = [(f"f{i}", "1") for i in range(20)]
        self.assertEqual((await self.client.post(url, data=form(extra=many), headers=headers)).status, 400)
        big = await self.client.post(url, data=b"x", headers={**headers, "Content-Length": str(50 * 1024 * 1024),
                                                              "Content-Type": "multipart/form-data; boundary=b"})
        self.assertEqual(big.status, 413)
        self.assertEqual(self.audio.transcriptions, 1)

    async def test_serves_only_miniapp_assets_with_private_headers(self):
        root = Path(__file__).parents[1] / "miniapp"
        client = TestClient(TestServer(self.broker.build_app(miniapp_dir=root)))
        await client.start_server()
        try:
            response = await client.get("/call/?ticket=private-link")
            self.assertEqual(response.status, 200)
            self.assertIn("id=\"portrait\"", await response.text())
            self.assertEqual(response.headers.get("Referrer-Policy"), "no-referrer")
            self.assertEqual(response.headers.get("Cache-Control"), "no-store")
            for path in ["/call/call.js", "/call/assets/hermes.png"]:
                self.assertEqual((await client.get(path)).status, 200)
            for path in ["/call/package.json", "/call/test/voice-client.test.js", "/.env", "/api/audio/voice-config"]:
                self.assertEqual((await client.get(path)).status, 404)
        finally:
            await client.close()


class PluginRuntimeTests(unittest.TestCase):
    def test_bot_api_response_date_updates_only_the_auth_clock(self):
        from unittest.mock import MagicMock
        from email.utils import formatdate
        observed = []
        response = MagicMock()
        response.__enter__.return_value = response
        response.headers = {"Date": formatdate(1_800_000_046, usegmt=True)}
        response.read.return_value = b'{"ok":true,"result":{"id":9001}}'
        with patch("mobile.voice.hermes_plugin.urllib.request.urlopen", return_value=response):
            self.assertEqual(_telegram("getMe", "test-token", {}, on_server_time=observed.append), {"id":9001})
        self.assertEqual(observed, [1_800_000_046])

    def test_uses_profile_scoped_credentials_storage_and_settings(self):
        with tempfile.TemporaryDirectory() as temp:
            scope = types.ModuleType("agent.secret_scope")
            scope.get_secret = lambda name: {"TELEGRAM_BOT_TOKEN": "own-profile-token", "HERMES_DASHBOARD_SESSION_TOKEN": "own-dashboard-token"}.get(name)
            storage = types.ModuleType("plugins.plugin_storage")
            storage.plugin_data_dir = lambda name: Path(temp) / name
            class Context:
                profile_name = "other-profile"
                def get_config(self, key, default=None):
                    return {"app_url": "https://other.example.test/call", "port": 8877}.get(key, default)
                def inject_message(self, *args, **kwargs): return True
                def on_unload(self, callback): self.cleanup = callback
            ctx = Context()
            with patch.dict(sys.modules, {"agent.secret_scope": scope, "plugins.plugin_storage": storage}), patch.dict(
                os.environ, {"TELEGRAM_BOT_TOKEN": "wrong-launch-profile", "HERMES_HOME": "/wrong-home"}
            ), patch("mobile.voice.hermes_plugin.BrokerListener") as listener:
                plugin = MobileVoicePlugin(ctx)
                self.assertIsNone(plugin.broker)
                listener.assert_not_called()
                plugin.start()
            self.assertEqual(plugin.bot_token, "own-profile-token")
            self.assertEqual(plugin.broker.audio.session_token, "own-dashboard-token")
            self.assertEqual(plugin.broker.audio.profile, "other-profile")
            self.assertEqual(plugin.broker.db.path, Path(temp) / "mobile-voice/voice.sqlite3")
            self.assertEqual(listener.call_args.kwargs["port"], 8877)
            self.assertEqual(listener.call_args.kwargs["host"], "127.0.0.1")
            self.assertEqual(ctx.cleanup, plugin.close)

    def test_listener_unload_releases_socket_for_reload(self):
        with tempfile.TemporaryDirectory() as temp:
            broker = VoiceBroker(bot_token="test", db_path=Path(temp)/"voice.db", audio=FakeAudio(),
                                 inject=lambda *_: True, app_url="https://voice.example.test/call")
            import socket
            with socket.socket() as probe:
                probe.bind(("127.0.0.1", 0))
                port = probe.getsockname()[1]
            listener = BrokerListener(broker, port=port)
            listener.start()
            listener.stop()
            replacement = BrokerListener(broker, port=port)
            replacement.start()
            replacement.stop()
            self.assertFalse(listener._thread.is_alive())
            self.assertFalse(replacement._thread.is_alive())


class HermesAudioAdapterTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.requests = []
        app = web.Application()

        async def record(request):
            body = await request.json() if request.can_read_body else None
            self.requests.append((request.method, request.path, request.query.get("profile"), dict(request.headers), body))
            if request.path == "/api/audio/voice-config":
                return web.json_response({
                    "ok": True,
                    "stt": {"provider": "configured-stt", "model": "configured-model", "api_key": "must-not-leak"},
                    "tts": {"provider": "configured-tts", "voice": "configured-voice", "api_key": "must-not-leak"},
                })
            if request.path == "/api/audio/transcribe":
                return web.json_response({"ok": True, "transcript": "spoken request"})
            if request.path == "/api/audio/speak":
                return web.json_response({"ok": True, "data_url": "data:audio/wav;base64,aGVsbG8=", "mime_type": "audio/wav"})
            return web.json_response({"ok": False}, status=404)

        app.router.add_route("*", "/api/audio/{name}", record)
        self.client = TestClient(TestServer(app))
        await self.client.start_server()
        self.adapter = HermesAudio(str(self.client.make_url("/")), "dashboard-secret", profile="default")

    async def asyncTearDown(self):
        await self.client.close()

    async def test_rejects_remote_cleartext_dashboard_base(self):
        for base in ("http://192.0.2.10:9119", "http://dashboard.example.test", "ftp://127.0.0.1"):
            with self.assertRaises(ValueError):
                HermesAudio(base, "token")
        for base in ("http://127.0.0.1:9119", "http://localhost:9119", "https://dashboard.example.test"):
            HermesAudio(base, "token")

    async def test_capability_lookups_are_cached_briefly(self):
        await self.adapter.capabilities()
        await self.adapter.capabilities()
        self.assertEqual(len(self.requests), 1)

    async def test_uses_dashboard_session_auth_and_configured_speech_contract(self):
        capabilities = await self.adapter.capabilities()
        self.assertTrue(capabilities["ready"])
        self.assertEqual(capabilities["stt"]["provider"], "configured-stt")
        self.assertEqual(capabilities["tts"]["voice"], "configured-voice")
        self.assertNotIn("api_key", json.dumps(capabilities))

        self.assertEqual(await self.adapter.transcribe(b"audio", "audio/webm"), "spoken request")
        audio, mime = await self.adapter.synthesize("Hermes reply")
        self.assertEqual((audio, mime), (b"hello", "audio/wav"))
        self.assertEqual([row[1] for row in self.requests], [
            "/api/audio/voice-config", "/api/audio/transcribe", "/api/audio/speak",
        ])
        for _method, _path, profile, headers, _body in self.requests:
            self.assertEqual(profile, "default")
            self.assertEqual(headers.get("X-Hermes-Session-Token"), "dashboard-secret")
            self.assertNotIn("Authorization", headers)
        self.assertEqual(self.requests[1][4]["mime_type"], "audio/webm")
        self.assertEqual(self.requests[2][4]["text"], "Hermes reply")


if __name__ == "__main__":
    unittest.main()

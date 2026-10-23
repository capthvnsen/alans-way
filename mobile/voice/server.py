"""Same-origin Mini App HTTP protocol for authenticated, configured voice turns.

The gateway plugin starts this listener on loopback. Put it behind the
operator's HTTPS reverse proxy beside the static Mini App; never expose the
listener directly to the Internet.
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import re
import secrets
import threading
import time
import urllib.parse
from pathlib import Path
from typing import Callable

from aiohttp import ClientSession, ClientTimeout, web

from .protocol import LaunchBinding, LaunchTicketStore, TurnRegistry, verify_telegram_init_data

log = logging.getLogger(__name__)
MAX_AUDIO_BYTES = 10 * 1024 * 1024
TURN_ID_RE = re.compile(r"^[0-9a-fA-F-]{36}$")


class HermesAudio:
    """Calls Hermes' authenticated profile-scoped speech endpoints.

    Hermes resolves providers, fallbacks, voices and credentials. This bridge
    never chooses a speech provider or gives provider credentials to the phone.
    """

    def __init__(self, base_url: str, session_token: str, *, profile: str = ""):
        self.base_url = base_url.rstrip("/")
        self.session_token = session_token
        self.profile = profile

    @property
    def available(self) -> bool:
        return bool(self.base_url and self.session_token)

    def _url(self, path: str) -> str:
        suffix = f"?profile={urllib.parse.quote(self.profile, safe='')}" if self.profile else ""
        return f"{self.base_url}{path}{suffix}"

    async def _request_json(self, method: str, path: str, *, payload: dict | None = None) -> dict:
        if not self.available:
            raise RuntimeError("Hermes audio API is not configured")
        timeout = ClientTimeout(total=90, connect=5)
        async with ClientSession(timeout=timeout) as session:
            async with session.request(
                method, self._url(path), json=payload,
                headers={"X-Hermes-Session-Token": self.session_token},
            ) as response:
                body = await response.read()
                if response.status >= 400:
                    raise RuntimeError(f"Hermes audio endpoint returned HTTP {response.status}")
                try:
                    return json.loads(body)
                except (json.JSONDecodeError, UnicodeDecodeError) as exc:
                    raise RuntimeError("Hermes audio endpoint returned invalid JSON") from exc

    async def capabilities(self) -> dict:
        if not self.available:
            return {"ready": False, "reason": "Hermes audio API is not configured"}
        try:
            config = await self._request_json("GET", "/api/audio/voice-config")
        except Exception as exc:
            log.info("Hermes voice capability check failed: %s", type(exc).__name__)
            return {"ready": False, "reason": "Hermes voice configuration is unavailable"}

        def describe(value):
            if not isinstance(value, dict):
                return {"mode": "unavailable"}
            # Deliberately expose labels only. Never forward keys, URLs, headers,
            # credential source paths, or any unrecognized config fields.
            return {
                "mode": str(value.get("mode") or "configured")[:32],
                "provider": str(value.get("provider") or value.get("provider_id") or "")[:80],
                "model": str(value.get("model") or "")[:120],
                "voice": str(value.get("voice") or "")[:80],
            }

        return {
            "ready": bool(config.get("ok")),
            "mode": "chained",
            "stt": describe(config.get("stt")),
            "tts": describe(config.get("tts")),
            "realtime": {"ready": False, "reason": "not implemented by this bridge"},
        }

    async def transcribe(self, audio: bytes, mime: str) -> str:
        data_url = f"data:{mime};base64,{base64.b64encode(audio).decode('ascii')}"
        result = await self._request_json(
            "POST", "/api/audio/transcribe",
            payload={"data_url": data_url, "mime_type": mime},
        )
        if not result.get("ok"):
            raise RuntimeError("Hermes transcription did not complete")
        return str(result.get("transcript") or "").strip()

    async def synthesize(self, text: str) -> tuple[bytes, str]:
        result = await self._request_json("POST", "/api/audio/speak", payload={"text": text})
        data_url = str(result.get("data_url") or "")
        if not result.get("ok") or not data_url.startswith("data:") or ";base64," not in data_url:
            raise RuntimeError("Hermes speech synthesis did not return audio")
        header, encoded = data_url.split(",", 1)
        try:
            audio = base64.b64decode(encoded, validate=True)
        except ValueError as exc:
            raise RuntimeError("Hermes speech synthesis returned invalid audio") from exc
        return audio, str(result.get("mime_type") or header[5:].split(";", 1)[0] or "audio/mpeg")


class VoiceBroker:
    def __init__(
        self,
        *,
        bot_token: str,
        db_path: Path,
        audio: HermesAudio,
        inject: Callable[[str, str], bool],
        app_url: str,
        get_bot_id: Callable[[], str] | None = None,
        send_transcript: Callable[[LaunchBinding, str], bool] | None = None,
        call_ttl_seconds: int = 3600,
        turn_timeout_seconds: int = 180,
    ):
        self.bot_token = bot_token
        self.db = LaunchTicketStore(db_path)
        self.turns = TurnRegistry(db_path)
        # Close out orphaned work from a previous gateway process as explicitly
        # uncertain. The public hook cannot tell us whether an interrupted
        # accepted request already reached the model, so it must never replay.
        self.turns.recover_pending()
        self.audio = audio
        self.inject = inject
        self.app_url = app_url.rstrip("/")
        self.get_bot_id = get_bot_id
        self.send_transcript = send_transcript
        self._expected_bot_id = ""
        self.call_ttl_seconds = call_ttl_seconds
        self.turn_timeout_seconds = turn_timeout_seconds
        self._tasks: set[asyncio.Task] = set()
        self._telegram_time_anchor: tuple[float, float] | None = None

    def observe_telegram_time(self, epoch: float):
        # Bot API is reached over verified HTTPS. Its response Date gives us
        # Telegram's time even when a VM's clock drifts behind the phone.
        # Monotonic elapsed time preserves freshness if the host clock moves.
        import math
        if not math.isfinite(epoch) or abs(epoch - time.time()) > 300:
            raise ValueError("Telegram and host clocks differ by more than five minutes")
        self._telegram_time_anchor = (epoch, time.monotonic())

    def auth_time(self) -> float:
        if self._telegram_time_anchor:
            epoch, observed = self._telegram_time_anchor
            return epoch + (time.monotonic() - observed)
        return time.time()

    def issue_launch_ticket(self, binding: LaunchBinding) -> str:
        if not self.app_url.startswith("https://"):
            raise ValueError("HERMES_VOICE_APP_URL must use HTTPS")
        return self.db.issue(binding)

    def app_link(self, ticket: str) -> str:
        return f"{self.app_url}/?ticket={urllib.parse.quote(ticket, safe='')}"

    def _auth_call(self, request: web.Request) -> tuple[str, LaunchBinding] | None:
        call_id = request.match_info.get("call_id", "")
        header = request.headers.get("Authorization", "")
        scheme, _, token = header.partition(" ")
        if scheme.lower() != "bearer" or not token:
            return None
        binding = self.db.get_call(call_id, token)
        return (token, binding) if binding else None

    async def capabilities(self, _request: web.Request) -> web.Response:
        result = await self.audio.capabilities()
        status = 200 if result["ready"] else 503
        return web.json_response({"version": 1, **result}, status=status,
                                 headers={"Cache-Control": "no-store"})

    async def create_call(self, request: web.Request) -> web.Response:
        try:
            body = await request.json()
        except (json.JSONDecodeError, ValueError):
            raise web.HTTPBadRequest(text="Expected JSON")
        if not isinstance(body, dict):
            raise web.HTTPBadRequest(text="Expected JSON object")
        identity = verify_telegram_init_data(str(body.get("init_data") or ""), self.bot_token, now=self.auth_time())
        if not identity:
            raise web.HTTPUnauthorized(text="Invalid or expired Telegram launch data")
        if self.get_bot_id:
            if not self._expected_bot_id:
                try:
                    self._expected_bot_id = str(await asyncio.to_thread(self.get_bot_id))
                except Exception:
                    return web.json_response({"error": "Telegram bot identity is unavailable"}, status=503)
        capabilities = await self.audio.capabilities()
        if not capabilities["ready"]:
            return web.json_response({"error": "configured Hermes speech is unavailable"}, status=503)
        binding = self.db.consume(str(body.get("launch_ticket") or ""), user_id=identity["user_id"])
        if not binding:
            raise web.HTTPForbidden(text="Launch ticket is invalid, expired, or belongs to another Telegram user")
        if self._expected_bot_id and not secrets.compare_digest(binding.bot_id, self._expected_bot_id):
            raise web.HTTPForbidden(text="Launch ticket belongs to a different Telegram bot")
        call_id, token = secrets.token_urlsafe(24), secrets.token_urlsafe(32)
        self.db.create_call(call_id, token, binding, ttl_seconds=self.call_ttl_seconds)
        return web.json_response({
            "call_id": call_id,
            "access_token": token,
            "expires_in": self.call_ttl_seconds,
            "capabilities": capabilities,
        }, headers={"Cache-Control": "no-store"})

    async def submit_turn(self, request: web.Request) -> web.Response:
        authorized = self._auth_call(request)
        if not authorized:
            raise web.HTTPUnauthorized(text="Invalid call credential")
        _, binding = authorized
        call_id = request.match_info["call_id"]
        reader = await request.multipart()
        turn_id, mime = "", "audio/webm"
        audio = b""
        while part := await reader.next():
            if part.name == "turn_id":
                turn_id = (await part.text()).strip()
            elif part.name in ("mime_type", "content_type"):
                mime = (await part.text()).strip().split(";", 1)[0] or mime
            elif part.name == "audio":
                mime = (part.headers.get("Content-Type") or mime).split(";", 1)[0]
                chunks = []
                total = 0
                while chunk := await part.read_chunk(64 * 1024):
                    total += len(chunk)
                    if total > MAX_AUDIO_BYTES:
                        raise web.HTTPRequestEntityTooLarge(max_size=MAX_AUDIO_BYTES, actual_size=total)
                    chunks.append(chunk)
                audio = b"".join(chunks)
        if not TURN_ID_RE.fullmatch(turn_id):
            raise web.HTTPBadRequest(text="turn_id must be a UUID")
        if not audio or not mime.startswith("audio/"):
            raise web.HTTPBadRequest(text="Audio recording is required")

        try:
            transcript = await self.audio.transcribe(audio, mime)
        except Exception as exc:
            log.warning("Voice transcription failed: %s", type(exc).__name__)
            return web.json_response({"error": "configured Hermes transcription failed"}, status=502)
        # Transcription yields to other requests. Hangup, expiry, or a session
        # reset may revoke the call while speech is being transcribed.
        if not self._auth_call(request):
            raise web.HTTPUnauthorized(text="Call ended during transcription")
        if not transcript:
            return web.json_response({"error": "No speech detected"}, status=422)

        try:
            turn, created = self.turns.create(call_id, turn_id, transcript, binding.session_key)
        except ValueError:
            raise web.HTTPConflict(text="turn_id was already used for different turn content")
        if created:
            # The canonical Hermes user turn and assistant response remain in
            # the existing session. This separate, clearly labeled bot bubble
            # makes the spoken input visible in Telegram exactly once.
            accepted = False
            try:
                accepted = bool(self.inject(turn.injected_text, binding.session_key))
            except Exception:
                log.exception("Hermes gateway injection raised")
            if not accepted:
                self.turns.fail(call_id, turn_id, "Hermes refused gateway injection")
                return web.json_response({"error": "Hermes gateway refused this turn"}, status=503)
            if self.send_transcript and self.turns.claim_transcript_delivery(call_id, turn_id):
                try:
                    delivered = await asyncio.to_thread(
                        self.send_transcript, binding, transcript
                    )
                    if not delivered:
                        log.warning("Could not deliver Telegram voice transcript bubble")
                except Exception:
                    log.exception("Telegram voice transcript delivery raised")
            task = asyncio.create_task(self._finish_turn(call_id, turn_id))
            self._tasks.add(task)
            task.add_done_callback(self._tasks.discard)
            turn = self.turns.get(call_id, turn_id) or turn
        return web.json_response(self._turn_json(turn), status=202, headers={"Cache-Control": "no-store"})

    async def _finish_turn(self, call_id: str, turn_id: str) -> None:
        deadline = asyncio.get_running_loop().time() + self.turn_timeout_seconds
        while asyncio.get_running_loop().time() < deadline:
            await asyncio.sleep(0.2)
            turn = self.turns.get(call_id, turn_id)
            if not turn:
                return
            if turn.status == "failed":
                return
            if turn.status == "synthesizing":
                try:
                    audio, mime = await self.audio.synthesize(turn.reply_text)
                    self.turns.complete_audio(call_id, turn_id, audio, mime)
                except Exception as exc:
                    log.warning("Voice synthesis failed: %s", type(exc).__name__)
                    self.turns.fail(call_id, turn_id, "Configured Hermes speech synthesis failed")
                return
            # A post-LLM failure/timeout has no terminal public hook. We report
            # uncertainty instead of silently leaving the app polling forever.
        self.turns.fail(
            call_id, turn_id,
            "Timed out waiting for Hermes final-turn hook; execution status may be unknown and was not replayed",
        )

    async def turn_status(self, request: web.Request) -> web.Response:
        if not self._auth_call(request):
            raise web.HTTPUnauthorized(text="Invalid call credential")
        turn = self.turns.get(request.match_info["call_id"], request.match_info["turn_id"])
        if not turn:
            raise web.HTTPNotFound(text="Unknown turn")
        return web.json_response(self._turn_json(turn), headers={"Cache-Control": "no-store"})

    async def turn_audio(self, request: web.Request) -> web.Response:
        if not self._auth_call(request):
            raise web.HTTPUnauthorized(text="Invalid call credential")
        audio = self.turns.get_audio(request.match_info["call_id"], request.match_info["turn_id"])
        if not audio:
            raise web.HTTPNotFound(text="Turn audio is not ready")
        blob, mime = audio
        return web.Response(body=blob, content_type=mime, headers={
            "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
        })

    async def close_call(self, request: web.Request) -> web.Response:
        authorized = self._auth_call(request)
        if not authorized:
            raise web.HTTPUnauthorized(text="Invalid call credential")
        token, _ = authorized
        self.db.close_call(request.match_info["call_id"], token)
        return web.json_response({"call_id": request.match_info["call_id"], "status": "closed"})

    async def interrupt_playback(self, request: web.Request) -> web.Response:
        if not self._auth_call(request):
            raise web.HTTPUnauthorized(text="Invalid call credential")
        call_id, turn_id = request.match_info["call_id"], request.match_info["turn_id"]
        if not self.turns.interrupt_playback(call_id, turn_id):
            raise web.HTTPNotFound(text="Unknown turn")
        return web.json_response({
            "call_id": call_id,
            "turn_id": turn_id,
            "playback_interrupted": True,
            "agent_work": "continues",
        })

    @staticmethod
    def _turn_json(turn) -> dict:
        out = {"call_id": turn.call_id, "turn_id": turn.turn_id, "status": turn.status}
        if turn.status in ("synthesizing", "completed"):
            out.update({"transcript": turn.transcript, "reply_text": turn.reply_text})
        if turn.status == "completed":
            out["audio_url"] = f"/v1/calls/{turn.call_id}/turns/{turn.turn_id}/audio"
        if turn.error:
            out["error"] = turn.error
        return out

    def build_app(self, *, miniapp_dir: Path | None = None) -> web.Application:
        app = web.Application(client_max_size=MAX_AUDIO_BYTES + 256 * 1024)
        async def private_headers(_request, response):
            response.headers.update({"Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
                                     "X-Content-Type-Options": "nosniff", "Permissions-Policy": "microphone=(self), camera=()"})
        app.on_response_prepare.append(private_headers)
        app.router.add_get("/v1/capabilities", self.capabilities)
        app.router.add_post("/v1/calls", self.create_call)
        app.router.add_delete("/v1/calls/{call_id}", self.close_call)
        app.router.add_post("/v1/calls/{call_id}/turns", self.submit_turn)
        app.router.add_get("/v1/calls/{call_id}/turns/{turn_id}", self.turn_status)
        app.router.add_get("/v1/calls/{call_id}/turns/{turn_id}/audio", self.turn_audio)
        app.router.add_post("/v1/calls/{call_id}/turns/{turn_id}/interrupt", self.interrupt_playback)
        if miniapp_dir:
            root = Path(miniapp_dir).resolve(strict=True)
            allowed = {"index.html", "call.js", "call.css", "voice-client.js", "lifecycle.js"}
            allowed.update("assets/" + name + ".png" for name in
                           ["hermes", "zeus", "artemis", "medusa", "apollo", "poseidon", "hades", "faun", "minotaur", "athena"])
            async def static(request):
                name = request.match_info.get("asset", "") or "index.html"
                if name not in allowed:
                    raise web.HTTPNotFound()
                path = (root / name).resolve()
                if not path.is_relative_to(root) or not path.is_file():
                    raise web.HTTPNotFound()
                return web.FileResponse(path)
            app.router.add_get("/call", static)
            app.router.add_get("/call/{asset:.*}", static)
        return app


class BrokerListener:
    """Run aiohttp on loopback in a daemon thread owned by the gateway plugin."""

    def __init__(self, broker: VoiceBroker, host: str = "127.0.0.1", port: int = 8765, *, miniapp_dir: Path | None = None):
        self.broker, self.host, self.port = broker, host, int(port)
        self.miniapp_dir = miniapp_dir
        self._ready = threading.Event()
        self._error: BaseException | None = None
        self._runner: web.AppRunner | None = None
        self._loop = None
        self._shutdown = None
        self._thread = threading.Thread(target=self._run, name="hermes-voice-http", daemon=True)

    def start(self) -> None:
        self._thread.start()
        if not self._ready.wait(10):
            raise RuntimeError("Voice broker listener did not start")
        if self._error:
            raise RuntimeError("Voice broker listener failed") from self._error

    def _run(self) -> None:
        async def serve():
            self._loop = asyncio.get_running_loop()
            self._shutdown = asyncio.Event()
            self._runner = web.AppRunner(self.broker.build_app(miniapp_dir=self.miniapp_dir), access_log=None)
            await self._runner.setup()
            site = web.TCPSite(self._runner, self.host, self.port)
            try:
                await site.start()
                self._ready.set()
                await self._shutdown.wait()
            finally:
                await self._runner.cleanup()

        try:
            asyncio.run(serve())
        except BaseException as exc:
            self._error = exc
            self._ready.set()

    def stop(self):
        if self._loop and self._shutdown and self._loop.is_running():
            self._loop.call_soon_threadsafe(self._shutdown.set)
            self._thread.join(timeout=10)

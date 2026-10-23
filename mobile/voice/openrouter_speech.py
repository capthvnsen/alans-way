"""OpenRouter speech through Hermes' public provider extension interfaces."""
from __future__ import annotations

import base64
import json
import urllib.error
import urllib.request
from pathlib import Path

STT_MODEL = "openai/whisper-large-v3-turbo"
TTS_MODEL = "canopylabs/orpheus-3b-0.1-ft"
TTS_VOICE = "leo"
PROVIDER = "openrouter-voice"
MAX_AUDIO_BYTES = 15 * 1024 * 1024


class OpenRouterSpeech:
    def __init__(self, key_getter, *, base_url="https://openrouter.ai/api/v1"):
        self.key_getter = key_getter
        self.base_url = base_url.rstrip("/")

    def _request(self, route, payload):
        key = self.key_getter()
        if not key:
            raise RuntimeError("Set OPENROUTER_API_KEY for this Hermes profile")
        request = urllib.request.Request(
            self.base_url + route, data=json.dumps(payload).encode(),
            headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                data = response.read(30 * 1024 * 1024 + 1)
                if not data or len(data) > 30 * 1024 * 1024:
                    raise RuntimeError("OpenRouter speech returned empty or oversized output")
                return data
        except urllib.error.HTTPError as exc:
            # Provider bodies can echo request metadata. Never forward them or
            # the request URL/headers into Hermes logs or the Telegram chat.
            status = exc.code
            exc.close()
            raise RuntimeError(f"OpenRouter speech returned HTTP {status}") from None
        except urllib.error.URLError:
            raise RuntimeError("OpenRouter speech could not be reached") from None

    def synthesize(self, text, output_path, *, voice=None, model=None, speed=None, format="mp3", **_extra):
        payload = {"model": model or TTS_MODEL, "voice": voice or TTS_VOICE,
                   "input": text, "response_format": format}
        if speed is not None:
            payload["speed"] = speed
        data = self._request("/audio/speech", payload)
        Path(output_path).write_bytes(data)
        return str(output_path)

    def transcribe(self, file_path, *, model=None, language=None, **_extra):
        try:
            path = Path(file_path)
            if path.stat().st_size > MAX_AUDIO_BYTES:
                raise RuntimeError("Audio exceeds the voice upload limit")
            data = path.read_bytes()
            payload = {"model": model or STT_MODEL,
                       "input_audio": {"data": base64.b64encode(data).decode(), "format": path.suffix.lstrip(".").lower() or "wav"}}
            if language:
                payload["language"] = language
            result = json.loads(self._request("/audio/transcriptions", payload))
            if not isinstance(result.get("text"), str):
                raise RuntimeError("OpenRouter transcription returned no text")
            return {"success": True, "transcript": result["text"].strip(), "provider": PROVIDER}
        except Exception as exc:
            message = str(exc) if isinstance(exc, RuntimeError) else "OpenRouter transcription failed"
            return {"success": False, "transcript": "", "provider": PROVIDER, "error": message}


def register_speech_providers(ctx):
    from agent.secret_scope import get_secret
    from agent.tts_provider import TTSProvider
    from agent.transcription_provider import TranscriptionProvider

    speech = OpenRouterSpeech(lambda: get_secret("OPENROUTER_API_KEY") or "")

    class OpenRouterTTS(TTSProvider):
        name = PROVIDER
        display_name = "OpenRouter Voice"
        voice_compatible = True
        def is_available(self):
            return bool(get_secret("OPENROUTER_API_KEY"))
        def default_model(self):
            return TTS_MODEL
        def default_voice(self):
            return TTS_VOICE
        def synthesize(self, text, output_path, **kwargs):
            return speech.synthesize(text, output_path, **kwargs)

    class OpenRouterSTT(TranscriptionProvider):
        name = PROVIDER
        display_name = "OpenRouter Voice"
        def is_available(self):
            return bool(get_secret("OPENROUTER_API_KEY"))
        def default_model(self):
            return STT_MODEL
        def transcribe(self, file_path, **kwargs):
            return speech.transcribe(file_path, **kwargs)

    ctx.register_tts_provider(OpenRouterTTS())
    ctx.register_transcription_provider(OpenRouterSTT())

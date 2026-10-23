"""Installable Hermes general plugin that owns Mini App launch and voice turns."""
from __future__ import annotations

import asyncio
import json
import logging
import os
from email.utils import parsedate_to_datetime
import urllib.error
import urllib.request
from pathlib import Path

from .protocol import LaunchBinding
from .server import BrokerListener, HermesAudio, VoiceBroker

log = logging.getLogger(__name__)
PLUGIN_ID = "mobile-voice"


def _session_env(name: str, default: str = "") -> str:
    # Hermes documents this helper as the replacement for reading HERMES_SESSION_*
    # directly. Keeping this import local lets `hermes plugins doctor` validate
    # registration with a light-weight context.
    try:
        from gateway.session_context import get_session_env
        return str(get_session_env(name, default) or default)
    except (ImportError, RuntimeError):
        return default


def _telegram(method: str, token: str, payload: dict, timeout: float = 10, *, on_server_time=None) -> dict:
    request = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/{method}",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            if on_server_time and response.headers.get("Date"):
                on_server_time(parsedate_to_datetime(response.headers["Date"]).timestamp())
            result = json.loads(response.read())
    except (OSError, urllib.error.URLError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Telegram {method} request failed") from exc
    if not result.get("ok"):
        raise RuntimeError(f"Telegram {method} request was rejected")
    return result.get("result") or {}


def _secret(name: str) -> str:
    # Public, profile-scoped API: os.environ belongs to the launch profile in
    # a multiplex gateway. Never fall back after a scoped lookup fails.
    from agent.secret_scope import get_secret
    return str(get_secret(name) or "").strip()


def _plugin_home() -> Path:
    from plugins.plugin_storage import plugin_data_dir
    path = plugin_data_dir(PLUGIN_ID)
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        path.chmod(0o700)
    except OSError:
        pass
    return path


class MobileVoicePlugin:
    def __init__(self, ctx):
        self.ctx = ctx
        self.bot_token = ""
        self.app_url = str(ctx.get_config("app_url", default="") or "").strip().rstrip("/")
        self.api_base = str(ctx.get_config("dashboard_api_base", default="http://127.0.0.1:9119")).strip().rstrip("/")
        self.api_key = ""
        self.profile = str(getattr(ctx, "profile_name", None) or os.environ.get("HERMES_PROFILE") or "default").strip()
        self.db_path = _plugin_home() / "voice.sqlite3"
        self.port = int(ctx.get_config("port", default=8765))
        self.miniapp_dir = ctx.get_config("miniapp_dir", default="")
        self.turn_timeout = int(ctx.get_config("turn_timeout", default=180))
        self.listener = None
        self.broker = None
        ctx.on_unload(self.close)

    def start(self):
        """Start only from a verified gateway command, with its secret scope.

        Dashboard/CLI plugin discovery must never reserve the gateway socket
        or capture credentials from an unscoped multiplex loader.
        """
        if self.broker:
            return
        self.bot_token = _secret("TELEGRAM_BOT_TOKEN")
        self.api_key = _secret("HERMES_DASHBOARD_SESSION_TOKEN")
        if self.bot_token and self.app_url and self.api_key:
            self.broker = VoiceBroker(
                bot_token=self.bot_token,
                db_path=self.db_path,
                audio=HermesAudio(self.api_base, self.api_key, profile=self.profile),
                get_bot_id=lambda: str(_telegram("getMe", self.bot_token, {}).get("id") or ""),
                send_transcript=lambda binding, transcript: bool(_telegram(
                    "sendMessage", self.bot_token, {
                        "chat_id": binding.chat_id,
                        "text": "🎙 Voice transcript:\n" + transcript[:3500],
                    },
                )),
                inject=lambda content, key: self.ctx.inject_message(
                    content, role="user", session_key=key
                ),
                app_url=self.app_url,
                turn_timeout_seconds=self.turn_timeout,
            )
            self.broker.db.invalidate_all()
            self.listener = BrokerListener(
                self.broker,
                host="127.0.0.1",
                port=self.port,
                miniapp_dir=Path(self.miniapp_dir) if self.miniapp_dir else None,
            )
            try:
                self.listener.start()
            except Exception:
                self.broker = None
                raise
            log.info("Mobile voice broker listening on %s:%s", self.listener.host, self.listener.port)

    def close(self):
        if self.listener:
            self.listener.stop()
        self.broker = None
        self.listener = None

    async def call_command(self, _raw_args: str = "") -> str:
        """Post an inline Mini App button bound to this exact Telegram DM session."""
        platform = _session_env("HERMES_SESSION_PLATFORM")
        chat_type = _session_env("HERMES_SESSION_CHAT_TYPE").lower()
        chat_id = _session_env("HERMES_SESSION_CHAT_ID")
        user_id = _session_env("HERMES_SESSION_USER_ID")
        session_key = _session_env("HERMES_SESSION_KEY")
        session_generation = _session_env("HERMES_SESSION_ID")
        session_profile = _session_env("HERMES_SESSION_PROFILE", self.profile)
        if platform != "telegram" or chat_type not in {"private", "dm"}:
            return "Run /call inside a private Telegram chat with this bot."
        if session_profile != self.profile:
            return "This call button belongs to a different Hermes profile."
        if not chat_id or not user_id or chat_id != user_id or not session_key:
            return "This Telegram session has no verified private-chat binding."
        try:
            self.start()
            if not self.broker or not self.bot_token:
                return "Voice calling is not configured for this Hermes profile."
            bot = await asyncio.to_thread(_telegram, "getMe", self.bot_token, {},
                                          on_server_time=self.broker.observe_telegram_time)
            binding = LaunchBinding(
                profile=self.profile,
                bot_id=str(bot.get("id") or ""),
                user_id=user_id,
                chat_id=chat_id,
                session_key=session_key,
                thread_id=_session_env("HERMES_SESSION_THREAD_ID") or None,
                session_generation=session_generation,
            )
            if not binding.bot_id:
                return "Telegram did not return this bot's identity."
            ticket = self.broker.issue_launch_ticket(binding)
            link = self.broker.app_link(ticket)
            await asyncio.to_thread(_telegram, "sendMessage", self.bot_token, {
                "chat_id": chat_id,
                "text": "📞 Your voice call is ready. Open it to speak with this conversation.",
                "reply_markup": {"inline_keyboard": [[{
                    "text": "📞 Call",
                    "web_app": {"url": link},
                }]]},
            })
        except Exception as exc:
            log.warning("Could not post Telegram voice button: %s", type(exc).__name__)
            return "Could not prepare the call button. Check the mobile voice service configuration."
        return ""

    def on_turn_end(self, user_message=None, assistant_response=None, **_kwargs):
        if not self.broker or not isinstance(user_message, str):
            return
        session_key = _session_env("HERMES_SESSION_KEY")
        if not session_key:
            return
        self.broker.turns.capture(session_key, user_message, str(assistant_response or ""))

    def on_session_reset(self, session_id=None, **kwargs):
        if self.broker:
            self.broker.db.invalidate_all()


def register(ctx):
    from .openrouter_speech import register_speech_providers
    register_speech_providers(ctx)
    plugin = MobileVoicePlugin(ctx)
    ctx.register_command(
        "call", plugin.call_command,
        description="Open a voice call in a Telegram Mini App for this chat",
    )
    ctx.register_hook("post_llm_call", plugin.on_turn_end)
    ctx.register_hook("on_session_reset", plugin.on_session_reset)

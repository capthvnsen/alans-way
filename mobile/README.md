# Mobile voice bridge

This directory supports the **Alan's Workspace iOS app** within [Alan's Way's four-product model](../README.md#what-to-install). It is not the main **Alan's Plugin for Hermes** product in [alans-way-agents](https://github.com/capthvnsen/alans-way-agents), and is not a Grok Bot package. Install the voice broker on the existing Hermes gateway host and the Mini App as described below; build the native client from [`ios/`](../ios/README.md). The two main agent plugins share one persona/voice/proactivity/identity spec in the agents repo; this bridge uses the active Hermes profile's speech settings. See [boundaries/TODOs](../docs/products.md) and [MIT license and dependency notices](../docs/licensing.md). Help: [Discord](https://discord.gg/jBQCPUsVE) · [openalan.com](https://openalan.com).

`voice/` is an installable Hermes general plugin and its same-process HTTP broker. It lets the Telegram Mini App capture a short voice turn, passes the recording through the active Hermes profile's configured speech endpoints, admits the transcript to the exact existing Telegram conversation through the public plugin injection API, and speaks the final response using Hermes' configured TTS. It does not start a second agent or send a second Telegram reply.

Tap **Start call** once, allow the microphone, and speak hands-free. The screen moves through **Listening**, **Hearing you**, **Thinking**, and **Speaking**, then returns directly to listening when the reply ends. **Mute** disables the microphone track and discards partial speech; **Stop reply** remains available during playback. The microphone meter shows input activity, and a silent input produces feedback instead of appearing to work.

Continuous WebAudio capture uses an adaptive energy threshold above the ambient noise floor, keeps 250 ms of pre-roll, and submits after 800 ms of silence. A turn needs at least 280 ms of detected speech and is capped at 25 seconds, plus pre-roll and at most one capture frame. The 25 second cap splits very long speech into separate turns. Speech while **Thinking** is ignored. The bounded float samples become a mono 16-bit WAV upload, avoiding incomplete MediaRecorder segments at turn boundaries. The capture graph stays connected to a silent output node for WebKit. Capture currently uses ScriptProcessor on the main thread; AudioWorklet migration needs validation against the supported iOS hosts.

Echo cancellation, noise suppression, and automatic gain control are requested by default. During playback, speech must exceed both the ambient threshold and a conservative barge-in threshold (RMS 0.055, four times the noise floor, or 1.5 times current playback energy, whichever is greatest). At least 170 ms of consecutive speech above that threshold stops local audio and keeps the captured speech. The old turn is marked interrupted at the broker only after 280 ms of detected speech. For 500 ms after playback ends, the playback threshold still applies and the noise floor does not adapt. Disabling echo control raises the minimum playback threshold to RMS 0.09 and the playback energy multiplier to 2. The old turn cannot be played again, including after late TTS completion. This stops speech delivery; accepted agent work and its reply still continue in the Telegram conversation. Speaker volume, room noise, and microphone processing can affect detection, so verify thresholds on actual devices and try headphones when needed.

The transport still uploads complete utterances and downloads complete synthesized replies. Status polling every 250 ms shows reply text as soon as the broker receives the final Hermes response, including while TTS is running, and playback begins as soon as the audio is fetched and decoded. A failed speech reply keeps its text in the transcript and returns to listening. Uploads retry a network or 5xx failure once with the same turn ID; polling retries temporary failures. Other turn failures return to listening with a short notice. Authentication or expired-call errors release the call. Provider keys stay on the gateway. `GET /v1/capabilities` reports a secret free summary of Hermes' configured STT/TTS settings and reports realtime mode as unavailable.

Calls are foreground only. Backgrounding, page closure, or screen lock stops playback, releases the microphone, and revokes the call credential. A microphone permission prompt or short host audio interruption keeps the call connected; interrupted partial speech is discarded. Returning from an audio interruption tries to resume the audio context. If the browser blocks it, the screen shows **Tap to resume audio** and the next tap tries again. Ending a call never cancels accepted Hermes work.

## Install on a Hermes gateway

For a local checkout, copy the contents of `mobile/voice/` into the target profile's `plugins/mobile-voice/` directory, excluding Python caches, then run `hermes plugins enable mobile-voice`. Hermes' Git/catalog installer does not accept local directory paths. Its enable command resolves the declared `aiohttp` dependency through the managed environment. Add Hermes' `-p PROFILE` option for a named profile. For local standalone protocol tests, use the isolated virtual environment described below.

The gateway profile needs its normal Telegram bot configuration. Set these values in the gateway service environment:

```sh
TELEGRAM_BOT_TOKEN=<this profile's bot token>
HERMES_DASHBOARD_SESSION_TOKEN=<random stable dashboard token>
```

Configure `app_url`, `port`, and `dashboard_api_base` in this plugin's profile-scoped settings below. The plugin always binds to loopback. Configure an HTTPS reverse proxy or Cloudflare Tunnel to forward `/call/*` and `/v1/*` to that listener. With `miniapp_dir` set, the listener serves only the known Mini App files, with `Referrer-Policy: no-referrer` and `Cache-Control: no-store`; alternatively leave it blank and serve static files through the reverse proxy. The app and API share one origin. Do not expose the dashboard or gateway API through this tunnel. Set the same strong `HERMES_DASHBOARD_SESSION_TOKEN` for the dashboard and gateway profile. The bridge uses `X-Hermes-Session-Token` on loopback; it does not change dashboard authentication. `API_SERVER_KEY` belongs to the separate OpenAI-compatible gateway API and does not authenticate these dashboard routes.

[deploy/Caddyfile.example](deploy/Caddyfile.example) shows the static-site and API routing for one profile. It is an operator template; no proxy, gateway, TLS or BotFather configuration is changed by the iOS build. Give each profile a separate broker port and HTTPS origin, with its own bot token and dashboard scope.

Enable the public gateway injection capability for this trusted plugin in the same profile's `config.yaml`:

```yaml
plugins:
  entries:
    mobile-voice:
      allow_gateway_injection: true
      settings:
        app_url: https://voice.example.net/call
        port: 8765
        dashboard_api_base: http://127.0.0.1:9119
        miniapp_dir: /srv/alans-workspace/mobile/miniapp
```

Hermes disables external plugin injection by default. The gateway still applies its current profile routing and authorization rules when the plugin submits a turn. The authenticated [`/api/audio/voice-config`, `/api/audio/transcribe`, and `/api/audio/speak` routes](https://github.com/NousResearch/hermes-agent/blob/main/hermes_cli/web_routers/audio.py) belong to the Hermes dashboard HTTP server, not the OpenAI-compatible gateway `api_server`. The bridge calls them on loopback with the dashboard session-token header, and Hermes resolves the active profile's configured STT, TTS, voice, and fallback settings. Configure those through Hermes as usual; the Mini App does not select providers. Hermes delivers the answer through the normal Telegram connector and the plugin posts one clearly labeled, silent transcript bubble in the same DM. The plugin uses the documented [general plugin API and message injection contract](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/plugins.md).

After enabling the plugin, run `/call` in the bot's private Telegram conversation. The first verified command starts the listener inside that gateway, under the command's secret scope; dashboard and CLI discovery never start it. The plugin reads the documented current session context, requires a private Telegram DM, uses that existing canonical session key as the binding, and posts a one-use HTTPS Mini App button. Telegram's genuine `initData` is checked on the backend against this bot's token and must match the user in the launch ticket. The ticket expires after five minutes and is consumed once. Hermes currently omits the session-generation ID from slash-command context and the canonical key from reset hooks. Consequently `/new` or `/reset` conservatively retires **all** links and call credentials owned by that profile. Plugin startup also retires persisted credentials, so a reset during downtime cannot leave a stale call valid. If a cached link expires, request `/call` again in the same chat. Group chats are not enabled by this MVP; topic identity is retained in the binding for later support.

The broker's SQLite file is kept beneath the owning profile's `plugin-data/mobile-voice/`, using Hermes' public storage API. It survives plugin updates. It stores one-use launch bindings, expiring call credentials, turn status and completed reply audio. It does not read or write Hermes' session database. Expired calls are rejected; records older than 24 hours are purged on startup and new call creation. Remove the plugin data file through normal operator maintenance when local retention is no longer wanted. Credentials are resolved with Hermes' public `agent.secret_scope.get_secret()` API, never another profile's process environment.

Launch freshness uses the `Date` header from the bot's verified HTTPS `getMe` response, advanced with a monotonic clock. This avoids rejecting fresh phone launches when a VM clock drifts. The HMAC check, ten-minute data age, thirty-second future bound, and one-use ticket checks remain in place; a discrepancy over five minutes between the VM and Telegram prevents launch creation.

## Try it

1. On the existing gateway host, install the plugin and configure the gateway service environment and profile settings above. Set `miniapp_dir` to that host's Mini App directory and configure STT/TTS in the same profile's Hermes dashboard. Restart the existing gateway to load the plugin.
2. Put `https://voice.example.net/call/` and `/v1/*` behind an HTTPS front such as the supplied Caddy example, forwarding only the broker routes to `127.0.0.1:8765`. Telegram requires HTTPS; leave the dashboard and gateway administration private.
3. Send `/call` in the bot's existing private Telegram chat. This starts the broker inside that gateway. On the gateway host, `curl -fsS http://127.0.0.1:8765/v1/capabilities` should now return `{"version":1,"ready":true}`. An unavailable configured speech service returns HTTP 503.
4. Open the fresh Call button in Telegram, tap **Start call**, and allow the mic. Say a sentence, pause, and wait for the spoken reply. Speak over the reply to interrupt it, then pause to send the next turn. Open the transcript to see reply text before audio finishes synthesizing.
5. Check mute/unmute, speaker echo, headphones, a brief audio interruption, and lock/background cleanup. Reopen `/call` after ending the call and confirm the same conversation remembers it. Run these checks in both official Telegram and the iOS companion host.

## OpenRouter speech

The plugin also registers `openrouter-voice` through Hermes' public transcription and TTS provider interfaces. To use it, keep `OPENROUTER_API_KEY` in the owning profile's `.env` or managed secret store, enable the plugin there, and select these native Hermes settings:

```yaml
stt:
  enabled: true
  provider: openrouter-voice
  openrouter-voice:
    model: openai/whisper-large-v3-turbo
    language: en
tts:
  provider: openrouter-voice
  model: canopylabs/orpheus-3b-0.1-ft
  voice: leo
  output_format: mp3
```

These are inexpensive defaults, not a separate conversation agent. Hermes still owns the selected conversation and its reasoning model. OpenRouter handles the audio through its documented `/api/v1/audio/transcriptions` and `/api/v1/audio/speech` endpoints. The key never reaches the Mini App or goes into `config.yaml`. Provider errors expose only safe status messages. Other speech providers continue to work when selected instead. Model availability, provider routing, price, and first-request latency can change; validate real speech after changing models.

## Mini App HTTP protocol

All paths use the Mini App's HTTPS origin. `init_data` must be Telegram's raw `Telegram.WebApp.initData`; clients must not fabricate it. The `launch_ticket` is read from the `/call/?ticket=…` URL.

1. `GET /v1/capabilities` returns readiness plus nonsecret `{mode, stt, tts, realtime}` labels.
2. `POST /v1/calls` with JSON `{ "init_data": "…", "launch_ticket": "…" }` returns `{call_id, access_token, expires_in, capabilities}`. Keep `access_token` in memory only.
3. `POST /v1/calls/{call_id}/turns` uses `Authorization: Bearer <access_token>` and multipart fields `turn_id` (UUID), `audio` (recorded audio file), and optional `mime_type`. It returns `202` with `{call_id, turn_id, status: "accepted", transcript}` after one successful Hermes admission, or `200` with `{call_id, turn_id, status: "ignored", reason: "no_speech"}` without injection. Ignored turns need no polling.
4. Poll `GET /v1/calls/{call_id}/turns/{turn_id}` with the same bearer token. `synthesizing` includes `transcript` and `reply_text`; `completed` also includes `audio_url` unless `playback_interrupted` is true. Show text updates immediately, once per turn.
5. Fetch `GET /v1/calls/{call_id}/turns/{turn_id}/audio` with the bearer token. Fetch with `Authorization` and decode and play the returned audio bytes with WebAudio.
6. `POST /v1/calls/{call_id}/turns/{turn_id}/interrupt` with the same bearer token and an empty body durably suppresses that turn's audio, removes any saved audio, and prevents late synthesis from restoring it. Repeating the request is safe. Unknown turns return 404; invalid UUIDs or nonempty bodies return 400, bodies over 256 bytes return 413, and empty requests work with or without Content-Length. Nonempty chunked bodies are also rejected with the same limits. The client invalidates the old turn before sending this request, so delayed callbacks cannot restart playback. Hermes work continues; its transcript and text reply are retained. `DELETE /v1/calls/{call_id}` revokes the call token. Neither operation cancels an accepted Hermes turn.

Turns are keyed by `(call_id, turn_id)` and the plugin persists the request before injection. A retry with the same ID and transcript returns the current state without injecting again; reusing the ID with different content is a conflict. The post-LLM hook matches the exact session key and unique marker inserted into that request, so a later typed turn or another chat's response cannot complete the voice turn. Successful final replies flow through the normal Hermes Telegram connector once.

If the connection drops, query the turn status. Do not submit the utterance under a new ID to recover an uncertain turn. The broker marks `accepted` or `synthesizing` turns as failed with an explicit unknown-execution reason after a gateway restart; it never replays them. Turns that time out before the successful `post_llm_call` hook receive the same explicit uncertainty status because Hermes currently exposes no public terminal-turn failure hook to this plugin.

## Quiet calls and ignored speech

Empty, whitespace and punctuation-only transcripts return `ignored` with reason `no_speech`, without injection, bubbles or errors. A small exact whole-transcript list also ignores `you`, `thank you`, `thanks for watching` (with or without a final period), `[BLANK_AUDIO]`, and `(silence)`, after trimming and lowercasing. Longer sentences pass through; deliberately spoken standalone matches are also ignored. The Mini App immediately resumes listening. Minimum detected speech is now 280 ms; the energy threshold still admits quiet speech.

Transcript bubbles use Telegram `disable_notification: true`. The final reply still arrives through Hermes' Telegram connector, which marks finals `notify=True`; Hermes exposes no per-turn notification option to plugins, so each answer during a call still notifies. Mute the chat during a call to avoid that.

## Current limits

Hermes documents both gateway injection and native platform-handler registration. This implementation runs a loopback aiohttp listener inside the gateway process and calls the documented `ctx.inject_message()` API with the existing canonical session key; the HTTPS reverse proxy supplies external reachability. Keep `mobile-voice` trusted because plugin Python executes in the gateway process. Deployment, TLS, real Telegram Mini App launch, and iPhone microphone tests remain operator work.

The bridge requires the Hermes dashboard audio endpoints to be enabled and authenticated with `HERMES_DASHBOARD_SESSION_TOKEN`. It does not provide continuous provider streaming, cancellation of agent work, group/topic binding, native CallKit, or background calls. The public `ctx.inject_message()` contract accepts message content, role, session key, and origin; it does not expose Hermes' internal `auxiliary.voice_chat` routing flag. Consequently this bridge uses the bound conversation's normal agent for replies and Hermes' configured STT/TTS, but does not claim that `auxiliary.voice_chat` model overrides are honored.

True streaming needs supported, profile-scoped dashboard contracts for incremental STT and cancellable TTS audio chunks, plus a public gateway interface for incremental reply text with the same exact final-turn correlation. The broker would need to advertise those capabilities and relay authenticated chunks tied to call/turn IDs, with bounded buffers and interruption handling. Today's `/api/audio/transcribe` and `/api/audio/speak` adapter consumes complete JSON results; faster polling does not turn those into streaming endpoints. No new provider protocol, hosted service, or realtime agent is introduced here. Real Telegram/iPhone latency, echo rejection, AirPods, lock, and conversation-continuity checks remain device-test gates.

## Local protocol checks

```sh
cd mobile/miniapp && node --test
cd ../..
python3 -m venv /tmp/voice-venv
/tmp/voice-venv/bin/pip install -r mobile/requirements.txt
/tmp/voice-venv/bin/python -m unittest discover -s mobile/tests -t .
python3 -m unittest tests.test_publication tests.test_ios_bundle
python3 scripts/check_publication.py
```

The Mini App tests feed synthetic PCM frames into the detector and actual controller, including pre-roll, speech/silence, adaptive noise, min/max duration, playback/barge-in, mute, permission prompts, background cleanup, and temporary interruptions. The HTTP integration tests use a synthetic Telegram signature and fake speech service over aiohttp's actual HTTP test servers. The adapter test verifies the dashboard route paths, profile scope, and session-token header. The broker tests verify auth, caps, exact conversation binding, once-only transcript/injection, early reply text, durable interruption and stale-audio suppression, close behavior, retry behavior, and unknown status after restart. They do not claim a live Telegram, Hermes gateway, provider, or iPhone run.

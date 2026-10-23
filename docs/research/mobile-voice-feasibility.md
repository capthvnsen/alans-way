# Mobile voice feasibility

Research date: 2026-10-17. Source review only; no live Telegram/iPhone or deployed Hermes test was performed. Upstream Hermes inspected at [5fea5a7a4bf6d02b3427fc0bcae95502222cea2e](https://github.com/NousResearch/hermes-agent/tree/5fea5a7a4bf6d02b3427fc0bcae95502222cea2e). These are current upstream capabilities, not confirmation that the user's deployed gateway has them. Sibling voice experiments are separate worktrees, not proof of shipped support here.

## Finding

A Telegram Mini App with a phone-like foreground voice interface is plausible. Preserving the **actual existing Hermes Telegram session** requires an authenticated server bridge into the gateway's session owner. Telegram supplies identity and launch metadata, not conversation history or a native bot-call audio transport. Background/locked-phone reliability inside Telegram remains a device experiment; it must not be promised from browser capability alone.

## Confirmed upstream Hermes capabilities

Hermes has several independent voice settings, rather than one universal voice model:

- `stt.provider` and provider-specific models control transcription.
- `tts.provider` and provider-specific voice/model settings control speech synthesis.
- `auxiliary.voice_chat` can select a different reasoning model for chained spoken turns; otherwise the session model answers. The route is temporary and preserves the session's normal model. [Voice routing implementation](https://github.com/NousResearch/hermes-agent/blob/5fea5a7a4bf6d02b3427fc0bcae95502222cea2e/agent/voice_turn_route.py).
- `voice.voice_chat_mode` selects `chained` or, in current Hermes Desktop, `gpt-live`. Chained mode supports live STT on selected providers, streaming sentence speech and interruptions. GPT-Live uses a full-duplex WebRTC voice model which delegates work to the normal Hermes session. Telegram's documented built-in interface remains voice notes and spoken reply bubbles. [Voice mode guide](https://hermes-agent.nousresearch.com/docs/user-guide/features/voice-mode).

Useful existing server audio surfaces include profile-scoped transcription upload, live transcription and speech WebSockets, and `POST /api/audio/voice-live/session` for SDP exchange. These audio endpoints do not themselves bind a browser to a Telegram conversation. `GET /api/audio/voice-config` intentionally supplies credentials to a trusted desktop client. **Design inference:** a public Mini App should receive a non-secret capability description and scoped call credential, while the broker retains provider secrets; it should not proxy this trusted-client credential response. [Audio routes](https://github.com/NousResearch/hermes-agent/blob/5fea5a7a4bf6d02b3427fc0bcae95502222cea2e/hermes_cli/web_routers/audio.py).

## Same-thread context: feasible seam, mandatory validation

The canonical session key includes profile namespace, platform, chat type, chat ID, thread ID and, depending on isolation settings, participant ID. The bridge must resolve that source through the gateway's current routing rather than construct its own approximate conversation. `/new`, reset, compaction and topic isolation matter. [Session key implementation](https://github.com/NousResearch/hermes-agent/blob/5fea5a7a4bf6d02b3427fc0bcae95502222cea2e/gateway/session.py).

Simply posting the Telegram session ID to the generic OpenAI-compatible API is **not sufficient**: API admission explicitly refuses existing sessions whose source is outside `api_server` and `bot_room`. [API admission](https://github.com/NousResearch/hermes-agent/blob/5fea5a7a4bf6d02b3427fc0bcae95502222cea2e/gateway/session_api_turn.py).

A promising native seam is `SessionAuthority.submit`: it authorizes a profile-scoped principal, serializes mutation, creates durable queued admissions and accepts `voice_turn`, `voice_context` and `interrupted` surface fields. It can restore routed sessions and refuses writes to a superseded conversation. **Inference:** an appropriately authorized broker can potentially reuse this path for the existing Telegram conversation. This is not yet proof of a stable third-party plugin API or correct Telegram transcript delivery; verify those separately. Do not edit Hermes databases or execute a second agent against the same history. [Session authority](https://github.com/NousResearch/hermes-agent/blob/5fea5a7a4bf6d02b3427fc0bcae95502222cea2e/gateway/session_authority.py).

Hermes supports standalone plugins with declared registrations and lifecycle hooks. The plugin guide explicitly recommends requesting a public hook when one is missing. Prefer an existing public session capability or an additive upstream extension over monkey-patching private session methods. [Plugin guide](https://github.com/NousResearch/hermes-agent/blob/5fea5a7a4bf6d02b3427fc0bcae95502222cea2e/website/docs/developer-guide/plugins/index.md).

## Telegram and iOS constraints

Mini Apps support fullscreen, theme/safe-area adaptation, activity events, launch parameters and server-verifiable `initData`. Direct links cannot read chat messages; `chat_instance` is an opaque context identifier, not a Bot API chat ID. Init data has no topic/thread identifier. Validate signature/HMAC and freshness server-side. **Design inference:** mint a short-lived, user-bound launch ticket from a bot command in the target topic; store the authoritative bot/profile/chat/thread/session binding server-side. [Mini App API and validation](https://core.telegram.org/bots/webapps).

Inline `web_app` buttons are limited to private user/bot chats; use an ordinary URL with a Mini App deep link for group-topic launches. Attachment-menu distribution has separate eligibility constraints and should not be an MVP dependency. [Bot API button contract](https://core.telegram.org/bots/api#inlinekeyboardbutton), [Mini App launch types](https://core.telegram.org/bots/webapps#implementing-mini-apps).

Microphone access is not categorically blocked on Telegram iOS: its Mini App controller implements WebKit media-capture permission requests using `.prompt`. That proves a permission path, not successful audio capture on every supported release. [Telegram iOS source](https://github.com/TelegramMessenger/Telegram-iOS/blob/f1dd7a2dbd02cbbf513e75d5695d8d36d1cf5838/submodules/WebUI/Sources/WebAppController.swift#L793). WebKit documents `getUserMedia` exposure in suitably configured WKWebView apps and user permission prompts. [WebKit media capture](https://webkit.org/blog/11353/mediarecorder-api/).

No inspected Telegram Mini App API exposes CallKit, a native call session, guaranteed background microphone execution or lock-screen call controls. **Inference:** design the Telegram version as a foreground call first; test minimizing, app switching and locking before defining the product promise. Fullscreen can make it immersive but cannot itself confer native iOS lifecycle privileges. [Mini App API](https://core.telegram.org/bots/webapps).

A dedicated native iOS client can configure `AVAudioSession` for simultaneous playback/recording and background audio. Apple's `voiceChat` mode supports suitable voice routes; echo cancellation needs Voice Processing I/O or enabled voice processing, not just the mode flag. CallKit supplies system calling UI while the app supplies its own VoIP backend; this does not require a native Telegram call. Incoming-call PushKit integration is a separate feature, unnecessary for an outgoing-only first release. [Audio category](https://developer.apple.com/documentation/avfaudio/avaudiosession/category-swift.struct/playandrecord), [Voice chat audio mode](https://developer.apple.com/documentation/avfaudio/avaudiosession/mode-swift.struct/voicechat), [CallKit](https://developer.apple.com/documentation/callkit).

## Experiments required before implementation commitments

1. Inventory the deployed Hermes version and active profile's resolved voice configuration, without exporting secrets. Confirm which of the upstream surfaces above actually exist there.
2. On current and minimum-supported iOS/Telegram versions, test permission grant/denial/retry, WebRTC and streaming playback, speaker echo/barge-in, AirPods, network changes, minimization, app switching and screen lock. Record reconnect behavior and actual time to first audio.
3. Prove shared context: give the bot a unique fact in one topic, launch there, recall it in voice, introduce another fact verbally, then recall it by text. Confirm another topic/user/profile cannot read or submit to it.
4. Prove the gateway owns turns: type while speaking, interrupt during tools, require an approval, reconnect during generation, restart the gateway and issue `/new`. Assert ordered history, no duplicate work and correct transcript delivery.
5. Verify configured chained providers first, including local/server-only providers. Treat realtime voice as a capability-dependent optional path; a configured TTS provider does not imply a compatible realtime conversation model.
6. Determine whether existing public session RPC/plugin interfaces support scoped broker access without private coupling. If not, specify the smallest additive upstream hook and a minimum supported version before coding the integration.
7. For realtime voice, prove persistence of the complete spoken conversation, including casual exchanges that never delegate to Hermes. The documented delegation mechanism alone does not establish that every spoken exchange reaches the canonical Telegram history. Define ordered transcript checkpoints and interruption handling before claiming shared context across voice and text.

# Voice mode — design

*Status: implemented on the `capthvnsen/voice-mode` branch. Research basis:
`docs/research/local-voice-mode.md`.*

Speak to a Hermes bot from the desktop app. The mic is captured and transcribed
by open-weight models running **locally**; the transcript is sent to the agent
as an ordinary Telegram message through the existing embedded client; the bot's
reply is spoken aloud by a local TTS model. **Only text ever crosses the
network** — Telegram is the transport, voice is just the keyboard. The agent
sees voice turns in the same thread, with the same context, as typed messages.

## Modes

- **Call mode** — a toggle ("call" button / ⌘⌥V). While a call is active the
  mic listens continuously (Silero VAD); each end-of-speech utterance is
  transcribed and auto-sent. Bot replies are spoken. In-thread control messages
  mark the call: on start, a note telling the bot to answer conversationally;
  on hang-up, a request to post a call summary (the summary lands in the thread
  as the permanent record).
- **Dictation mode** — a mic button in the chat header, usable anytime. Speech
  is transcribed into the Telegram composer as a *draft* (never auto-sent);
  the user reviews and sends with Enter as usual.

## Decisions (grilled & settled)

| Decision | Choice |
|---|---|
| Context | Same Telegram thread — voice turns are ordinary user messages |
| Bot awareness | In-thread control messages at call start/end (self-documenting, stock Hermes) |
| Duplex | Half-duplex: mic gated while TTS plays (echo loop prevention). Headphones full-duplex deferred |
| Trigger | Button + hotkey; wake word deferred (needs native addon) |
| Call UI | Slim bar under the chat header: status, live transcript, mute, hang up |
| Bot targeting | Whichever bot chat is open/selected |
| Replies spoken | All new bot messages in the open chat while the call is active (covers proactive plugin messages too) |
| Speech content | Sanitize → classify → cap (~40 spoken words, tail → "full details in chat") → sentence-chunk → speak |
| Interruption | New message mid-speech queues; manual interrupt flushes synth+playback queues |
| Sends | Serialized: ≤1 outstanding voice message (Hermes `_pending_messages` is a single slot — burst collapse) |
| Reply timing | Wait for typing-cancel + ~1 s message/edit quiescence before speaking (Hermes streams via drafts/edits) |
| Engine | Pure JS in Electron: vad-web + transformers.js (Moonshine) + kokoro-js. No native deps, no Python |
| Models | Downloaded from Hugging Face on first enable (~290 MB), cached by the browser cache API under `persist:voice` |

## Architecture

```
MAIN PROCESS                              HIDDEN WebContentsView (voice-app://)
┌─ voice-mode.cjs    call FSM, IPC        │  voice.js   MicVAD + AudioContext
├─ telegram-send.cjs composer inject/     │             playback (audio never
│   send (shared with share-page)         │             leaves this view)
├─ speech-text.cjs   reply→speech rules   │  worker.js  Moonshine STT +
│                                        │             Kokoro TTS (transformers.js)
└─ telegram-preload  reply watch (worker  │  voice-preload  thin IPC bridge
    tap: updateNewMessage/EditMessage)    │
```

- The voice view is a hidden `WebContentsView` on a privileged
  `voice-app://` scheme (secure context → `AudioWorklet`, `fetch`, WebGPU,
  Cache API all work; COOP/COEP headers → `crossOriginIsolated` →
  multithreaded WASM). It lives in `backgroundWindow`, the existing
  `focusable:false` host for background tabs.
- Inference runs in a Web Worker inside that view — sidesteps the
  transformers.js Electron env-detection bug that would pull native
  `onnxruntime-node`; everything stays pure JS (`onnxruntime-web` WASM).
- Only text and control events cross IPC — never PCM.
- State machine (main): `off → starting → listening → transcribing →
  thinking → speaking → listening`, with local queueing when a second
  utterance completes while a send is outstanding.

## Security & privacy

- Mic permission: dedicated `persist:voice` session grants `media`/audio to
  the `voice-app:` origin only; macOS TCC via `systemPreferences.askForMediaAccess`.
- The voice view loads only first-party code; CSP allows `connect-src` to
  huggingface.co only (model downloads).
- Reply watch reads only bot chats (the same IDs the sidebar already tracks) —
  personal chats are never forwarded to main.
- Model licenses: Moonshine MIT, Whisper MIT, Kokoro Apache-2.0, Silero MIT,
  all runtime JS MIT — GPL-3.0 clean. Voice-marker prefix on spoken turns makes
  the transcript self-describing.

## Files

| File | Role |
|---|---|
| `src/voice-mode.cjs` | call FSM + IPC orchestration |
| `src/voice-protocol.cjs` | `voice-app://` scheme + asset/model serving + COOP/COEP/CSP |
| `src/speech-text.cjs` | reply → speakable text (sanitize, classify, cap, chunk); unit-tested |
| `src/telegram-send.cjs` | composer locate/inject/send (also used by share-page) |
| `src/voice/index.html`, `voice-page.mjs` | mic capture (MicVAD), playback scheduler (esbuild → `voice-page.bundle.js`, served as `/voice.js`) |
| `src/voice/voice-worker.mjs` | STT + TTS inference (esbuild → `voice-worker.bundle.js`, served as `/worker.js`) |
| `src/voice-preload.cjs` | voice view's IPC bridge |
| `src/telegram-preload.cjs` | extended: `updateNewMessage`/`updateEditMessage` → `telegram:message` |
| `assets/voice-info.plist` | `NSMicrophoneUsageDescription` for packaged mac builds |

## Deferred (not built)

- Wake word ("Hey Hermes") — sherpa-onnx KWS or openWakeWord (needs native or
  retrained models).
- Full duplex with barge-in — needs reliable AEC; half-duplex ships first.
- Per-bot voices, `sherpa-onnx` Parakeet "high-accuracy" backend, LLM
  spoken-rewriter for long/code-heavy replies, local model mirror
  (`model-store.cjs` offline seeding).

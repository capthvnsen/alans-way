# Local voice mode — open-weight models on the Mac, Hermes stays in the cloud

*Research compiled October 2026. Design input only — no implementation yet.*

Goal: speak to a Hermes bot from the desktop app. Mic audio is captured and
transcribed by local open-weight models, the text goes to the agent on the VPS
over the existing Telegram path, the reply comes back as text, and a local
open-weight TTS model speaks it. Only text crosses the network.

TL;DR: yes, this is very doable today, entirely inside Electron with zero
native dependencies and zero Python. Recommended v1 stack:

- Mic → **Silero VAD** (`@ricky0123/vad-web`, MIT) in the renderer
- STT → **Moonshine** or Whisper ONNX via **transformers.js** (MIT)
- Agent → existing Telegram transport (unchanged)
- TTS → **Kokoro-82M** via **`kokoro-js`** (Apache-2.0, npm, streams audio)

All models are HF-downloaded ONNX files; all licenses are MIT/Apache/GPL-clean.
Expected local overhead ≈ 0.5–1.5 s per turn — the cloud agent round-trip
dominates. Design the voice layer behind a swappable backend interface so a
higher-accuracy engine (sherpa-onnx Parakeet) can slot in later.

---

## 1. Where voice plugs into this app

The app already has every seam voice mode needs; nothing new has to cross the
network.

- **Outbound (you → agent).** The human path is the embedded Telegram Web
  composer. A voice pipeline can inject the transcript into the composer the
  same way the app already automates Telegram (preload `executeJavaScript` /
  CDP `Input.insertText`), or simply fill the draft and let the user hit send —
  a sensible v1 UX. `desktop/src/telegram-preload.cjs`
- **Inbound (agent → you).** The Telegram preload already reads
  `tt-global-state` out of IndexedDB every 2.5 s (`cached.messages.byChatId…byId`)
  and already proxies the gramjs API `Worker`, seeing `updateChatTypingStatus`
  and friends in real time. Watching for `updateNewMessage` from the selected
  bot gives replies without polling; the existing typing signal already tells
  voice mode when the agent is working. `desktop/src/telegram-preload.cjs`
- **Mic permission.** The per-site permission system already models
  `microphone` grants (`desktop/src/site-permissions.cjs`); the app's own UI
  will need a session-level `media` grant in `main.cjs`, same mechanism.
- **Process placement.** All recommended v1 components run in the renderer
  (onnxruntime-web / WebGPU) or a utility process — consistent with the app's
  no-framework CommonJS style. Model files should download to a user cache dir
  at first use, with a license manifest (CC-BY weights need attribution).

## 2. Local STT — open weights, Apple Silicon

| Engine / model | License (code/weights) | Size | Streaming? | Electron path | Notes |
|---|---|---|---|---|---|
| **Moonshine** (Useful Sensors; tiny 27M / base 61M; v2 streaming 123M/245M) | MIT | tens–hundreds MB | v2 = true streaming; v1 chunk-based feels real-time behind VAD | transformers.js ≥3.2 (`onnx-community/moonshine-*-ONNX`); sherpa-onnx int8 | Best zero-native-dep pick; built for live transcription. English WER ~10–13%, below Whisper quality |
| **whisper.cpp** (`large-v3-turbo`, distil-large-v3) | MIT | ~1.5–3 GB | Utterance chunks + built-in Silero VAD | spawn `whisper-cli`/`whisper-server`, or N-API addons (`whisper-cpp-node`, `@kutalia/whisper-node-addon`) | Most mature. Metal (+CoreML encoder). turbo ≈5× RT on base M1, ~17× on M3 Ultra |
| **Parakeet TDT 0.6B v3** (NVIDIA) | CC-BY-4.0 weights | ~0.6–0.7 GB (int8 ONNX); ~300–430 MB CoreML | True streaming transducer | `sherpa-onnx-node` int8 model; FluidAudio/MLX otherwise | Community favorite for English dictation on Mac (VoiceInk/Hex default). WER ~2.6% |
| **faster-whisper** (CTranslate2) | MIT | varies | chunks | **Python only** — sidecar | No GPU on Mac; superseded here |
| **mlx-whisper / lightning-whisper-mlx** | MIT | varies | wrappers add it | **Python only** | ~29–36× RT on M1; used by Pipecat/WhisperLiveKit |
| **WhisperKit** (Argmax) | MIT | varies | helpers | Swift only | medium RTF ~0.22 on M4, WER ~2.6% |
| **Kyutai STT** (stt-1b-en_fr, stt-2.6b-en) | Apache code / CC-BY weights | 1–2.6B | **True streaming + semantic VAD in one model** | Rust ws server or Python MLX | Elegant long-term: STT + end-of-turn detection together; heavier than needed |
| **SenseVoice-Small** | FunASR license | ~470 MB | offline | sherpa-onnx | multilingual; skip for English-only |
| **distil-whisper (distil-large-v3, EN)** | MIT | ~1.5 GB | chunks | whisper.cpp / transformers.js ONNX | ~6× faster than large-v3 at ~1% WER cost |

**Streaming-dictation verdict (English):** best accuracy = Parakeet v3 or
whisper.cpp large-v3-turbo; best pure-JS = Moonshine via transformers.js.
Avoid whisper tiny/base for real-world dictation — they degrade badly in noise.

## 3. Local TTS — open weights, Apple Silicon

| Engine / model | License | Size | No-Python JS path? | Notes |
|---|---|---|---|---|
| **Kokoro-82M** | Apache-2.0 | fp32 326 MB / q8 92 MB / q4 ~87 MB | **Yes — `kokoro-js` npm (renderer or Node), `tts.stream()` + `TextSplitterStream`** | The default pick; 54 voices; first-chunk ~100–300 ms; proven by VoiceMode & Pipecat |
| **sherpa-onnx TTS** (Kokoro, Matcha, VITS incl. all Piper voices) | Apache-2.0 runtime | 60–300 MB/model | Yes — `sherpa-onnx-node` (`generateAsync` progress callback) | Same addon can do STT+VAD+KWS too |
| **Piper** (`piper1-gpl`, OHF-Voice) | **GPL-3.0** since v1.3 (was MIT); voice licenses vary | 25–120 MB | via sherpa-onnx VITS or spawned binary | GPL is *compatible* with this app; fastest CPU TTS; quality a tier below Kokoro |
| **KittenTTS** (nano 15M / micro 40M / mini 80M) | Apache-2.0 | 25–80 MB | `kitten-tts-js` community npm (young — smoke-test first) | Great quality-per-MB |
| **Chatterbox** (Resemble: Turbo 350M, Nano 110M, ML 500M) | MIT | 0.35–0.5 GB | ONNX export exists, no maintained JS SDK → Python/MLX | Best quality tier; heavier |
| **Qwen3-TTS** (0.6B/1.7B, released Jan 2026, 97 ms first packet) | Apache-2.0 | 0.6–1.7B | Python / mlx-audio only | New flagship open TTS; overkill for agent replies but a quality upgrade path |
| **mlx-audio** (suite: Kokoro, KittenTTS, Qwen3-TTS, CSM-1B, Dia, Chatterbox, OuteTTS, Orpheus…) | MIT code | — | **Python 3.10+ required**; has OpenAI-compatible REST server | The obvious Python-sidecar TTS engine |
| Sesame CSM-1B / Orpheus-3B / OuteTTS-0.6B | Apache (Orpheus weights = Llama license) | 0.6–3B | Python only | conversational quality but heavy |
| MeloTTS | MIT | ~150–470 MB | sherpa-onnx `vits-melo-tts` | older, still fine |
| ~~Coqui XTTS v2~~ | weights **CPML — non-commercial** | ~2 GB | — | **Excluded**: license-incompatible |

## 4. VAD, turn-taking, wake word

- **Silero VAD** — MIT, ~2 MB ONNX, de-facto standard. **`@ricky0123/vad-web`**
  in the renderer gives `MicVAD` → `onSpeechEnd(Float32Array@16kHz)` — exactly
  the segmentation API a push-to-talk-free voice mode wants. (`vad-node` was
  deprecated Oct 2025; use the web build in the renderer, or Silero inside
  sherpa-onnx in main.)
- **TEN VAD** — Apache-2.0 + anti-compete rider (Agora). Works but not clean
  OSI; Silero (MIT) is simpler. Skip.
- **webrtcvad** — BSD, noticeably worse than Silero. Skip.
- **Pipecat Smart Turn v3** — BSD-2-Clause, weights + training code public,
  8M-param model, ~10 ms inference, predicts semantic end-of-turn. ONNX file is
  standalone — could run under onnxruntime-node with modest glue (normally used
  via Python Pipecat).
- **LiveKit turn detector** — open weights under custom LiveKit Model License;
  text-based variant now deprecated. Higher integration cost than Smart Turn.
- **Wake word:** sherpa-onnx keyword spotting (Apache-2.0) is the practical
  pick — same addon. **openWakeWord's pretrained models are CC-BY-NC-SA** —
  only usable if you train your own model. Picovoice Porcupine is proprietary.
- **Cheapest good UX:** a push-to-talk / toggle hotkey — zero model cost; most
  dictation apps default to it. Recommend it for v1; add KWS later only if "Hey
  Hermes" is wanted.

## 5. All-in-one runtimes and frameworks

- **sherpa-onnx** (Apache-2.0) — the strongest single shortcut: streaming +
  offline ASR (Whisper, Moonshine v1/v2, SenseVoice, Parakeet v2/v3,
  Zipformer), Silero/TEN VAD, TTS (Kokoro/Matcha/VITS), keyword spotting,
  diarization, punctuation — one C++/ONNX library. Ships **`sherpa-onnx-node`
  npm with prebuilt darwin-arm64 binaries** (verified: v1.13.8, Sep 2026).
  Electron caveats: may need electron-rebuild, `DYLD_LIBRARY_PATH` for its
  dylibs, and `enableExternalBuffer` care on Electron ≥21 (upstream issues
  #2866/#3108) — test early. A wasm build (`sherpa-onnx` npm) avoids native
  deps at some speed cost.
- **transformers.js** (v4.x, MIT) — pure JS; does Moonshine/Whisper ASR **and**
  (wrapped by `kokoro-js`) Kokoro TTS on onnxruntime — wasm, WebGPU, or Node
  cpu backend. Verified on npm: `@huggingface/transformers` 4.3.1.
- **VoiceMode** (`mbailey/voicemode`, MIT, Python) — MCP server that runs
  whisper.cpp as an OpenAI-compatible STT server (:2022) and Kokoro TTS (:8880)
  locally, with a `converse` MCP tool. Reusable sidecar if Hermes or the app
  ever speaks MCP directly; heavier install (Python, PortAudio, ffmpeg).
- **Pipecat** (BSD-2, Python) — mature pipeline: Silero VAD + Smart Turn +
  Whisper/Kokoro local services + **any OpenAI-compatible `base_url`** — a tiny
  shim can relay to Hermes. Measured <800 ms voice-to-voice fully local on
  M-series (kwindla/macos-local-voice-agents). Viable but adds a Python runtime
  to ship — option C, not v1.
- **LiveKit Agents** — similar, WebRTC-room oriented; heavier than needed.
- **FluidAudio / FluidInference** — Swift SDK: Parakeet v3 streaming ASR +
  diarization + VAD on CoreML/ANE; the engine inside VoiceInk and Hex. Reachable
  from Electron only via a spawned Swift helper — best-in-class ASR latency if
  ever wanted.
- **Reference apps:** **OpenWhispr** (MIT, Electron 41 — whisper.cpp binaries +
  sherpa-onnx Parakeet; closest architectural match, mine its patterns);
  VoiceInk (GPL-3, Swift); Hex (MIT, Swift); WhisperLiveKit/SimulStreaming
  (Python incremental-ASR research stack).

## 6. Speech-to-speech E2E models — verdict: overkill

Moshi/Kyutai (MLX port runs on M3), PersonaPlex (NVIDIA OLM license), Ultravox,
GLM-4-Voice, MiniCPM-o are speech-conditioned LLMs: the model *is* the agent.
They can't wrap a text-based cloud Hermes without abandoning the
"only text crosses the network" constraint, and they cost 4–8B params of memory
for worse command fidelity than a real ASR. Cascaded VAD→ASR→text→TTS preserves
exact text for agent commands and keeps every component swappable. Confirmed:
cascaded is right.

## 7. Recommended architecture

### Option A — pure JS inside Electron ✅ recommended v1

`getUserMedia` → `@ricky0123/vad-web` (Silero ONNX) → utterance PCM →
transformers.js ASR (`onnx-community/moonshine-base-ONNX` for speed, or
whisper/distil ONNX for accuracy) → inject transcript into Telegram composer →
watch for bot reply (existing worker-proxy/IndexedDB path) → `kokoro-js`
`TextSplitterStream` speaks tokens as they arrive.

- No native deps, no Python — matches the app's minimal-dependency style.
- Round-trip overhead ≈ **0.7–1.5 s + agent time**; models <300 MB on disk,
  <1 GB RSS.
- Licenses: MIT + Apache-2.0 only → GPL-3.0-clean.
- Trigger: push-to-talk hotkey (skip wake-word licensing for v1).

### Option B — native sidecar (best quality-per-watt; upgrade path)

`sherpa-onnx-node` (Parakeet-v3 int8 or Moonshine int8 STT + Kokoro/VITS TTS +
Silero VAD + KWS — all in one addon), or spawned `whisper-cli`/`whisper-server`
(Metal+CoreML, large-v3-turbo) + Piper binary, exactly the OpenWhispr pattern.

- Best WER/latency on the market for local Mac ASR (Parakeet partials ~1.4 s
  first hypothesis; whisper turbo ~5× RT).
- Medium complexity: electron-rebuild / dylib paths / codesigning.
- Slot behind the same backend interface as Option A ("high-accuracy mode").

### Option C — Python sidecar (max capability, max weight)

Spawn `voice-mode` or a small Pipecat bot on localhost; Electron talks
WebSocket. Unlocks Smart Turn semantic turn-taking, diarization, mlx-audio TTS
breadth. Highest install complexity — defer unless semantic turn-taking becomes
a requirement.

### License watchlist for redistribution

- ✅ Clean: MIT — whisper.cpp, faster-whisper, Silero VAD, transformers.js,
  vad-web, KittenTTS, Chatterbox, VoiceMode, OpenWhispr, Hex, distil-whisper,
  Moonshine, MeloTTS · Apache-2.0 — sherpa-onnx, Kokoro, Qwen3-TTS, CSM,
  OuteTTS · BSD-2 — Smart Turn · GPL-3.0 — piper1-gpl (compatible) · CC-BY-4.0 —
  Parakeet/Moshi/Kyutai weights (attribution required — add a manifest).
- ⚠️ Caution: openWakeWord pretrained models (CC-BY-NC-SA), TEN VAD
  (Apache+non-compete), Orpheus weights (Llama license), LiveKit turn detector
  (custom license), SenseVoice (FunASR license).
- ❌ Exclude: Coqui XTTS (CPML non-commercial), Picovoice (proprietary).

## 8. Open questions / verify before building

- Does `sherpa-onnx-node` load under Electron 44 without a rebuild?
  (issues #2866/#3108 — smoke-test first if Option B is pursued)
- `kitten-tts-js` is a young community port — validate before depending on it.
- Exact WER gap: sherpa-onnx int8 Parakeet-v3 vs FluidAudio CoreML vs
  whisper.cpp turbo — benchmark on the actual machine if accuracy matters.
- Reply-detection UX: speak every new bot message in the selected chat, or only
  messages that answer a voice turn? (Recommend the latter — the typing-status
  signal already brackets an agent turn.)

## Sources

- whisper.cpp (MIT): https://github.com/ggml-org/whisper.cpp · Metal benches https://github.com/mundwerk-app/whisper-metal-benchmark · Node addons https://www.npmjs.com/package/whisper-cpp-node · https://www.npmjs.com/package/@kutalia/whisper-node-addon
- Moonshine: https://huggingface.co/UsefulSensors/moonshine · transformers.js support https://github.com/huggingface/transformers.js/pull/1099 · ONNX mirrors https://huggingface.co/onnx-community
- transformers.js v4: https://huggingface.co/blog/transformersjs-v4 · https://www.npmjs.com/package/@huggingface/transformers
- kokoro-js: https://www.npmjs.com/package/kokoro-js · https://github.com/hexgrad/kokoro · https://huggingface.co/onnx-community/Kokoro-82M-ONNX
- KittenTTS: https://github.com/KittenML/KittenTTS · https://www.npmjs.com/package/kitten-tts-js
- Piper/piper1-gpl license change: https://github.com/OHF-Voice/piper1-gpl/blob/main/CHANGELOG.md
- sherpa-onnx: https://github.com/k2-fsa/sherpa-onnx · https://www.npmjs.com/package/sherpa-onnx-node · Electron issues https://github.com/k2-fsa/sherpa-onnx/issues/2866 · Parakeet int8 https://github.com/k2-fsa/sherpa-onnx/pull/2500
- Parakeet v3: https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3 · CoreML https://huggingface.co/FluidInference/parakeet-tdt-0.6b-v3-coreml
- faster-whisper on AS: https://github.com/SYSTRAN/faster-whisper/issues/131
- mlx-audio: https://github.com/Blaizzy/mlx-audio
- Qwen3-TTS: https://github.com/QwenLM/Qwen3-TTS
- Chatterbox: https://github.com/resemble-ai/chatterbox
- Coqui CPML: https://huggingface.co/coqui/XTTS-v2/blob/main/LICENSE.txt
- Silero VAD: https://github.com/snakers4/silero-vad · https://github.com/ricky0123/vad · https://www.npmjs.com/package/@ricky0123/vad-web
- Smart Turn: https://github.com/pipecat-ai/Smart-Turn · https://huggingface.co/pipecat-ai/smart-turn-v3
- LiveKit turn detector: https://huggingface.co/livekit/turn-detector
- TEN VAD license: https://github.com/TEN-framework/ten-vad/blob/main/LICENSE
- openWakeWord: https://github.com/dscripka/openWakeWord
- VoiceMode: https://github.com/mbailey/voicemode
- Pipecat local pipeline: https://github.com/kwindla/macos-local-voice-agents · https://docs.pipecat.ai/
- Kyutai: https://github.com/kyutai-labs/delayed-streams-modeling · https://github.com/kyutai-labs/moshi
- PersonaPlex: https://huggingface.co/nvidia/personaplex-7b-v1
- WhisperLiveKit: https://github.com/QuentinFuxa/WhisperLiveKit
- Reference apps: https://github.com/OpenWhispr/openwhispr · https://github.com/Beingpax/voiceink · https://github.com/kitlangton/Hex

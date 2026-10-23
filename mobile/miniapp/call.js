import { CallState, SPEECH_THRESHOLD, audioConstraints, createAttemptGuard, createSilenceGate, recordingMimeType, shouldInterruptPlayback, transition } from "./lifecycle.js";
import { VoiceClient } from "./voice-client.js";

const $ = (id) => document.getElementById(id);
const ui = {
  shell: $("call-shell"), name: $("agent-name"), stateLabel: $("state-label"), stateTitle: $("state-title"),
  detail: $("state-detail"), call: $("call-button"), callLabel: $("call-button-label"), mute: $("mute-button"),
  muteLabel: $("mute-label"), hangup: $("hangup-button"), echo: $("echo-button"), privacy: $("privacy-note"),
  errorPanel: $("error-panel"), errorText: $("error-text"), retry: $("retry-button"), portrait: $("portrait"),
  transcriptToggle: $("transcript-toggle"), transcriptPanel: $("transcript-panel"), transcriptList: $("transcript-list"),
  transcriptEmpty: $("transcript-empty"), computerButton: $("computer-button"),
};
const telegram = window.Telegram?.WebApp;
const host = window.__HERMES_HOST__ || {};
let state = CallState.idle;
let client;
let stream;
let recorder;
let recorderParts = [];
let audioContext;
let audioUnlockPromise;
let analyser;
let microphoneSource;
let captureSink;
let monitorFrame = 0;
let audioSource;
let currentTurnId;
let aborter;
let gate = createSilenceGate();
let echoControl = true;
let muted = false;
let handlingUtterance = false;
let closed = false;
let hostAudioInterrupted = false;
let launchTicketConsumed = false;
let retryAllowed = true;
const attemptGuard = createAttemptGuard();
let activeAttempt = 0;
let resetVoiceActivity = () => {};

function setState(next) {
  if (state !== next) state = transition(state, next);
  ui.shell.dataset.state = state;
  const agentName = host.botName || "Hermes";
  const copy = {
    idle: ["READY WHEN YOU ARE", `Talk to ${agentName}`, "Your conversation continues with this agent."],
    "requesting-permission": ["MICROPHONE PERMISSION", "Allow microphone", "Your microphone stays off until you approve."],
    connecting: ["SECURE CONNECTION", "Connecting…", "Opening a voice call for this conversation."],
    listening: ["LISTENING", "I’m here", "Speak naturally. I’ll respond after you pause."],
    thinking: ["WORKING ON IT", "One moment…", "Your spoken turn is being handled by this agent."],
    speaking: [`${agentName.toLocaleUpperCase()} IS SPEAKING`, "Here’s what I found", "Tap the center button to stop the audio."],
    error: ["CALL PAUSED", "Couldn’t connect", "Check your connection or microphone permission, then try again."],
    ended: ["CALL ENDED", "Talk soon", "Your call has ended."],
  }[state];
  [ui.stateLabel.textContent, ui.stateTitle.textContent, ui.detail.textContent] = copy;
  if (hostAudioInterrupted && [CallState.listening, CallState.thinking, CallState.speaking].includes(state)) {
    ui.detail.textContent = "Audio is temporarily interrupted. Your call is still connected.";
  }
  const active = [CallState.listening, CallState.thinking, CallState.speaking].includes(state);
  ui.call.disabled = [CallState.requestingPermission, CallState.connecting, CallState.thinking, CallState.ended].includes(state) || (state === CallState.listening && muted);
  ui.callLabel.textContent = state === CallState.speaking ? "Stop reply" : state === CallState.listening ? "Send voice" : state === CallState.thinking ? "Thinking…" : state === CallState.connecting ? "Connecting" : "Start call";
  ui.call.setAttribute("aria-label", state === CallState.speaking ? "Stop reply audio" : state === CallState.listening ? "Send recorded voice turn" : "Start call");
  ui.mute.disabled = !active;
  ui.hangup.disabled = !active && state !== CallState.error && state !== CallState.connecting;
  ui.privacy.textContent = active ? (muted ? "Microphone muted · call stays in this conversation." : "Microphone active · audio is sent securely for this call.") : state === CallState.ended ? "Microphone and audio session released." : "Microphone is off until you start.";
  ui.errorPanel.hidden = state !== CallState.error;
}

function haptic(style = "light") {
  try { telegram?.HapticFeedback?.impactOccurred(style); } catch {}
  try { window.TelegramWebviewProxy?.postEvent("web_app_trigger_haptic_feedback", { type: "impact", impact_style: style }); } catch {}
}

function addTranscript(who, text) {
  if (!text) return;
  ui.transcriptEmpty.hidden = true;
  const item = document.createElement("li");
  item.className = "transcript-line";
  const label = document.createElement("strong");
  label.textContent = who;
  item.append(label, document.createTextNode(text));
  ui.transcriptList.append(item);
  ui.transcriptPanel.scrollTop = ui.transcriptPanel.scrollHeight;
}

function showError(error) {
  if (closed || state === CallState.ended) return;
  attemptGuard.invalidate();
  aborter?.abort();
  aborter = null;
  console.error("Voice call error", error);
  ui.errorText.textContent = error instanceof Error ? error.message : "The call could not continue. Please try again.";
  retryAllowed = Boolean(client?.call) || (!launchTicketConsumed && ![401, 403].includes(error?.status));
  if ([401, 403].includes(error?.status)) {
    client?.disconnect();
    client = null;
    retryAllowed = false;
  }
  ui.retry.textContent = retryAllowed ? "Resume call" : "Close";
  if (state !== CallState.error) setState(CallState.error);
  releaseMedia();
}

async function startCall() {
  if (![CallState.idle, CallState.error].includes(state)) return;
  if (state === CallState.error && !retryAllowed) { hangup(); return; }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    showError(new Error("This browser cannot capture voice audio. Update Telegram or iOS and try again."));
    return;
  }
  const attempt = attemptGuard.begin();
  activeAttempt = attempt;
  let connectAttempted = false;
  ui.errorPanel.hidden = true;
  setState(CallState.requestingPermission);
  haptic();
  try {
    // Create and resume Web Audio synchronously in the tap handler. iOS may
    // reject audio playback if the context is first created after network waits.
    unlockAudioOutput();
    // Called directly from the button gesture so iOS can display its permission prompt.
    const grantedStream = await navigator.mediaDevices.getUserMedia(audioConstraints(echoControl));
    if (!attemptGuard.isCurrent(attempt) || closed) {
      grantedStream.getTracks().forEach((track) => track.stop());
      return;
    }
    stream = grantedStream;
    setState(CallState.connecting);
    aborter = new AbortController();
    if (!client?.call) {
      const initData = telegram?.initData || "";
      const params = new URLSearchParams(location.search);
      const launchTicket = params.get("ticket") || host.launchTicket || "";
      if (!initData || !launchTicket) {
        const error = new Error("Telegram could not verify this call launch. Return to the bot chat and open Call again.");
        error.status = 401;
        throw error;
      }
      if (launchTicketConsumed) {
        const error = new Error("This call launch may already have been used. Return to the bot chat and open Call again.");
        error.status = 403;
        throw error;
      }
      const apiBase = document.documentElement.dataset.voiceApi || location.origin;
      client = new VoiceClient({ apiBase, initData, launchTicket });
      connectAttempted = true;
      launchTicketConsumed = true;
      try {
        await client.connect(aborter.signal);
      } finally {
        // The launch ticket is single-use. Remove it after the first request
        // settles so it cannot leak through later navigation or referrers.
        const cleanURL = new URL(location.href);
        cleanURL.searchParams.delete("ticket");
        history.replaceState(history.state, "", cleanURL);
      }
    }
    if (!attemptGuard.isCurrent(attempt) || closed) return;
    await beginCapture();
    if (!attemptGuard.isCurrent(attempt) || closed) return;
    retryAllowed = true;
    setState(CallState.listening);
  } catch (error) {
    if (!attemptGuard.isCurrent(attempt) || closed) return;
    if (connectAttempted && !client?.call) client = null;
    showError(normalizeError(error));
  }
}

function normalizeError(error) {
  if (error?.name === "NotAllowedError" || error?.name === "PermissionDeniedError") return new Error("Microphone access is off. Allow it in iOS Settings, then try again.");
  if (error?.name === "NotFoundError") return new Error("No microphone is available on this device.");
  if (error?.name === "AbortError") return new Error("The connection was interrupted.");
  return error;
}

async function beginCapture() {
  if (!stream || closed || state === CallState.ended) return;
  if (!audioContext) unlockAudioOutput();
  if (audioContext.state === "suspended") await audioContext.resume();
  microphoneSource = audioContext.createMediaStreamSource(stream);
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 512;
  microphoneSource.connect(analyser);
  // Keep WebKit's capture graph attached to a live destination without
  // playing microphone audio back through the speaker.
  captureSink = audioContext.createGain();
  captureSink.gain.value = 0;
  analyser.connect(captureSink);
  captureSink.connect(audioContext.destination);
  startRecorder();
  gate = createSilenceGate();
  const floatSamples = typeof analyser.getFloatTimeDomainData === "function";
  const values = floatSamples ? new Float32Array(analyser.fftSize) : new Uint8Array(analyser.fftSize);
  let utteranceStartedAt = 0;
  let lastVoiceAt = Date.now();
  let lastRecorderResetAt = Date.now();
  const captureStartedAt = Date.now();
  let heardSound = false;
  resetVoiceActivity = () => {
    utteranceStartedAt = 0;
    lastVoiceAt = Date.now();
    gate.reset();
  };
  const monitor = () => {
    if (!analyser || !stream?.active || closed) return;
    if (floatSamples) analyser.getFloatTimeDomainData(values);
    else analyser.getByteTimeDomainData(values);
    let energy = 0;
    for (const value of values) { const centered = floatSamples ? value : (value - 128) / 128; energy += centered * centered; }
    const level = Math.sqrt(energy / values.length);
    const now = Date.now();
    const voiced = !muted && level >= SPEECH_THRESHOLD;
    ui.shell.style.setProperty("--mic-level", String(muted ? 0 : Math.min(1, level / 0.08)));
    if (!muted && level > 0.001) heardSound = true;
    if (state === CallState.listening && !hostAudioInterrupted) {
      ui.detail.textContent = muted ? "Microphone muted."
        : voiced ? "I hear you. Pause to send, or tap Send voice."
          : !heardSound && now - captureStartedAt >= 8_000
            ? "No microphone sound detected. Check your microphone input, then try speaking again."
            : "Speak naturally. Pause to send, or tap Send voice.";
    }
    if (voiced) {
      if (!utteranceStartedAt) utteranceStartedAt = now;
      lastVoiceAt = now;
    }
    const utteranceEnded = !muted && gate.sample(level, now);
    if (shouldInterruptPlayback({ state, level, muted })) stopReplyForBargeIn();
    if (utteranceEnded || (utteranceStartedAt && now - utteranceStartedAt >= 25_000)) {
      utteranceStartedAt = 0;
      lastVoiceAt = now;
      lastRecorderResetAt = now;
      finishUtterance();
    } else if (!utteranceStartedAt && now - lastVoiceAt >= 3_000 && now - lastRecorderResetAt >= 3_000) {
      // Keep at most a few seconds of silence as VAD pre-roll; never grow an
      // unbounded MediaRecorder Blob during a long idle call.
      rotateIdleRecorder();
      lastRecorderResetAt = now;
    }
    monitorFrame = requestAnimationFrame(monitor);
  };
  monitorFrame = requestAnimationFrame(monitor);
}

function startRecorder() {
  if (!stream?.active || closed) return;
  const preferred = recordingMimeType((type) => MediaRecorder.isTypeSupported?.(type));
  recorderParts = [];
  recorder = preferred ? new MediaRecorder(stream, { mimeType: preferred }) : new MediaRecorder(stream);
  recorder.ondataavailable = (event) => { if (event.data?.size) recorderParts.push(event.data); };
  recorder.start(200);
}

function rotateIdleRecorder() {
  if (!recorder || recorder.state === "inactive" || handlingUtterance) return;
  const idleRecorder = recorder;
  idleRecorder.onstop = () => {
    if (recorder !== idleRecorder || closed) return;
    recorderParts = [];
    recorder = null;
    startRecorder();
  };
  idleRecorder.stop();
}

function discardRecorderSegment() {
  if (!recorder || recorder.state === "inactive" || handlingUtterance) return;
  const segment = recorder;
  segment.onstop = () => {
    if (recorder !== segment || closed) return;
    recorderParts = [];
    recorder = null;
    startRecorder();
  };
  segment.stop();
}

function unlockAudioOutput() {
  if (!audioContext) {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) throw new Error("This browser cannot play voice audio.");
    audioContext = new Context();
  }
  if (audioContext.state === "suspended") audioUnlockPromise = audioContext.resume().catch(() => {});
  return audioUnlockPromise || Promise.resolve();
}

async function finishUtterance() {
  if (!recorder || recorder.state === "inactive" || handlingUtterance) return;
  handlingUtterance = true;
  const attempt = activeAttempt;
  const turnId = crypto.randomUUID();
  currentTurnId = turnId;
  const callClient = client;
  const signal = aborter?.signal;
  setState(CallState.thinking);
  const finished = recorder;
  finished.onstop = async () => {
    const blob = new Blob(recorderParts, { type: finished.mimeType || "audio/mp4" });
    recorderParts = [];
    recorder = null;
    try {
      if (!attemptGuard.isCurrent(attempt) || closed) return;
      if (!blob.size) throw new Error("The microphone produced no audio. Check your microphone input, then resume the call.");
      await callClient.sendTurn(blob, turnId, signal);
      if (!attemptGuard.isCurrent(attempt) || closed) return;
      const result = await callClient.waitForTurn(turnId, signal);
      if (!attemptGuard.isCurrent(attempt) || closed) return;
      if (result.transcript) addTranscript("You", result.transcript);
      else if (result.user_transcript) addTranscript("You", result.user_transcript);
      if (result.reply_text) addTranscript(host.botName || "Hermes", result.reply_text);
      const replyBlob = await callClient.getReplyAudio(turnId, result.audio_url, signal);
      if (!attemptGuard.isCurrent(attempt) || closed) return;
      await startReplyPlayback(replyBlob, attempt);
    } catch (error) {
      if (attemptGuard.isCurrent(attempt) && error?.name !== "AbortError") {
        if (error?.status === 422) setState(CallState.listening);
        else showError(error);
      }
    } finally {
      handlingUtterance = false;
      if (attemptGuard.isCurrent(attempt) && !closed && state !== CallState.error && state !== CallState.ended) {
        // Keep capture active after a quiet/no-speech clip and during playback.
        if (!recorder) startRecorder();
        if (state === CallState.thinking) setState(CallState.listening);
      }
    }
  };
  finished.stop();
}

async function startReplyPlayback(blob, attempt) {
  if (!audioContext) throw new Error("Audio output is unavailable. End and restart the call.");
  await unlockAudioOutput();
  const buffer = await audioContext.decodeAudioData(await blob.arrayBuffer());
  if (!attemptGuard.isCurrent(attempt) || closed) return;
  const source = audioContext.createBufferSource();
  source.buffer = buffer;
  source.connect(audioContext.destination);
  source.onended = () => {
    if (audioSource === source) audioSource = null;
    if (!closed && state === CallState.speaking) setState(CallState.listening);
  };
  audioSource = source;
  source.start();
  setState(CallState.speaking);
}

function stopPlayback() {
  const source = audioSource;
  audioSource = null;
  if (!source) return;
  source.onended = null;
  try { source.stop(); } catch {}
}

function stopReplyForBargeIn() {
  if (state !== CallState.speaking) return;
  stopPlayback();
  if (currentTurnId) client?.interrupt(currentTurnId).catch(() => {});
  setState(CallState.listening);
  haptic("soft");
}

async function stopReply() {
  if (state !== CallState.speaking) return;
  stopPlayback();
  if (currentTurnId) client?.interrupt(currentTurnId).catch(() => {});
  setState(CallState.listening);
}

function releaseMedia() {
  cancelAnimationFrame(monitorFrame);
  analyser = null;
  microphoneSource?.disconnect();
  captureSink?.disconnect();
  microphoneSource = null;
  captureSink = null;
  ui.shell.style.setProperty("--mic-level", "0");
  if (recorder && recorder.state !== "inactive") recorder.stop();
  recorder = null;
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  stopPlayback();
  audioContext?.close().catch(() => {});
  audioContext = null;
}

async function hangup({ close = true } = {}) {
  if (closed) return;
  closed = true;
  attemptGuard.invalidate();
  aborter?.abort();
  currentTurnId = null;
  releaseMedia();
  await client?.disconnect();
  client = null;
  if (state !== CallState.ended) setState(CallState.ended);
  haptic("medium");
  if (close) {
    try { telegram?.close(); } catch { window.TelegramWebviewProxy?.postEvent("web_app_close", {}); }
    if (!telegram) window.TelegramWebviewProxy?.postEvent("web_app_close", {});
  }
}

ui.call.addEventListener("click", () => state === CallState.speaking ? stopReply() : state === CallState.listening && !muted ? finishUtterance() : startCall());
ui.retry.addEventListener("click", () => state === CallState.error ? startCall() : undefined);
ui.hangup.addEventListener("click", () => hangup());
ui.mute.addEventListener("click", () => {
  muted = !muted;
  stream?.getAudioTracks().forEach((track) => { track.enabled = !muted; });
  resetVoiceActivity();
  if (muted) discardRecorderSegment();
  ui.mute.setAttribute("aria-pressed", String(muted));
  ui.mute.setAttribute("aria-label", muted ? "Unmute microphone" : "Mute microphone");
  ui.muteLabel.textContent = muted ? "Unmute" : "Mute";
  if (state === CallState.listening) ui.call.disabled = muted;
  ui.privacy.textContent = muted ? "Microphone muted · call stays in this conversation." : "Microphone active · audio is sent securely for this call.";
  haptic();
});
ui.echo.addEventListener("click", () => {
  echoControl = !echoControl;
  ui.echo.setAttribute("aria-pressed", String(echoControl));
  ui.echo.title = echoControl ? "Echo control enabled" : "Echo control disabled";
  ui.echo.setAttribute("aria-label", ui.echo.title);
  if (state !== CallState.idle) ui.privacy.textContent = "Echo control changes apply next time you connect.";
  haptic();
});
ui.transcriptToggle.addEventListener("click", () => {
  const visible = ui.transcriptToggle.getAttribute("aria-pressed") !== "true";
  ui.transcriptToggle.setAttribute("aria-pressed", String(visible));
  ui.transcriptPanel.hidden = !visible;
  haptic("soft");
});
ui.computerButton.addEventListener("click", () => {
  if (!host.canOpenComputer || ![CallState.listening, CallState.thinking, CallState.speaking].includes(state)) return;
  window.TelegramWebviewProxy?.postEvent("hermes_open_computer", {});
});

function applyHostPresentation() {
  if (host.botName) ui.name.textContent = host.botName;
  ui.portrait.alt = `${host.botName || "Hermes"} avatar`;
  if (host.avatarURL) {
    try {
      const avatarURL = new URL(host.avatarURL, location.href);
      if (avatarURL.origin === location.origin) ui.portrait.src = avatarURL.href;
    } catch {}
  } else if (host.avatarName && host.avatarName !== "hermes") {
    const safeName = String(host.avatarName).toLowerCase().replace(/[^a-z0-9_-]/g, "");
    if (safeName) ui.portrait.src = `assets/${safeName}.png`;
  }
  if (host.canOpenComputer) ui.computerButton.hidden = false;
}

function applyTelegramTheme() {
  const p = telegram?.themeParams || {};
  const root = document.documentElement;
  if (p.bg_color) root.style.setProperty("--bg", p.bg_color);
  if (p.text_color) root.style.setProperty("--text", p.text_color);
  if (p.hint_color) root.style.setProperty("--muted", p.hint_color);
  if (p.button_color) root.style.setProperty("--accent-strong", p.button_color);
  if (telegram?.safeAreaInset) {
    root.style.setProperty("--tg-safe-area-inset-top", `${telegram.safeAreaInset.top || 0}px`);
    root.style.setProperty("--tg-safe-area-inset-bottom", `${telegram.safeAreaInset.bottom || 0}px`);
  }
}

telegram?.onEvent?.("themeChanged", applyTelegramTheme);
telegram?.onEvent?.("viewportChanged", applyTelegramTheme);
window.addEventListener("pagehide", () => hangup({ close: false }));
document.addEventListener("visibilitychange", () => {
  if (document.hidden && [CallState.listening, CallState.thinking, CallState.speaking].includes(state)) hangup({ close: false });
});
window.addEventListener("HermesHostLifecycle", (event) => {
  if (event.detail?.state === "background") hangup({ close: false });
});
window.addEventListener("HermesHostAudioInterruption", (event) => {
  hostAudioInterrupted = Boolean(event.detail?.interrupted);
  if (!hostAudioInterrupted && event.detail?.shouldResume && audioContext?.state === "suspended") audioContext.resume().catch(() => {});
  if ([CallState.listening, CallState.thinking, CallState.speaking].includes(state)) {
    ui.detail.textContent = hostAudioInterrupted
      ? "Audio is temporarily interrupted. Your call is still connected."
      : state === CallState.speaking ? "Tap the center button to stop the audio." : "Speak naturally. I’ll respond after you pause.";
  }
});

applyHostPresentation();
applyTelegramTheme();
setState(CallState.idle);
window.HermesVoiceHangup = () => hangup({ close: false });
try {
  telegram?.ready();
  telegram?.expand();
  telegram?.requestFullscreen?.();
  telegram?.enableClosingConfirmation?.();
} catch {}

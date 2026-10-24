import { CallState, audioConstraints, audioLevel, createAttemptGuard, createVoiceDetector, encodeWav, transition } from "./lifecycle.js";
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
let audioContext;
let captureProcessor;
let playbackAnalyser;
let playbackSamples;
let microphoneSource;
let captureSink;
let audioSource;
let currentTurnId;
let pendingInterruptedTurn;
let turnNotice = "";
let aborter;
let detector;
let echoControl = true;
let muted = false;
let closed = false;
let hostAudioInterrupted = false;
let launchTicketConsumed = false;
let retryAllowed = true;
const attemptGuard = createAttemptGuard();
let activeAttempt = 0;

function setState(next) {
  if (state !== next) state = transition(state, next);
  ui.shell.dataset.state = state;
  const agentName = host.botName || "Hermes";
  const copy = {
    idle: ["READY WHEN YOU ARE", `Talk to ${agentName}`, "Your conversation continues with this agent."],
    "requesting-permission": ["MICROPHONE PERMISSION", "Allow microphone", "Your microphone stays off until you approve."],
    connecting: ["SECURE CONNECTION", "Connecting…", "Opening a voice call for this conversation."],
    listening: ["LISTENING", "I’m here", "Speak naturally. I’ll respond after you pause."],
    hearing: ["HEARING YOU", "Go ahead", "Pause when you are ready for a reply."],
    thinking: ["THINKING", "One moment…", "Your spoken turn is being handled by this agent."],
    speaking: [`${agentName.toLocaleUpperCase()} IS SPEAKING`, "Here’s what I found", "Speak to interrupt, or tap Stop reply."],
    error: ["CALL PAUSED", "Couldn’t connect", "Check your connection or microphone permission, then try again."],
    ended: ["CALL ENDED", "Talk soon", "Your call has ended."],
  }[state];
  [ui.stateLabel.textContent, ui.stateTitle.textContent, ui.detail.textContent] = copy;
  if (hostAudioInterrupted && [CallState.listening, CallState.hearing, CallState.thinking, CallState.speaking].includes(state)) {
    ui.detail.textContent = "Audio is temporarily interrupted. Your call is still connected.";
  }
  if (state === CallState.listening && turnNotice && !hostAudioInterrupted) ui.detail.textContent = turnNotice;
  const active = [CallState.listening, CallState.hearing, CallState.thinking, CallState.speaking].includes(state);
  ui.call.disabled = [CallState.requestingPermission, CallState.connecting, CallState.listening, CallState.hearing, CallState.thinking, CallState.ended].includes(state);
  ui.callLabel.textContent = state === CallState.speaking ? "Stop reply" : state === CallState.hearing ? "Hearing you" : state === CallState.listening ? "Listening" : state === CallState.thinking ? "Thinking…" : state === CallState.connecting ? "Connecting" : "Start call";
  ui.call.setAttribute("aria-label", state === CallState.speaking ? "Stop reply audio" : state === CallState.hearing ? "Hearing you" : state === CallState.listening ? "Listening" : "Start call");
  ui.mute.disabled = !active;
  ui.hangup.disabled = !active && state !== CallState.error && state !== CallState.connecting;
  ui.privacy.textContent = active ? (muted ? "Microphone muted · call stays in this conversation." : "Microphone active · audio is sent securely for this call.") : state === CallState.ended ? "Microphone and audio session released." : "Microphone is off until you start.";
  ui.errorPanel.hidden = state !== CallState.error;
  if (active && audioNeedsResume()) {
    ui.shell.dataset.state = "audio-paused";
    ui.stateLabel.textContent = "AUDIO PAUSED";
    ui.stateTitle.textContent = "Tap to resume audio";
    ui.detail.textContent = hostAudioInterrupted ? "Audio is temporarily interrupted. Your call is still connected." : "Tap to resume your microphone and reply audio.";
    ui.call.disabled = false;
    ui.callLabel.textContent = "Resume audio";
    ui.call.setAttribute("aria-label", "Resume call audio");
  }
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
  retryAllowed = Boolean(client?.call) || (!launchTicketConsumed && ![401, 403, 410].includes(error?.status));
  if ([401, 403, 410].includes(error?.status)) {
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
  if (!navigator.mediaDevices?.getUserMedia) {
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
      const callClient = client;
      try {
        await callClient.connect(aborter.signal);
        if (!attemptGuard.isCurrent(attempt) || closed) {
          await callClient.disconnect();
          return;
        }
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
  if (["suspended", "interrupted"].includes(audioContext.state)) await audioContext.resume();
  stream.getAudioTracks().forEach((track) => { track.enabled = !muted; });
  microphoneSource = audioContext.createMediaStreamSource(stream);
  // shortcut: capture uses the main thread; use AudioWorklet once supported hosts are verified.
  captureProcessor = audioContext.createScriptProcessor(2048, 1, 1);
  microphoneSource.connect(captureProcessor);
  captureSink = audioContext.createGain();
  captureSink.gain.value = 0;
  captureProcessor.connect(captureSink);
  captureSink.connect(audioContext.destination);
  detector = createVoiceDetector({ sampleRate: audioContext.sampleRate, echoControl });
  const captureStartedAt = Date.now();
  let heardSound = false;
  captureProcessor.onaudioprocess = (event) => {
    if (!stream?.active || closed) return;
    let playbackLevel = 0;
    if (audioSource && playbackAnalyser) {
      playbackAnalyser.getFloatTimeDomainData(playbackSamples);
      playbackLevel = audioLevel(playbackSamples);
    }
    const result = detector.sample(event.inputBuffer.getChannelData(0), {
      muted,
      interrupted: hostAudioInterrupted || audioContext.state !== "running" || state === CallState.thinking,
      speaking: state === CallState.speaking,
      playbackLevel,
    });
    ui.shell.style.setProperty("--mic-level", String(muted ? 0 : Math.min(1, result.level / 0.08)));
    if (!muted && result.level > 0.001) heardSound = true;
    if (result.started) {
      turnNotice = "";
      if (state === CallState.speaking) stopReplyForBargeIn(false);
      setState(CallState.hearing);
    }
    if (result.confirmed) confirmReplyInterrupt();
    if (result.utterance) finishUtterance(result.utterance);
    else if (state === CallState.hearing && !detector.hearing) {
      pendingInterruptedTurn = null;
      setState(CallState.listening);
    }
    if (state === CallState.listening && !hostAudioInterrupted && !audioNeedsResume()) {
      ui.detail.textContent = muted ? "Microphone muted."
        : turnNotice ? turnNotice
        : !heardSound && Date.now() - captureStartedAt >= 8_000
          ? "No microphone sound detected. Check your microphone input, then try speaking again."
          : "Speak naturally. I’ll respond after you pause.";
    }
  };
}

function unlockAudioOutput() {
  if (!audioContext) {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) throw new Error("This browser cannot play voice audio.");
    audioContext = new Context();
    audioContext.onstatechange = () => {
      if (audioNeedsResume()) {
        detector?.reset();
        if (state === CallState.hearing) setState(CallState.listening);
      }
      setState(state);
    };
  }
  if (audioNeedsResume()) return audioContext.resume().catch(() => {}).finally(() => setState(state));
  return Promise.resolve();
}

function audioNeedsResume() {
  return ["suspended", "interrupted"].includes(audioContext?.state);
}

async function finishUtterance(frames) {
  if (closed || ![CallState.listening, CallState.hearing].includes(state)) return;
  const attempt = activeAttempt;
  const turnId = crypto.randomUUID();
  currentTurnId = turnId;
  const callClient = client;
  const signal = aborter?.signal;
  const isCurrent = () => attemptGuard.isCurrent(attempt) && !closed && currentTurnId === turnId;
  let transcriptShown = false;
  let replyShown = false;
  const showTranscript = (result) => {
    if (!isCurrent()) return;
    const transcript = result.transcript || result.user_transcript;
    if (transcript && !transcriptShown) { addTranscript("You", transcript); transcriptShown = true; }
    if (result.reply_text && !replyShown) { addTranscript(host.botName || "Hermes", result.reply_text); replyShown = true; }
  };
  setState(CallState.thinking);
  try {
    const blob = encodeWav(frames, audioContext.sampleRate);
    showTranscript(await callClient.sendTurn(blob, turnId, signal));
    if (!isCurrent()) return;
    const result = await callClient.waitForTurn(turnId, signal, showTranscript);
    if (!isCurrent()) return;
    showTranscript(result);
    if (["failed", "cancelled", "rejected"].includes(result.status)) {
      turnNotice = result.reply_text ? "Reply audio is unavailable. Read the reply in the transcript." : "Could not complete this turn. Please try speaking again.";
      setState(CallState.listening);
      return;
    }
    if (result.playback_interrupted) { setState(CallState.listening); return; }
    const replyBlob = await callClient.getReplyAudio(turnId, result.audio_url, signal);
    if (!isCurrent()) return;
    await startReplyPlayback(replyBlob, isCurrent);
  } catch (error) {
    if (isCurrent() && error?.name !== "AbortError") {
      if (error?.status === 422) setState(CallState.listening);
      else if ([401, 403, 410].includes(error?.status)) showError(error);
      else {
        turnNotice = "Could not complete this turn. Please try speaking again.";
        setState(CallState.listening);
      }
    }
  }
}

async function startReplyPlayback(blob, isCurrent) {
  if (!audioContext) throw new Error("Audio output is unavailable. End and restart the call.");
  const context = audioContext;
  await unlockAudioOutput();
  if (!isCurrent()) return;
  const buffer = await context.decodeAudioData(await blob.arrayBuffer());
  if (!isCurrent()) return;
  const source = context.createBufferSource();
  source.buffer = buffer;
  playbackAnalyser = context.createAnalyser();
  playbackAnalyser.fftSize = 2048;
  playbackSamples = new Float32Array(playbackAnalyser.fftSize);
  source.connect(playbackAnalyser);
  playbackAnalyser.connect(context.destination);
  source.onended = () => {
    if (audioSource !== source) return;
    audioSource = null;
    source.disconnect();
    playbackAnalyser.disconnect();
    playbackAnalyser = null;
    detector?.reset();
    detector?.playbackEnded();
    if (isCurrent() && state === CallState.speaking) setState(CallState.listening);
  };
  detector.reset();
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
  source.disconnect();
  playbackAnalyser?.disconnect();
  playbackAnalyser = null;
}

function stopReplyForBargeIn(confirmed = true) {
  if (state !== CallState.speaking) return;
  stopPlayback();
  detector?.playbackEnded();
  pendingInterruptedTurn = currentTurnId;
  currentTurnId = null;
  if (confirmed) confirmReplyInterrupt();
  setState(CallState.listening);
  haptic("soft");
}

function confirmReplyInterrupt() {
  const turnId = pendingInterruptedTurn;
  pendingInterruptedTurn = null;
  if (turnId) client?.interrupt(turnId).catch(() => {
    addTranscript("Call", "Could not confirm the interrupted reply with the service. Its work continues in chat.");
  });
}

function stopReply() {
  detector?.reset();
  stopReplyForBargeIn();
}

function releaseMedia() {
  if (captureProcessor) captureProcessor.onaudioprocess = null;
  captureProcessor?.disconnect();
  captureProcessor = null;
  microphoneSource?.disconnect();
  captureSink?.disconnect();
  microphoneSource = null;
  captureSink = null;
  detector?.reset();
  ui.shell.style.setProperty("--mic-level", "0");
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
  if (state !== CallState.ended) setState(CallState.ended);
  await client?.disconnect();
  client = null;
  haptic("medium");
  if (close) {
    try { telegram?.close(); } catch { window.TelegramWebviewProxy?.postEvent("web_app_close", {}); }
    if (!telegram) window.TelegramWebviewProxy?.postEvent("web_app_close", {});
  }
}

ui.call.addEventListener("click", () => audioNeedsResume() ? unlockAudioOutput() : state === CallState.speaking ? stopReply() : startCall());
document.addEventListener("click", () => audioNeedsResume() ? unlockAudioOutput() : undefined);
ui.retry.addEventListener("click", () => state === CallState.error ? startCall() : undefined);
ui.hangup.addEventListener("click", () => hangup());
ui.mute.addEventListener("click", () => {
  muted = !muted;
  stream?.getAudioTracks().forEach((track) => { track.enabled = !muted; });
  detector?.reset();
  if (state === CallState.hearing) setState(CallState.listening);
  ui.mute.setAttribute("aria-pressed", String(muted));
  ui.mute.setAttribute("aria-label", muted ? "Unmute microphone" : "Mute microphone");
  ui.muteLabel.textContent = muted ? "Unmute" : "Mute";
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
  if (!host.canOpenComputer || ![CallState.listening, CallState.hearing, CallState.thinking, CallState.speaking].includes(state)) return;
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
telegram?.onEvent?.("deactivated", () => {
  if (state !== CallState.requestingPermission) hangup({ close: false });
});
window.addEventListener("pagehide", () => hangup({ close: false }));
document.addEventListener("visibilitychange", () => {
  if (document.hidden && [CallState.connecting, CallState.listening, CallState.hearing, CallState.thinking, CallState.speaking].includes(state)) hangup({ close: false });
});
window.addEventListener("HermesHostLifecycle", (event) => {
  if (event.detail?.state === "background") hangup({ close: false });
});
window.addEventListener("HermesHostAudioInterruption", async (event) => {
  hostAudioInterrupted = Boolean(event.detail?.interrupted);
  detector?.reset();
  if (state === CallState.hearing) setState(CallState.listening);
  setState(state);
  if (!hostAudioInterrupted && audioNeedsResume()) await unlockAudioOutput();
  setState(state);
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

export const CallState = Object.freeze({
  idle: "idle",
  requestingPermission: "requesting-permission",
  connecting: "connecting",
  listening: "listening",
  thinking: "thinking",
  speaking: "speaking",
  error: "error",
  ended: "ended",
});

const transitions = {
  idle: ["requesting-permission", "error", "ended"],
  "requesting-permission": ["connecting", "error", "ended"],
  connecting: ["listening", "error", "ended"],
  listening: ["thinking", "error", "ended"],
  thinking: ["speaking", "listening", "error", "ended"],
  speaking: ["listening", "thinking", "error", "ended"],
  error: ["requesting-permission", "ended"],
  ended: [],
};

export function canTransition(from, to) {
  return transitions[from]?.includes(to) ?? false;
}

export function transition(state, next) {
  if (!canTransition(state, next)) {
    throw new Error(`Invalid call transition: ${state} → ${next}`);
  }
  return next;
}

export function audioConstraints(echoControl = true) {
  return {
    audio: {
      echoCancellation: Boolean(echoControl),
      noiseSuppression: Boolean(echoControl),
      autoGainControl: Boolean(echoControl),
    },
    video: false,
  };
}

export function recordingMimeType(isTypeSupported) {
  const candidates = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"];
  return candidates.find((type) => isTypeSupported?.(type)) || "";
}

export function shouldInterruptPlayback({ state, level, muted, threshold = 0.055 }) {
  return state === CallState.speaking && !muted && level > threshold;
}

export function createAttemptGuard() {
  let generation = 0;
  return {
    begin() { generation += 1; return generation; },
    invalidate() { generation += 1; },
    isCurrent(attempt) { return attempt === generation; },
  };
}

/** A simple VAD gate. It only emits a turn after speech followed by silence. */
export const SPEECH_THRESHOLD = 0.01;

export function createSilenceGate({ threshold = SPEECH_THRESHOLD, silenceMs = 850, minimumSpeechMs = 280 } = {}) {
  let speechAt = 0;
  let quietAt = 0;
  return {
    sample(level, now = Date.now()) {
      if (level >= threshold) {
        if (!speechAt) speechAt = now;
        quietAt = 0;
        return false;
      }
      if (speechAt && !quietAt) quietAt = now;
      if (speechAt && quietAt && now - quietAt >= silenceMs) {
        const valid = now - speechAt >= minimumSpeechMs;
        speechAt = 0;
        quietAt = 0;
        return valid;
      }
      return false;
    },
    reset() { speechAt = 0; quietAt = 0; },
  };
}

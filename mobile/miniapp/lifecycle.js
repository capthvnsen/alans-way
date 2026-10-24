export const CallState = Object.freeze({
  idle: "idle",
  requestingPermission: "requesting-permission",
  connecting: "connecting",
  listening: "listening",
  hearing: "hearing",
  thinking: "thinking",
  speaking: "speaking",
  error: "error",
  ended: "ended",
});

const transitions = {
  idle: ["requesting-permission", "error", "ended"],
  "requesting-permission": ["connecting", "error", "ended"],
  connecting: ["listening", "error", "ended"],
  listening: ["hearing", "thinking", "error", "ended"],
  hearing: ["listening", "thinking", "error", "ended"],
  thinking: ["speaking", "listening", "error", "ended"],
  speaking: ["listening", "hearing", "thinking", "error", "ended"],
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

export function createAttemptGuard() {
  let generation = 0;
  return {
    begin() { generation += 1; return generation; },
    invalidate() { generation += 1; },
    isCurrent(attempt) { return attempt === generation; },
  };
}

export function audioLevel(samples) {
  let energy = 0;
  for (const value of samples) energy += value * value;
  return Math.sqrt(energy / samples.length);
}

export function createVoiceDetector({ sampleRate, echoControl = true, preRollMs = 250, silenceMs = 800, minimumSpeechMs = 280, maxUtteranceMs = 25_000 }) {
  let preRoll = [];
  let preRollSamples = 0;
  let utterance = [];
  let speechMs = 0;
  let quietMs = 0;
  let elapsedMs = 0;
  let candidate = [];
  let candidateMs = 0;
  let holdoffMs = 0;
  let lastPlaybackLevel = 0;
  const detector = {
    hearing: false,
    noiseFloor: 0.003,
    reset() {
      preRoll = [];
      preRollSamples = 0;
      utterance = [];
      speechMs = quietMs = elapsedMs = 0;
      detector.hearing = false;
      holdoffMs = 0;
      candidate = [];
      candidateMs = 0;
    },
    playbackEnded() {
      holdoffMs = 500;
    },
    sample(samples, { muted = false, interrupted = false, speaking = false, playbackLevel = 0 } = {}) {
      const level = audioLevel(samples);
      const result = { level, started: false };
      if (muted || interrupted) {
        detector.reset();
        return result;
      }
      const ms = samples.length / sampleRate * 1000;
      if (speaking) lastPlaybackLevel = playbackLevel;
      const playbackGated = speaking || holdoffMs > 0;
      const threshold = playbackGated
        ? Math.max(echoControl ? 0.055 : 0.09, detector.noiseFloor * 4, (speaking ? playbackLevel : lastPlaybackLevel) * (echoControl ? 1.5 : 2))
        : Math.max(0.01, detector.noiseFloor * 3);
      holdoffMs = Math.max(0, holdoffMs - ms);
      const voiced = level >= threshold;
      if (!detector.hearing && !voiced && !playbackGated) {
        detector.noiseFloor += (level - detector.noiseFloor) * (1 - Math.exp(-ms / 1000));
      }
      if (!detector.hearing) {
        if (!voiced) {
          candidate = [];
          candidateMs = 0;
          if (playbackGated) return result;
          preRoll.push(samples.slice());
          preRollSamples += samples.length;
          const excess = preRollSamples - Math.round(sampleRate * preRollMs / 1000);
          if (excess > 0) {
            let remaining = excess;
            while (preRoll.length && remaining >= preRoll[0].length) remaining -= preRoll.shift().length;
            if (remaining) preRoll[0] = preRoll[0].slice(remaining);
            preRollSamples -= excess;
          }
          return result;
        }
        if (playbackGated && candidateMs + ms < 170) {
          candidate.push(samples.slice());
          candidateMs += ms;
          return result;
        }
        utterance = preRoll.concat(candidate);
        speechMs = elapsedMs = candidateMs;
        candidate = [];
        candidateMs = 0;
        preRoll = [];
        preRollSamples = 0;
        detector.hearing = true;
        result.started = true;
      }
      utterance.push(samples.slice());
      elapsedMs += ms;
      const wasConfirmed = speechMs >= minimumSpeechMs;
      if (voiced) { speechMs += ms; quietMs = 0; }
      else quietMs += ms;
      result.confirmed = !wasConfirmed && speechMs >= minimumSpeechMs;
      if (quietMs >= silenceMs || elapsedMs >= maxUtteranceMs) {
        if (speechMs >= minimumSpeechMs) result.utterance = utterance;
        detector.reset();
      }
      return result;
    },
  };
  return detector;
}

export function encodeWav(frames, sampleRate) {
  const length = frames.reduce((total, frame) => total + frame.length, 0);
  const buffer = new ArrayBuffer(44 + length * 2);
  const view = new DataView(buffer);
  const text = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  text(0, "RIFF");
  view.setUint32(4, 36 + length * 2, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, length * 2, true);
  let offset = 44;
  for (const frame of frames) {
    for (const value of frame) {
      const sample = Math.max(-1, Math.min(1, value));
      view.setInt16(offset, sample * (sample < 0 ? 32768 : 32767), true);
      offset += 2;
    }
  }
  return new Blob([buffer], { type: "audio/wav" });
}

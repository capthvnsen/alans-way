import test from "node:test";
import assert from "node:assert/strict";
import { audioConstraints, CallState, canTransition, createAttemptGuard, createSilenceGate, recordingMimeType, shouldInterruptPlayback, transition } from "../lifecycle.js";

test("call can recover from a recoverable error but cannot resume after hangup", () => {
  assert.equal(transition(CallState.idle, CallState.requestingPermission), CallState.requestingPermission);
  assert.equal(canTransition(CallState.error, CallState.requestingPermission), true);
  assert.equal(canTransition(CallState.speaking, CallState.listening), true);
  assert.equal(canTransition(CallState.ended, CallState.requestingPermission), false);
  assert.throws(() => transition(CallState.ended, CallState.listening), /Invalid call transition/);
});

test("silence gate emits once after enough speech followed by a pause", () => {
  const gate = createSilenceGate({ threshold: 0.04, silenceMs: 500, minimumSpeechMs: 200 });
  assert.equal(gate.sample(0.08, 1000), false);
  assert.equal(gate.sample(0.08, 1200), false);
  assert.equal(gate.sample(0.01, 1250), false);
  assert.equal(gate.sample(0.01, 1749), false);
  assert.equal(gate.sample(0.01, 1750), true);
  assert.equal(gate.sample(0.01, 2200), false);
});

test("short noise is discarded and reset clears a partial utterance", () => {
  const gate = createSilenceGate({ threshold: 0.04, silenceMs: 300, minimumSpeechMs: 200 });
  gate.sample(0.08, 1000);
  assert.equal(gate.sample(0, 1300), false);
  gate.sample(0.08, 2000);
  gate.reset();
  assert.equal(gate.sample(0, 2400), false);
});

test("echo cancellation, noise reduction and gain control follow the user setting", () => {
  assert.deepEqual(audioConstraints(true), {
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false,
  });
  assert.deepEqual(audioConstraints(false), {
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false,
  });
});

test("hangup and retry invalidate older asynchronous call attempts", () => {
  const guard = createAttemptGuard();
  const first = guard.begin();
  assert.equal(guard.isCurrent(first), true);
  guard.invalidate();
  assert.equal(guard.isCurrent(first), false);
  const retry = guard.begin();
  assert.equal(guard.isCurrent(first), false);
  assert.equal(guard.isCurrent(retry), true);
});

test("recording format prefers iOS compatible MP4 when WebKit supports it", () => {
  const offered = [];
  const selected = recordingMimeType((type) => {
    offered.push(type);
    return type === "audio/mp4" || type === "audio/webm;codecs=opus";
  });
  assert.equal(selected, "audio/mp4");
  assert.deepEqual(offered, ["audio/mp4"]);
  assert.equal(recordingMimeType((type) => type === "audio/webm;codecs=opus"), "audio/webm;codecs=opus");
});

test("muting prevents microphone activity from interrupting Hermes playback", () => {
  assert.equal(shouldInterruptPlayback({ state: CallState.speaking, level: 0.09, muted: true }), false);
  assert.equal(shouldInterruptPlayback({ state: CallState.speaking, level: 0.09, muted: false }), true);
  assert.equal(shouldInterruptPlayback({ state: CallState.listening, level: 0.09, muted: false }), false);
});

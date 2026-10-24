import test from "node:test";
import assert from "node:assert/strict";
import { audioConstraints, CallState, canTransition, createAttemptGuard, transition } from "../lifecycle.js";

test("call can recover from a recoverable error but cannot resume after hangup", () => {
  assert.equal(transition(CallState.idle, CallState.requestingPermission), CallState.requestingPermission);
  assert.equal(canTransition(CallState.error, CallState.requestingPermission), true);
  assert.equal(canTransition(CallState.speaking, CallState.listening), true);
  assert.equal(canTransition(CallState.ended, CallState.requestingPermission), false);
  assert.throws(() => transition(CallState.ended, CallState.listening), /Invalid call transition/);
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

test("hearing is a distinct state that accepts speech from listening or playback", () => {
  assert.equal(transition(CallState.listening, CallState.hearing), CallState.hearing);
  assert.equal(transition(CallState.speaking, CallState.hearing), CallState.hearing);
  assert.equal(transition(CallState.hearing, CallState.thinking), CallState.thinking);
  assert.equal(transition(CallState.hearing, CallState.listening), CallState.listening);
});

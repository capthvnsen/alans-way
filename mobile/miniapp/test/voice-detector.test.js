import test from "node:test";
import assert from "node:assert/strict";
import { createVoiceDetector, encodeWav } from "../lifecycle.js";

const frame = (level, size = 100) => new Float32Array(size).fill(level);

test("speech keeps pre-roll and ends once after 800 ms of silence", () => {
  const detector = createVoiceDetector({ sampleRate: 1000 });
  for (let i = 0; i < 10; i++) detector.sample(frame(0.001));
  assert.equal(detector.sample(frame(0.03)).started, true);
  detector.sample(frame(0.03));
  detector.sample(frame(0.03));
  for (let i = 0; i < 7; i++) assert.equal(detector.sample(frame(0)).utterance, undefined);
  const { utterance } = detector.sample(frame(0));
  assert.equal(utterance.reduce((total, samples) => total + samples.length, 0), 1350);
  assert.equal(utterance[0][0], Math.fround(0.001));
  assert.equal(detector.sample(frame(0)).utterance, undefined);
  assert.equal(detector.hearing, false);
});

test("noise floor adapts without admitting background noise as speech", () => {
  const detector = createVoiceDetector({ sampleRate: 1000 });
  const initial = detector.noiseFloor;
  for (let i = 0; i < 50; i++) assert.equal(detector.sample(frame(0.008)).started, false);
  assert.ok(detector.noiseFloor > initial * 2);
  assert.equal(detector.sample(frame(0.018)).started, false);
  assert.equal(detector.sample(frame(0.04)).started, true);
});

test("brief noise is discarded and continuous speech is bounded", () => {
  const detector = createVoiceDetector({ sampleRate: 1000, maxUtteranceMs: 1000 });
  detector.sample(frame(0.1));
  for (let i = 0; i < 8; i++) assert.equal(detector.sample(frame(0)).utterance, undefined);
  assert.equal(detector.hearing, false);
  for (let i = 0; i < 9; i++) assert.equal(detector.sample(frame(0.1)).utterance, undefined);
  assert.ok(detector.sample(frame(0.1)).utterance);
});

test("playback gates echo but lets loud speech start a barge-in after sustained voice", () => {
  const detector = createVoiceDetector({ sampleRate: 1000 });
  for (let i = 0; i < 20; i++) {
    assert.equal(detector.sample(frame(0.08), { speaking: true, playbackLevel: 0.1 }).started, false);
  }
  for (let i = 0; i < 3; i++) assert.equal(detector.sample(frame(0.2, 43), { speaking: true, playbackLevel: 0.1 }).started, false);
  assert.equal(detector.sample(frame(0.2, 43), { speaking: true, playbackLevel: 0.1 }).started, true);
  assert.equal(detector.sample(frame(0.2, 43)).confirmed, false);
  assert.equal(detector.sample(frame(0.2, 43)).confirmed, true);
});

test("mute and temporary audio interruptions discard partial speech and pre-roll", () => {
  for (const blocked of [{ muted: true }, { interrupted: true }]) {
    const detector = createVoiceDetector({ sampleRate: 1000 });
    detector.sample(frame(0.1));
    detector.sample(frame(0.1), blocked);
    assert.equal(detector.hearing, false);
    for (let i = 0; i < 10; i++) assert.equal(detector.sample(frame(0)).utterance, undefined);
  }
});

test("PCM is encoded as a mono WAV with clipped signed 16-bit samples", async () => {
  const blob = encodeWav([new Float32Array([-2, 0, 2])], 48000);
  const bytes = new DataView(await blob.arrayBuffer());
  assert.equal(blob.type, "audio/wav");
  assert.equal(blob.size, 50);
  assert.equal(bytes.getUint32(24, true), 48000);
  assert.equal(bytes.getUint32(40, true), 6);
  assert.equal(bytes.getInt16(44, true), -32768);
  assert.equal(bytes.getInt16(46, true), 0);
  assert.equal(bytes.getInt16(48, true), 32767);
});


test("post-playback holdoff rejects a decaying echo tail without adapting the noise floor", () => {
  const detector = createVoiceDetector({ sampleRate: 1000 });
  detector.sample(frame(0.04), { speaking: true, playbackLevel: 0.04 });
  detector.playbackEnded();
  const floor = detector.noiseFloor;
  for (const level of [0.05, 0.04, 0.03, 0.02, 0.012]) {
    assert.equal(detector.sample(frame(level)).started, false);
    assert.equal(detector.noiseFloor, floor);
  }
  for (let i = 0; i < 8; i++) assert.equal(detector.sample(frame(0)).utterance, undefined);
  assert.equal(detector.sample(frame(0.03)).started, true);
  detector.sample(frame(0.03));
  detector.sample(frame(0.03));
  let result;
  for (let i = 0; i < 8; i++) result = detector.sample(frame(0));
  assert.ok(result.utterance);
});

test("disabling echo cancellation keeps a higher playback threshold", () => {
  const detector = createVoiceDetector({ sampleRate: 1000, echoControl: false });
  for (let i = 0; i < 10; i++) {
    assert.equal(detector.sample(frame(0.08), { speaking: true }).started, false);
  }
});


test("isolated loud blocks cannot accumulate into a playback interruption", () => {
  const detector = createVoiceDetector({ sampleRate: 1000 });
  for (let i = 0; i < 10; i++) {
    assert.equal(detector.sample(frame(0.2, 43), { speaking: true }).started, false);
    assert.equal(detector.sample(frame(0, 43), { speaking: true }).started, false);
  }
  assert.equal(detector.hearing, false);
});


test("speech starting near the end of holdoff keeps all voiced samples", () => {
  const detector = createVoiceDetector({ sampleRate: 1000 });
  detector.playbackEnded();
  for (let i = 0; i < 4; i++) detector.sample(frame(0));
  assert.equal(detector.sample(frame(0.1)).started, false);
  assert.equal(detector.sample(frame(0.1)).started, true);
  assert.equal(detector.sample(frame(0.1)).confirmed, true);
  let result;
  for (let i = 0; i < 8; i++) result = detector.sample(frame(0));
  assert.ok(result.utterance);
});

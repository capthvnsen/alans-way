import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import * as lifecycle from "../lifecycle.js";

class ElementMock {
  constructor() {
    this.dataset = {};
    this.hidden = false;
    this.disabled = false;
    this.attributes = {};
    this.listeners = new Map();
    this.style = { setProperty() {} };
    this.classList = { add() {}, remove() {} };
    this.textContent = "";
    this.src = "";
    this.alt = "";
    this.title = "";
    this.scrollHeight = 0;
  }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  append() {}
  async click() { return this.listeners.get("click")?.(); }
}

async function loadController({ turnFailureStatus } = {}) {
  const source = (await readFile(new URL("../call.js", import.meta.url), "utf8"))
    .replace(/^import \{.*?\} from "\.\/lifecycle\.js";\s*$/m, "const { CallState, SPEECH_THRESHOLD, audioConstraints, createAttemptGuard, createSilenceGate, recordingMimeType, shouldInterruptPlayback, transition } = globalThis.__lifecycle;")
    .replace(/^import \{ VoiceClient \} from "\.\/voice-client\.js";\s*$/m, "const VoiceClient = window.__TEST_VOICE_CLIENT__;");
  const ids = ["call-shell", "agent-name", "state-label", "state-title", "state-detail", "call-button", "call-button-label", "mute-button", "mute-label", "hangup-button", "echo-button", "privacy-note", "error-panel", "error-text", "retry-button", "portrait", "transcript-toggle", "transcript-panel", "transcript-list", "transcript-empty", "computer-button"];
  const elements = Object.fromEntries(ids.map((id) => [id, new ElementMock()]));
  const listeners = new Map();
  let now = 1_000;
  let level = 0.12;
  const frames = [];
  let captureCount = 0;
  const track = { enabled: true, stop() { this.stopped = true; } };
  const stream = () => ({
    active: true,
    getTracks: () => [track],
    getAudioTracks: () => [track],
  });
  class AudioContextMock {
    state = "running";
    async resume() {}
    async close() { this.state = "closed"; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
    createAnalyser() {
      return { fftSize: 512,
        connect() {},
        getFloatTimeDomainData(values) { for (let i = 0; i < values.length; i++) values[i] = Math.sin(i * Math.PI / 32) * level * Math.SQRT2; },
        getByteTimeDomainData(values) { for (let i = 0; i < values.length; i++) values[i] = Math.round(128 + Math.sin(i * Math.PI / 32) * level * Math.SQRT2 * 128); },
      };
    }
    createBufferSource() { return { connect() {}, start() {}, stop() {} }; }
  }
  class MediaRecorderMock {
    static isTypeSupported() { return false; }
    constructor() { this.state = "inactive"; this.mimeType = "audio/webm"; }
    start() { this.state = "recording"; }
    stop() {
      if (this.state === "inactive") return;
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob([new Uint8Array(1_400)], { type: this.mimeType }) });
      this.onstop?.();
    }
  }
  const connections = [];
  class VoiceClientMock {
    constructor(options) { this.options = options; this.call = null; this.sendCount = 0; connections.push(this); }
    async connect() { this.call = { call_id: "call-1", access_token: "token-1" }; }
    async sendTurn() { this.sendCount += 1; throw Object.assign(new Error("temporary turn failure"), { status: turnFailureStatus }); }
    async disconnect() { this.call = null; this.disconnected = true; }
  }
  const window = {
    Telegram: { WebApp: { initData: "genuine-init-data", ready() {}, expand() {}, close() {} } },
    __HERMES_HOST__: { botName: "Athena", avatarName: "athena" },
    __TEST_VOICE_CLIENT__: VoiceClientMock,
    MediaRecorder: MediaRecorderMock,
    AudioContext: AudioContextMock,
    addEventListener(name, callback) { listeners.set(name, callback); },
  };
  const document = {
    documentElement: { dataset: { voiceApi: "https://voice.example.test/call" }, style: { setProperty() {} } },
    hidden: false,
    getElementById(id) { return elements[id]; },
    createElement() { return new ElementMock(); },
    createTextNode(text) { return { text }; },
    addEventListener(name, callback) { listeners.set(`document:${name}`, callback); },
  };
  const history = { state: null, replaceState(_state, _title, url) { context.location.href = String(url); context.location.search = new URL(String(url)).search; } };
  const context = {
    window,
    document,
    navigator: { mediaDevices: { async getUserMedia() { captureCount += 1; return stream(); } } },
    MediaRecorder: MediaRecorderMock,
    URL,
    URLSearchParams,
    AbortController,
    Blob,
    crypto: { randomUUID: () => `turn-${captureCount}` },
    history,
    location: { href: "https://voice.example.test/call/?ticket=one-use-ticket", search: "?ticket=one-use-ticket", origin: "https://voice.example.test" },
    console: { error() {} },
    setTimeout,
    clearTimeout,
    requestAnimationFrame(callback) { frames.push(callback); return frames.length; },
    cancelAnimationFrame() {},
    Date: { now: () => now },
    __lifecycle: lifecycle,
  };
  vm.runInNewContext(source, context, { filename: "call.js" });
  return {
    elements, connections, frames, getLocation: () => context.location,
    setTime(value) { now = value; },
    setLevel(value) { level = value; },
    async frame() { const callback = frames.shift(); callback?.(); await new Promise((resolve) => setImmediate(resolve)); },
  };
}

test("actual call controller recovers an established call after a turn error and hangs up", async () => {
  const app = await loadController();
  assert.equal(app.elements["state-title"].textContent, "Talk to Athena");
  assert.equal(app.elements.portrait.alt, "Athena avatar");

  await app.elements["call-button"].click();
  assert.equal(app.connections.length, 1, `${app.elements["error-text"].textContent} / ${app.elements["call-shell"].dataset.state}`);
  assert.equal(app.connections[0].options.launchTicket, "one-use-ticket");
  assert.equal(new URL(app.connections[0].options.apiBase).origin, "https://voice.example.test");
  assert.equal(new URL(app.getLocation().href).search, "", "the consumed launch ticket is removed from browser history");

  app.setTime(1_000); app.setLevel(0.12); await app.frame();
  app.setTime(1_300); app.setLevel(0.12); await app.frame();
  app.setTime(1_500); app.setLevel(0); await app.frame();
  app.setTime(2_400); app.setLevel(0); await app.frame();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.elements["error-panel"].hidden, false);
  assert.equal(app.connections[0].call.call_id, "call-1");

  await app.elements["retry-button"].click();
  assert.equal(app.connections.length, 1, "resume must reuse the authorized call instead of consuming a missing ticket");
  assert.equal(app.elements["call-shell"].dataset.state, "listening");
  await app.elements["hangup-button"].click();
  assert.equal(app.connections[0].disconnected, true);
  assert.equal(app.elements["call-shell"].dataset.state, "ended");
});

test("a no-speech clip quietly resumes capture without consuming another launch", async () => {
  const app = await loadController({ turnFailureStatus: 422 });
  await app.elements["call-button"].click();
  for (const start of [1_000, 3_000]) {
    app.setTime(start); app.setLevel(0.12); await app.frame();
    app.setTime(start + 300); app.setLevel(0.12); await app.frame();
    app.setTime(start + 500); app.setLevel(0); await app.frame();
    app.setTime(start + 1_400); app.setLevel(0); await app.frame();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(app.elements["call-shell"].dataset.state, "listening");
    assert.equal(app.elements["error-panel"].hidden, true);
  }
  assert.equal(app.connections.length, 1);
  assert.equal(app.connections[0].sendCount, 2, "recording continues after the first quiet clip");
  await app.elements["hangup-button"].click();
});

test("quiet microphone speech triggers a voice turn after a pause", async () => {
  const app = await loadController({ turnFailureStatus: 422 });
  await app.elements["call-button"].click();
  app.setTime(1_000); app.setLevel(0.012); await app.frame();
  app.setTime(1_500); app.setLevel(0.012); await app.frame();
  app.setTime(1_600); app.setLevel(0.001); await app.frame();
  app.setTime(2_500); app.setLevel(0.001); await app.frame();
  assert.equal(app.connections[0].sendCount, 1, "quiet real input must reach the server");
  await app.elements["hangup-button"].click();
});

test("the active call button can send a recorded turn without waiting for detection", async () => {
  const app = await loadController({ turnFailureStatus: 422 });
  await app.elements["call-button"].click();
  assert.equal(app.elements["call-button-label"].textContent, "Send voice");
  await app.elements["call-button"].click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.connections[0].sendCount, 1);
  await app.elements["hangup-button"].click();
});

test("a silent microphone produces visible feedback instead of appearing healthy", async () => {
  const app = await loadController();
  await app.elements["call-button"].click();
  app.setTime(1_000); app.setLevel(0); await app.frame();
  app.setTime(10_000); app.setLevel(0); await app.frame();
  assert.match(app.elements["state-detail"].textContent, /No microphone sound/i);
  assert.equal(app.connections[0].sendCount, 0);
  await app.elements["hangup-button"].click();
});

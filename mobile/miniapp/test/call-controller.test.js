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
    this.children = [];
    this.src = "";
    this.alt = "";
    this.title = "";
    this.scrollHeight = 0;
  }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  append(...children) { this.children.push(...children); }
  async click() { return this.listeners.get("click")?.(); }
}

async function loadController({ turnFailureStatus, success = false, permission, audioReply, connection, turnResult, resume } = {}) {
  const source = (await readFile(new URL("../call.js", import.meta.url), "utf8"))
    .replace(/^import \{(.*?)\} from "\.\/lifecycle\.js";\s*$/m, "const {$1} = globalThis.__lifecycle;")
    .replace(/^import \{ VoiceClient \} from "\.\/voice-client\.js";\s*$/m, "const VoiceClient = window.__TEST_VOICE_CLIENT__;");
  const ids = ["call-shell", "agent-name", "state-label", "state-title", "state-detail", "call-button", "call-button-label", "mute-button", "mute-label", "hangup-button", "echo-button", "privacy-note", "error-panel", "error-text", "retry-button", "portrait", "transcript-toggle", "transcript-panel", "transcript-list", "transcript-empty", "computer-button"];
  const elements = Object.fromEntries(ids.map((id) => [id, new ElementMock()]));
  const listeners = new Map();
  let now = 1_000;
  let level = 0.12;
  let processor;
  const sources = [];
  let audioContext;
  const track = { enabled: true, stop() { this.stopped = true; } };
  const stream = () => ({
    active: true,
    getTracks: () => [track],
    getAudioTracks: () => [track],
  });
  class AudioContextMock {
    constructor() { audioContext = this; }
    state = "running";
    sampleRate = 8000;
    createScriptProcessor() { processor = { connect() {}, disconnect() {} }; return processor; }
    async decodeAudioData() { return {}; }
    async resume() { this.resumeCount = (this.resumeCount || 0) + 1; if (!resume || await resume(this)) this.setState("running"); }
    setState(value) { this.state = value; this.onstatechange?.(); }
    async close() { this.state = "closed"; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
    createAnalyser() {
      return { fftSize: 512,
        connect() {}, disconnect() {},
        getFloatTimeDomainData(values) { values.fill(0.02); },
      };
    }
    createBufferSource() {
      const source = { connect() {}, disconnect() {}, start() { this.started = true; }, stop() { this.stopped = true; } };
      sources.push(source);
      return source;
    }
  }
  const connections = [];
  class VoiceClientMock {
    constructor(options) { this.options = options; this.call = null; this.sendCount = 0; this.interrupted = []; connections.push(this); }
    async connect() { if (connection) await connection(); this.call = { call_id: "call-1", access_token: "token-1" }; }
    async sendTurn(blob) {
      this.sendCount += 1;
      this.lastBlob = blob;
      if (!success) throw Object.assign(new Error("temporary turn failure"), { status: turnFailureStatus });
      return { transcript: "spoken input" };
    }
    async waitForTurn(_turnId, _signal, onUpdate) {
      onUpdate?.({ transcript: "spoken input", reply_text: "early reply", status: "synthesizing" });
      return turnResult || { transcript: "spoken input", reply_text: "early reply", status: "completed" };
    }
    async getReplyAudio() { return audioReply ? audioReply() : new Blob(["reply"]); }
    async interrupt(turnId) { this.interrupted.push(turnId); }

    async disconnect() { this.call = null; this.disconnected = true; }
  }
  const window = {
    Telegram: { WebApp: { initData: "genuine-init-data", onEvent(name, callback) { listeners.set(`telegram:${name}`, callback); }, ready() {}, expand() {}, close() {} } },
    __HERMES_HOST__: { botName: "Athena", avatarName: "athena" },
    __TEST_VOICE_CLIENT__: VoiceClientMock,
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
  let turnCount = 0;
  const history = { state: null, replaceState(_state, _title, url) { context.location.href = String(url); context.location.search = new URL(String(url)).search; } };
  const context = {
    window,
    document,
    navigator: { mediaDevices: { async getUserMedia() { return permission ? permission(stream()) : stream(); } } },
    URL,
    URLSearchParams,
    AbortController,
    Blob,
    crypto: { randomUUID: () => `turn-${++turnCount}` },
    history,
    location: { href: "https://voice.example.test/call/?ticket=one-use-ticket", search: "?ticket=one-use-ticket", origin: "https://voice.example.test" },
    console: { error() {} },
    setTimeout,
    clearTimeout,
    Date: { now: () => now },
    __lifecycle: lifecycle,
  };
  vm.runInNewContext(source, context, { filename: "call.js" });
  return {
    elements, connections, sources, track, listeners, document, getAudioContext: () => audioContext, getLocation: () => context.location,
    setLevel(value) { level = value; },
    async frame(count = 1) {
      for (let i = 0; i < count; i++) {
        const samples = new Float32Array(800).fill(level);
        processor?.onaudioprocess?.({ inputBuffer: { getChannelData: () => samples } });
        now += 100;
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
    async speak() {
      this.setLevel(0.12); await this.frame(3);
      this.setLevel(0); await this.frame(8);
    },
  };
}

test("a transient turn error returns to listening and keeps the call connected", async () => {
  const app = await loadController();
  assert.equal(app.elements["state-title"].textContent, "Talk to Athena");
  assert.equal(app.elements.portrait.alt, "Athena avatar");

  await app.elements["call-button"].click();
  assert.equal(app.connections.length, 1, `${app.elements["error-text"].textContent} / ${app.elements["call-shell"].dataset.state}`);
  assert.equal(app.connections[0].options.launchTicket, "one-use-ticket");
  assert.equal(new URL(app.connections[0].options.apiBase).origin, "https://voice.example.test");
  assert.equal(new URL(app.getLocation().href).search, "", "the consumed launch ticket is removed from browser history");

  await app.speak();
  assert.equal(app.elements["error-panel"].hidden, true);
  assert.equal(app.elements["call-shell"].dataset.state, "listening");
  assert.match(app.elements["state-detail"].textContent, /try speaking again/i);
  assert.equal(app.connections[0].call.call_id, "call-1");

  await app.speak();
  assert.equal(app.connections.length, 1, "resume must reuse the authorized call instead of consuming a missing ticket");
  assert.equal(app.elements["call-shell"].dataset.state, "listening");
  await app.elements["hangup-button"].click();
  assert.equal(app.connections[0].disconnected, true);
  assert.equal(app.elements["call-shell"].dataset.state, "ended");
});

test("a no-speech clip quietly resumes capture without consuming another launch", async () => {
  const app = await loadController({ turnFailureStatus: 422 });
  await app.elements["call-button"].click();
  for (let turn = 0; turn < 2; turn++) {
    await app.speak();
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
  app.setLevel(0.012); await app.frame(5);
  app.setLevel(0.001); await app.frame(8);
  assert.equal(app.connections[0].sendCount, 1, "quiet real input must reach the server");
  await app.elements["hangup-button"].click();
});

test("speech is hands-free with a clear hearing state", async () => {
  const app = await loadController({ turnFailureStatus: 422 });
  await app.elements["call-button"].click();
  assert.equal(app.elements["call-button-label"].textContent, "Listening");
  app.setLevel(0.12); await app.frame(3);
  assert.equal(app.elements["call-shell"].dataset.state, "hearing");
  app.setLevel(0); await app.frame(8);
  assert.equal(app.connections[0].sendCount, 1);
  assert.equal(app.connections[0].lastBlob.type, "audio/wav");
  await app.elements["hangup-button"].click();
});

test("a silent microphone produces visible feedback instead of appearing healthy", async () => {
  const app = await loadController();
  await app.elements["call-button"].click();
  app.setLevel(0); await app.frame(91);
  assert.match(app.elements["state-detail"].textContent, /No microphone sound/i);
  assert.equal(app.connections[0].sendCount, 0);
  await app.elements["hangup-button"].click();
});

test("sustained barge-in stops playback and captures a fresh correlated turn", async () => {
  const app = await loadController({ success: true });
  await app.elements["call-button"].click();
  await app.speak();
  assert.equal(app.elements["call-shell"].dataset.state, "speaking");
  const firstSource = app.sources[0];
  const staleEnded = firstSource.onended;
  app.setLevel(0.025); await app.frame(10);
  assert.equal(firstSource.stopped, undefined, "playback echo must not interrupt");
  app.setLevel(0.12); await app.frame();
  assert.equal(firstSource.stopped, undefined, "a cough leaves the reply playing");
  app.setLevel(0); await app.frame(8);
  assert.deepEqual(app.connections[0].interrupted, []);
  app.setLevel(0.12); await app.frame(2);
  assert.equal(firstSource.stopped, true);
  assert.deepEqual(app.connections[0].interrupted, [], "200 ms stops local playback but does not delete broker audio");
  await app.frame();
  assert.deepEqual(app.connections[0].interrupted, ["turn-1"]);
  assert.equal(app.elements["call-shell"].dataset.state, "hearing");
  await app.frame(2);
  app.setLevel(0); await app.frame(8);
  assert.equal(app.connections[0].sendCount, 2);
  assert.equal(app.elements["call-shell"].dataset.state, "speaking");
  staleEnded();
  assert.equal(app.elements["call-shell"].dataset.state, "speaking", "an old playback callback cannot change the new turn");
  app.sources[1].onended();
  app.setLevel(0.04); await app.frame(3);
  app.setLevel(0.02); await app.frame(2);
  app.setLevel(0); await app.frame(8);
  assert.equal(app.connections[0].sendCount, 2, "speaker tail must not upload a turn");
  assert.equal(app.elements["call-shell"].dataset.state, "listening");
  await app.speak();
  assert.equal(app.connections[0].sendCount, 3, "listening resumes automatically after playback");
  await app.elements["hangup-button"].click();
});

test("mute discards partial speech and prevents turns and barge-in", async () => {
  const app = await loadController({ success: true });
  await app.elements["call-button"].click();
  app.setLevel(0.12); await app.frame();
  await app.elements["mute-button"].click();
  assert.equal(app.track.enabled, false);
  await app.frame(15);
  assert.equal(app.connections[0].sendCount, 0);
  await app.elements["mute-button"].click();
  assert.equal(app.track.enabled, true);
  await app.speak();
  await app.elements["mute-button"].click();
  app.setLevel(0.2); await app.frame(10);
  assert.equal(app.sources[0].stopped, undefined);
  assert.equal(app.connections[0].interrupted.length, 0);
  await app.elements["hangup-button"].click();
});

test("permission visibility changes and short interruptions keep the call connected", async () => {
  let grant;
  const app = await loadController({ success: true, permission: (stream) => new Promise((resolve) => { grant = () => resolve(stream); }) });
  const connecting = app.elements["call-button"].click();
  app.document.hidden = true;
  app.listeners.get("document:visibilitychange")();
  assert.equal(app.elements["call-shell"].dataset.state, "requesting-permission");
  app.document.hidden = false;
  grant(); await connecting;
  app.setLevel(0.12); await app.frame();
  app.listeners.get("HermesHostAudioInterruption")({ detail: { interrupted: true } });
  await app.frame(15);
  assert.equal(app.connections[0].sendCount, 0);
  assert.notEqual(app.elements["call-shell"].dataset.state, "ended");
  app.listeners.get("HermesHostAudioInterruption")({ detail: { interrupted: false, shouldResume: true } });
  await app.speak();
  assert.equal(app.elements["call-shell"].dataset.state, "speaking");
  await app.elements["hangup-button"].click();
});

test("background during playback releases the mic and stops audio", async () => {
  const app = await loadController({ success: true });
  await app.elements["call-button"].click();
  await app.speak();
  app.document.hidden = true;
  app.listeners.get("document:visibilitychange")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.track.stopped, true);
  assert.equal(app.sources[0].stopped, true);
  assert.equal(app.elements["call-shell"].dataset.state, "ended");
  assert.equal(app.connections[0].disconnected, true);
});

test("early text appears once and delayed audio cannot play after background", async () => {
  let finishAudio;
  const app = await loadController({ success: true, audioReply: () => new Promise((resolve) => { finishAudio = resolve; }) });
  await app.elements["call-button"].click();
  await app.speak();
  assert.equal(app.elements["transcript-list"].children.length, 2);
  app.listeners.get("HermesHostLifecycle")({ detail: { state: "background" } });
  finishAudio(new Blob(["late reply"]));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.sources.length, 0);
  assert.equal(app.track.stopped, true);
  assert.equal(app.elements["call-shell"].dataset.state, "ended");
});

test("Telegram deactivation ignores permission prompts and ends an active call", async () => {
  let grant;
  const app = await loadController({ permission: (stream) => new Promise((resolve) => { grant = () => resolve(stream); }) });
  const connecting = app.elements["call-button"].click();
  app.listeners.get("telegram:deactivated")();
  assert.equal(app.elements["call-shell"].dataset.state, "requesting-permission");
  grant(); await connecting;
  app.listeners.get("telegram:deactivated")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.track.stopped, true);
  assert.equal(app.elements["call-shell"].dataset.state, "ended");
});

test("background during connection revokes a credential that arrives late", async () => {
  let connected;
  const app = await loadController({ connection: () => new Promise((resolve) => { connected = resolve; }) });
  const connecting = app.elements["call-button"].click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.elements["call-shell"].dataset.state, "connecting");
  app.document.hidden = true;
  app.listeners.get("document:visibilitychange")();
  connected(); await connecting;
  assert.equal(app.connections[0].call, null);
  assert.equal(app.track.stopped, true);
  assert.equal(app.elements["call-shell"].dataset.state, "ended");
});


test("a failed turn with reply text displays it once and resumes listening", async () => {
  const app = await loadController({ success: true, turnResult: { status: "failed", reply_text: "early reply", error: "TTS failed" } });
  await app.elements["call-button"].click();
  await app.speak();
  assert.equal(app.elements["call-shell"].dataset.state, "listening");
  assert.equal(app.elements["transcript-list"].children.length, 2);
  assert.equal(app.elements["transcript-list"].children[1].children[1].text, "early reply");
  assert.equal(app.sources.length, 0);
  assert.equal(app.track.stopped, undefined);
  assert.match(app.elements["state-detail"].textContent, /transcript/i);
  await app.elements["hangup-button"].click();
});

for (const status of [401, 403, 410]) {
  test(`auth or expired call error ${status} releases media and forbids resuming`, async () => {
    const app = await loadController({ turnFailureStatus: status });
    await app.elements["call-button"].click();
    await app.speak();
    assert.equal(app.elements["call-shell"].dataset.state, "error");
    assert.equal(app.track.stopped, true);
    assert.equal(app.connections[0].disconnected, true);
    assert.equal(app.elements["retry-button"].textContent, "Close");
    await app.elements["hangup-button"].click();
  });
}


for (const replyPlaying of [false, true]) {
  test(`audio interruption without shouldResume recovers while ${replyPlaying ? "speaking" : "listening"}`, async () => {
    const app = await loadController({ success: true });
    await app.elements["call-button"].click();
    if (replyPlaying) await app.speak();
    const context = app.getAudioContext();
    context.setState("suspended");
    app.listeners.get("HermesHostAudioInterruption")({ detail: { interrupted: true } });
    await app.listeners.get("HermesHostAudioInterruption")({ detail: { interrupted: false, shouldResume: false } });
    assert.equal(context.state, "running");
    assert.equal(context.resumeCount, 1);
    assert.equal(app.elements["call-shell"].dataset.state, replyPlaying ? "speaking" : "listening");
    await app.elements["hangup-button"].click();
  });
}

test("blocked audio resume shows a tappable state and retries on the next tap", async () => {
  let allowResume = false;
  const app = await loadController({ success: true, resume: () => allowResume });
  await app.elements["call-button"].click();
  const context = app.getAudioContext();
  context.setState("interrupted");
  app.listeners.get("HermesHostAudioInterruption")({ detail: { interrupted: true } });
  await app.listeners.get("HermesHostAudioInterruption")({ detail: { interrupted: false } });
  assert.equal(context.resumeCount, 1);
  assert.equal(app.elements["call-shell"].dataset.state, "audio-paused");
  assert.equal(app.elements["state-title"].textContent, "Tap to resume audio");
  assert.equal(app.elements["call-button"].disabled, false);
  app.setLevel(0.12); await app.frame(15);
  assert.equal(app.connections[0].sendCount, 0);
  allowResume = true;
  await app.elements["call-button"].click();
  assert.equal(context.state, "running");
  assert.equal(app.elements["call-shell"].dataset.state, "listening");
  context.setState("suspended");
  assert.equal(app.elements["call-shell"].dataset.state, "audio-paused");
  await app.listeners.get("document:click")();
  assert.equal(context.state, "running");
  await app.speak();
  assert.equal(app.connections[0].sendCount, 1);
  await app.elements["hangup-button"].click();
});


test("speaker tail after a short barge-in cannot confirm a broker interrupt", async () => {
  const app = await loadController({ success: true });
  await app.elements["call-button"].click();
  await app.speak();
  app.setLevel(0.12); await app.frame(2);
  assert.equal(app.sources[0].stopped, true);
  app.setLevel(0.03); await app.frame(3);
  app.setLevel(0); await app.frame(8);
  assert.deepEqual(app.connections[0].interrupted, []);
  assert.equal(app.connections[0].sendCount, 1);
  await app.elements["hangup-button"].click();
});


test("a pending browser resume does not block a fresh resume from a user tap", async () => {
  let allowResume = false;
  const app = await loadController({ success: true, resume: () => allowResume ? true : new Promise(() => {}) });
  await app.elements["call-button"].click();
  const context = app.getAudioContext();
  context.setState("suspended");
  app.listeners.get("HermesHostAudioInterruption")({ detail: { interrupted: false } });
  assert.equal(app.elements["call-shell"].dataset.state, "audio-paused");
  allowResume = true;
  const tapped = app.elements["call-button"].click();
  assert.equal(context.resumeCount, 2);
  await tapped;
  assert.equal(context.state, "running");
  await app.elements["hangup-button"].click();
});

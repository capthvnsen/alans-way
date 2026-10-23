import test from "node:test";
import assert from "node:assert/strict";
import { VoiceClient } from "../voice-client.js";

function response(status, payload, body = null) {
  return { ok: status < 400, status, json: async () => payload, blob: async () => body };
}

test("default browser fetch keeps its Window receiver throughout the call", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = function (url, options) {
    // WKWebView brand-checks Window.fetch. Calling a captured reference as
    // client.fetch() supplies the VoiceClient as its receiver instead.
    if (this !== globalThis) throw new TypeError("Can only call Window.fetch on instances of Window");
    requests.push({ url: String(url), options });
    if (String(url).endsWith("/audio")) return Promise.resolve(response(200, {}, new Blob(["reply"])));
    if (String(url).endsWith("/turns/t1")) return Promise.resolve(response(200, { status: "completed" }));
    return Promise.resolve(response(200, { call_id: "c1", access_token: "scoped" }));
  };
  try {
    const client = new VoiceClient({ apiBase: "https://voice.example.test", initData: "signed", launchTicket: "ticket" });
    await client.connect();
    await client.sendTurn(new Blob(["voice"], { type: "audio/mp4" }), "t1");
    await client.waitForTurn("t1");
    await client.getReplyAudio("t1");
    await client.interrupt("t1");
    await client.disconnect();
    assert.equal(requests.length, 6);
    assert.equal(requests.at(-1).options.method, "DELETE");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("voice requests send Telegram auth data only to the same secure origin", async () => {
  const seen = [];
  const client = new VoiceClient({
    apiBase: "https://voice.example.test",
    initData: "signed-init-data",
    launchTicket: "one-time-ticket",
    fetchImpl: async (url, options) => {
      seen.push({ url: String(url), options });
      return response(200, { call_id: "c1", access_token: "scoped" });
    },
  });
  await client.connect();
  assert.equal(seen[0].url, "https://voice.example.test/v1/calls");
  assert.deepEqual(JSON.parse(seen[0].options.body), { init_data: "signed-init-data", launch_ticket: "one-time-ticket" });
  assert.throws(() => new VoiceClient({ apiBase: "http://voice.example.test" }), /HTTPS/);
});

test("accepted voice turn polls its exact turn identity through completion", async () => {
  const seen = [];
  let checks = 0;
  const client = new VoiceClient({
    apiBase: "https://voice.example.test",
    initData: "signed",
    launchTicket: "ticket",
    fetchImpl: async (url, options) => {
      seen.push({ url: String(url), options });
      if (String(url).endsWith("/v1/calls")) return response(200, { call_id: "c2", access_token: "token" });
      if (String(url).endsWith("/turns")) return response(202, { call_id: "c2", turn_id: "t2", status: "accepted" });
      checks += 1;
      return response(200, checks === 1 ? { status: "running" } : { status: "completed", reply_text: "Hello" });
    },
  });
  await client.connect();
  const turn = await client.sendTurn(new Blob(["voice"], { type: "audio/webm" }), "t2");
  assert.equal(turn.status, "accepted");
  const completed = await client.waitForTurn("t2");
  assert.equal(completed.reply_text, "Hello");
  assert.match(seen.at(-1).url, /\/v1\/calls\/c2\/turns\/t2$/);
  assert.equal(seen.at(-1).options.headers.Authorization, "Bearer token");
});

test("a canceled poll stops waiting and does not submit another request", async () => {
  let requests = 0;
  const controller = new AbortController();
  const client = new VoiceClient({
    apiBase: "https://voice.example.test",
    fetchImpl: async () => {
      requests += 1;
      if (requests === 2) controller.abort();
      return response(200, { call_id: "c3", access_token: "token" });
    },
  });
  await client.connect();
  await assert.rejects(client.waitForTurn("t3", controller.signal), { name: "AbortError" });
  assert.equal(requests, 2);
});

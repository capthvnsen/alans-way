export class VoiceClient {
  constructor({ apiBase = globalThis.location?.origin || "https://localhost", fetchImpl = globalThis.fetch.bind(globalThis), initData, launchTicket }) {
    this.apiBase = new URL(apiBase, globalThis.location?.href || apiBase);
    if (this.apiBase.protocol !== "https:" && this.apiBase.hostname !== "localhost") {
      throw new Error("Voice service must use a secure HTTPS connection.");
    }
    this.fetch = fetchImpl;
    this.initData = initData;
    this.launchTicket = launchTicket;
    this.call = null;
  }

  async connect(signal) {
    const response = await this.fetch(new URL("/v1/calls", this.apiBase), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ init_data: this.initData, launch_ticket: this.launchTicket }),
      signal,
    });
    const payload = await this.#json(response);
    if (!payload.call_id || !payload.access_token) throw new Error("The call service returned an incomplete session.");
    this.call = payload;
    return payload;
  }

  async sendTurn(blob, turnId, signal) {
    if (!this.call) throw new Error("The voice call is not connected.");
    const body = new FormData();
    const filenameExtension = blob.type.toLowerCase().includes("mp4") ? "m4a" : "webm";
    body.append("audio", blob, `turn-${turnId}.${filenameExtension}`);
    body.append("turn_id", turnId);
    body.append("mime_type", blob.type || "audio/webm");
    const response = await this.fetch(new URL(`/v1/calls/${encodeURIComponent(this.call.call_id)}/turns`, this.apiBase), {
      method: "POST",
      headers: { Authorization: `Bearer ${this.call.access_token}` },
      body,
      signal,
    });
    return this.#json(response);
  }

  async waitForTurn(turnId, signal) {
    if (!this.call) throw new Error("The voice call is not connected.");
    const url = new URL(`/v1/calls/${encodeURIComponent(this.call.call_id)}/turns/${encodeURIComponent(turnId)}`, this.apiBase);
    const started = Date.now();
    while (Date.now() - started < 120_000) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const response = await this.fetch(url, {
        headers: { Authorization: `Bearer ${this.call.access_token}` }, signal,
      });
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const result = await this.#json(response);
      if (result.status === "completed") return result;
      if (["failed", "cancelled", "rejected"].includes(result.status)) {
        throw new Error(result.error || "The voice turn could not be completed.");
      }
      await wait(900, signal);
    }
    throw new Error("Hermes is taking longer than expected. You can end the call and continue in chat.");
  }

  async getReplyAudio(turnId, audioUrl, signal) {
    if (!this.call) throw new Error("The voice call is not connected.");
    const url = audioUrl ? new URL(audioUrl, this.apiBase) : new URL(`/v1/calls/${encodeURIComponent(this.call.call_id)}/turns/${encodeURIComponent(turnId)}/audio`, this.apiBase);
    if (url.origin !== this.apiBase.origin) throw new Error("The audio reply came from an untrusted origin.");
    const response = await this.fetch(url, {
      headers: { Authorization: `Bearer ${this.call.access_token}` }, signal,
    });
    if (!response.ok) throw await this.#error(response);
    return response.blob();
  }

  async interrupt(turnId) {
    if (!this.call || !turnId) return;
    await this.fetch(new URL(`/v1/calls/${encodeURIComponent(this.call.call_id)}/turns/${encodeURIComponent(turnId)}/interrupt`, this.apiBase), {
      method: "POST",
      headers: { Authorization: `Bearer ${this.call.access_token}` },
    });
  }

  async disconnect() {
    if (!this.call) return;
    const { call_id, access_token } = this.call;
    this.call = null;
    await this.fetch(new URL(`/v1/calls/${encodeURIComponent(call_id)}`, this.apiBase), {
      method: "DELETE",
      headers: { Authorization: `Bearer ${access_token}` },
      keepalive: true,
    }).catch(() => {});
  }

  async #json(response) {
    if (!response.ok) throw await this.#error(response);
    return response.json();
  }

  async #error(response) {
    let message = response.status === 403
      ? "This call link expired. Run /call in this chat to get a fresh one."
      : response.status === 401
        ? "Telegram could not verify this launch. Open Call again from the bot chat."
        : `Voice service error (${response.status}).`;
    try {
      const readable = response.clone ? response.clone() : response;
      const payload = await readable.json();
      if (typeof payload.error === "string") message = payload.error;
      else if (typeof payload.message === "string") message = payload.message;
    } catch {
      try {
        const readable = response.clone ? response.clone() : response;
        const text = await readable.text();
        if (text) message = text;
      } catch {}
    }
    const error = new Error(message);
    error.status = response.status;
    return error;
  }
}

function wait(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException("Aborted", "AbortError")); return; }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

import { assertApiFootballPayload } from "../../src/apiFootballPayload.js";
import { PROVIDER_TIMEOUT_MS } from "./budget.mjs";

const origin = "https://v3.football.api-sports.io";
const MAX_BODY_BYTES = 8 * 1024 * 1024;

async function readPayload(response) {
  const reader = response.body?.getReader();
  if (!reader) throw Error("Provider response has no body");
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) throw Error("Provider response exceeds size limit");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { await reader.cancel(); }
}

export class ScoreProvider {
  constructor({ store, apiKey, fetch = globalThis.fetch, now = Date.now }) {
    if (!store || !apiKey) throw Error("Provider storage and API key are required");
    this.store = store;
    this.apiKey = apiKey;
    this.fetch = fetch;
    this.now = now;
  }

  async request(lease, path, { priority = "supplementary" } = {}) {
    const url = new URL(path, origin);
    if (url.origin !== origin || url.username || url.password || url.hash || !path.startsWith("/"))
      throw Error("Invalid provider path");
    const admission = await this.store.reserve(lease, priority);
    if (!admission.allowed) return admission;
    const { permit } = admission;
    // A committed reservation is never reusable, even if its reply was lost.
    if (this.now() >= permit.dispatchBy || this.now() >= lease.expiresAt) throw Error("Provider dispatch window expired");
    const signal = AbortSignal.timeout(Math.min(PROVIDER_TIMEOUT_MS, permit.expiresAt - this.now()));
    let response, body, failure, observedAt;
    try {
      response = await this.fetch(url, { headers: { "x-apisports-key": this.apiKey }, redirect: "error", signal });
      body = await readPayload(response);
      if (!response.ok) throw Error(`Provider HTTP ${response.status}`);
      assertApiFootballPayload(body);
      observedAt = this.now();
    } catch (error) { failure = error; }
    await this.store.finish(lease, permit, { ok: !failure, status: response?.status, headers: response?.headers, errors: body?.errors });
    if (failure) throw failure;
    return { allowed: true, payload: body, observedAt };
  }
}

import { createScoreReadApi } from "./snapshots.mjs";
import { createDetailReadApi } from "./detail-read.mjs";
import { normalizeSeasons } from "./config.mjs";

export function createReadHandler({ store, seasons, now = Date.now }) {
  const api = createScoreReadApi({ readSnapshot: (code, season) => store.read(code, season), seasons: normalizeSeasons(seasons), now });
  const detail = createDetailReadApi({ store, seasons: normalizeSeasons(seasons), now });
  return async event => {
    let response;
    try {
      if (event.version !== "2.0" || typeof event.rawPath !== "string" || !event.rawPath.startsWith("/")) throw Error("Invalid gateway event");
      const url = new URL("https://scores.invalid"); url.pathname = event.rawPath;
      response = await (url.pathname.includes("/match/") ? detail : api)(new Request(url, { method: event.requestContext?.http?.method ?? "" }));
    } catch { response = Response.json({ error: "invalid request" }, { status: 400 }); }
    return { statusCode: response.status, headers: Object.fromEntries(response.headers), body: await response.text(), isBase64Encoded: false };
  };
}

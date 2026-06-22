// Goon Squad data API (Cloudflare Worker).
//
// Proxies football-data.org so the static site can poll for live data many times a
// minute without a deploy. The API token lives here as a Worker secret and never
// reaches the browser.
//
// Abuse hardening:
//   - Per-IP rate limit (binding) blocks single-source floods. Cloudflare's network
//     absorbs volumetric/distributed DDoS automatically on top of this.
//   - /match/:id is validated against the real fixture list, so id enumeration cannot
//     amplify into unbounded upstream calls and burn the 30/min token limit.
//   - Upstream calls are edge-cached, so a crowd of pollers collapses into roughly one
//     upstream call per cache window. A per-isolate copy of the last good /live is
//     served if upstream errors (stale-on-error).
//   - CORS is restricted to the site origin so other sites cannot freeload the quota.
//   - Errors are generic; no token or upstream detail is leaked.
//
// Endpoints: GET /live, GET /match/:id, GET /health.

import { mapFootballDataMatches } from "../src/domain.js";
import { mapMatchDetail } from "../src/mapDetail.js";

const API = "https://api.football-data.org";

// Sentry ingest target for the tunnel. Only envelopes whose DSN matches this exact
// host + project are relayed, so the tunnel can't be used as an open relay.
const SENTRY_HOST = "o4511587918479360.ingest.de.sentry.io";
const SENTRY_PROJECT = "4511587923066960";

const ALLOWED_ORIGINS = new Set([
  "https://henderjm.github.io",
  "http://localhost:8731",
  "http://127.0.0.1:8731",
]);

// Banter: the allowed reaction set and how long reactions/messages live in KV. A fixed
// allowlist stops the store being used to stash arbitrary strings, and the TTL means
// banter self-cleans after the tournament with no maintenance.
const REACTIONS = ["🔥", "😂", "😱", "🧂", "🐐", "💀"];
const BANTER_TTL = 60 * 24 * 60 * 60; // 60 days

// Best-effort stale fallback held in the isolate's memory.
let lastLive = null;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request);

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    // Per-IP rate limit (configured via the rate-limit binding). Generous for real
    // pollers, blocks single-source hammering. No-op if the binding is absent.
    if (env.LIMITER) {
      const ip = request.headers.get("CF-Connecting-IP") || "anon";
      try {
        const { success } = await env.LIMITER.limit({ key: ip });
        if (!success) return json({ error: "rate limited" }, 429, { ...cors, "Retry-After": "30" });
      } catch {
        // limiter unavailable, fail open
      }
    }

    // Sentry tunnel: relay browser error/replay envelopes server-side, so ad/tracker
    // blockers that block the Sentry ingest domain cannot drop them.
    if (url.pathname === "/tunnel" && request.method === "POST") {
      return tunnelToSentry(request, cors);
    }

    const token = env.FOOTBALL_DATA_TOKEN;
    if (!token) return json({ error: "service not configured" }, 500, cors);
    const competition = env.FOOTBALL_DATA_COMPETITION || "WC";
    const season = env.FOOTBALL_DATA_SEASON || "2026";

    // Banter: shared per-match reactions and one-line messages in KV. GET reads the
    // current state, POST toggles a reaction or appends a message. The match id is
    // validated against the real fixtures so junk ids cannot fill storage.
    const banterRoute = url.pathname.match(/^\/banter\/(\d{1,12})$/);
    if (banterRoute) {
      return handleBanter(request, env, Number(banterRoute[1]), competition, season, token, cors);
    }

    if (request.method !== "GET") return json({ error: "method not allowed" }, 405, cors);

    try {
      if (url.pathname === "/live") {
        const data = await getLive(competition, season, token);
        return json(data, 200, { ...cors, "Cache-Control": "public, max-age=15" });
      }

      const detailRoute = url.pathname.match(/^\/match\/(\d{1,12})$/);
      if (detailRoute) {
        const id = Number(detailRoute[1]);
        const live = await getLive(competition, season, token);
        if (!live.matches.some((match) => match.id === id)) {
          return json({ error: "unknown match" }, 404, cors);
        }
        const detail = await fetchJson(`/v4/matches/${id}`, token, 25);
        return json(mapMatchDetail(detail), 200, { ...cors, "Cache-Control": "public, max-age=25" });
      }

      if (url.pathname === "/" || url.pathname === "/health") {
        return json({ ok: true, service: "goon-squad-data" }, 200, cors);
      }
      return json({ error: "not found" }, 404, cors);
    } catch {
      return json({ error: "upstream unavailable" }, 502, cors);
    }
  },
};

async function getLive(competition, season, token) {
  try {
    const [matches, standings] = await Promise.all([
      fetchJson(`/v4/competitions/${competition}/matches?season=${season}`, token, 15),
      fetchJson(`/v4/competitions/${competition}/standings`, token, 30),
    ]);
    const body = {
      source: "football-data.org",
      lastUpdated: new Date().toISOString(),
      competition,
      season,
      matches: mapFootballDataMatches(matches),
      standings: standings.standings ?? [],
    };
    lastLive = body;
    return body;
  } catch (error) {
    if (lastLive) return lastLive; // serve stale rather than fail when upstream blips
    throw error;
  }
}

async function tunnelToSentry(request, cors) {
  try {
    const body = await request.arrayBuffer();
    const header = JSON.parse(new TextDecoder().decode(body).split("\n", 1)[0]);
    const dsn = new URL(header.dsn);
    if (dsn.hostname !== SENTRY_HOST || dsn.pathname.replace(/^\//, "") !== SENTRY_PROJECT) {
      return json({ error: "dsn not allowed" }, 403, cors);
    }
    const upstream = await fetch(`https://${SENTRY_HOST}/api/${SENTRY_PROJECT}/envelope/`, {
      method: "POST",
      body,
      headers: { "Content-Type": "application/x-sentry-envelope" },
    });
    return new Response(null, { status: upstream.status, headers: cors });
  } catch {
    return json({ error: "bad envelope" }, 400, cors);
  }
}

// -- Banter (KV-backed) ------------------------------------------------------
// Stored as one JSON blob per match under banter:<id>:
//   { reactions: { <uid>: [emoji, ...] }, messages: [{ name, text, ts }, ...] }
// Read with get() and written whole. An earlier design used one key per item and read
// them back with list(), but KV list() is eventually consistent and does not reflect a
// just-written key for up to ~a minute, so fresh posts vanished on the next read. A
// single key read with get() reflects the write immediately for the writer, and the
// POST handler returns the in-memory state it just wrote, so a posted comment never
// depends on KV propagation to show up. Concurrent writers can clobber (last write
// wins); acceptable for a small group, and the trade for staying on simple KV.

async function handleBanter(request, env, id, competition, season, token, cors) {
  if (!env.BANTER) return json({ error: "banter not configured" }, 503, cors);
  try {
    const live = await getLive(competition, season, token);
    if (!live.matches.some((match) => match.id === id)) {
      return json({ error: "unknown match" }, 404, cors);
    }
  } catch {
    return json({ error: "upstream unavailable" }, 502, cors);
  }

  if (request.method === "GET") {
    const uid = cleanUid(new URL(request.url).searchParams.get("uid"));
    const state = await readBanterState(env, id);
    return json(aggregateBanter(state, uid), 200, cors);
  }
  if (request.method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "bad body" }, 400, cors);
    }
    const uid = cleanUid(body.uid);
    if (!uid) return json({ error: "missing uid" }, 400, cors);
    const state = await readBanterState(env, id);
    const error = applyBanter(state, uid, body);
    if (error) return json({ error }, 400, cors);
    await env.BANTER.put(`banter:${id}`, JSON.stringify(state), { expirationTtl: BANTER_TTL });
    return json(aggregateBanter(state, uid), 200, cors);
  }
  return json({ error: "method not allowed" }, 405, cors);
}

export async function readBanterState(env, id) {
  const blob = await env.BANTER.get(`banter:${id}`, "json");
  return {
    reactions: blob && typeof blob.reactions === "object" && blob.reactions ? blob.reactions : {},
    messages: Array.isArray(blob?.messages) ? blob.messages : [],
  };
}

export function aggregateBanter(state, uid) {
  const counts = {};
  for (const emojis of Object.values(state.reactions)) {
    for (const emoji of emojis) counts[emoji] = (counts[emoji] ?? 0) + 1;
  }
  return {
    reactions: { counts, mine: state.reactions[uid] ?? [] },
    messages: state.messages.map((message) => ({ name: message.name, text: message.text, ts: message.ts })),
  };
}

// Mutate the banter state in place for a POST body. Returns an error string, or null on
// success. Reactions toggle per uid; messages append and keep the most recent 50.
export function applyBanter(state, uid, body) {
  if (body.action === "react") {
    if (!REACTIONS.includes(body.emoji)) return "bad emoji";
    const mine = new Set(state.reactions[uid] ?? []);
    if (mine.has(body.emoji)) mine.delete(body.emoji);
    else mine.add(body.emoji);
    if (mine.size) state.reactions[uid] = [...mine];
    else delete state.reactions[uid];
    return null;
  }
  if (body.action === "message") {
    const text = cleanText(body.text);
    if (!text) return "empty message";
    state.messages.push({ name: cleanName(body.name), text, ts: Date.now() });
    if (state.messages.length > 50) state.messages = state.messages.slice(-50);
    return null;
  }
  return "bad action";
}

function cleanUid(value) {
  return String(value ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
}

function cleanName(value) {
  const name = String(value ?? "").replace(/[<>]/g, "").trim().slice(0, 24);
  return name || "Someone";
}

function cleanText(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
}

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  const allow = ALLOWED_ORIGINS.has(origin) ? origin : "https://henderjm.github.io";
  return {
    "Access-Control-Allow-Origin": allow,
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

async function fetchJson(path, token, cacheTtl) {
  const response = await fetch(`${API}${path}`, {
    headers: { "X-Auth-Token": token },
    cf: { cacheTtl, cacheEverything: true },
  });
  if (!response.ok) throw new Error(`upstream ${response.status}`);
  return response.json();
}

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extra },
  });
}

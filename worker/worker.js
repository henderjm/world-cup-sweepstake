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
import {
  cleanName as cleanPaperRunName,
  createPaperRunChallenge,
  normalizeResult,
  sortLeaderboard,
  validateClientResult,
} from "../src/paperRunModel.js";

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
const PAPER_RUN_TTL = 90 * 24 * 60 * 60; // 90 days

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

    const paperRunRoute = url.pathname.match(/^\/paperrun\/(\d{4}-\d{2}-\d{2})$/);
    if (paperRunRoute) {
      return handlePaperRun(request, env, paperRunRoute[1], cors);
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
// Reactions are stored one key per user per match (react:<id>:<uid>, the emoji set in
// the key's metadata), so each person only ever writes their own key and there is no
// read-modify-write race. Messages are append-only keys (msg:<id>:<ts>-<rand>).

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
    return json(await readBanter(env, id, uid), 200, cors);
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
    if (body.action === "react") {
      if (!REACTIONS.includes(body.emoji)) return json({ error: "bad emoji" }, 400, cors);
      await toggleReaction(env, id, uid, body.emoji);
    } else if (body.action === "message") {
      const text = cleanText(body.text);
      if (!text) return json({ error: "empty message" }, 400, cors);
      await addMessage(env, id, uid, cleanName(body.name), text);
    } else {
      return json({ error: "bad action" }, 400, cors);
    }
    return json(await readBanter(env, id, uid), 200, cors);
  }
  return json({ error: "method not allowed" }, 405, cors);
}

async function readBanter(env, id, uid) {
  const [reacts, msgs] = await Promise.all([
    env.BANTER.list({ prefix: `react:${id}:` }),
    env.BANTER.list({ prefix: `msg:${id}:` }),
  ]);
  const counts = {};
  let mine = [];
  for (const key of reacts.keys) {
    const emojis = key.metadata?.e ?? [];
    for (const emoji of emojis) counts[emoji] = (counts[emoji] ?? 0) + 1;
    if (key.name === `react:${id}:${uid}`) mine = emojis;
  }
  const messages = msgs.keys
    .map((key) => key.metadata)
    .filter((meta) => meta && meta.text)
    .sort((a, b) => a.ts - b.ts)
    .slice(-50)
    .map((meta) => ({ name: meta.name, text: meta.text, ts: meta.ts }));
  return { reactions: { counts, mine }, messages };
}

async function toggleReaction(env, id, uid, emoji) {
  const key = `react:${id}:${uid}`;
  const current = await env.BANTER.getWithMetadata(key);
  const set = new Set(current.metadata?.e ?? []);
  if (set.has(emoji)) set.delete(emoji);
  else set.add(emoji);
  if (set.size === 0) {
    await env.BANTER.delete(key);
  } else {
    await env.BANTER.put(key, "", { metadata: { e: [...set] }, expirationTtl: BANTER_TTL });
  }
}

async function addMessage(env, id, uid, name, text) {
  const ts = Date.now();
  const key = `msg:${id}:${ts}-${Math.random().toString(36).slice(2, 8)}`;
  await env.BANTER.put(key, "", { metadata: { name, text, ts, uid }, expirationTtl: BANTER_TTL });
}

// -- Daily Paper Run (KV-backed) --------------------------------------------

async function handlePaperRun(request, env, date, cors) {
  if (!env.DAILY_GAME) return json({ error: "paper run not configured" }, 503, cors);
  const challenge = createPaperRunChallenge(date);

  if (request.method === "GET") {
    const uid = cleanUid(new URL(request.url).searchParams.get("uid"));
    const result = uid ? await env.DAILY_GAME.get(paperRunResultKey(date, uid), "json") : null;
    const leaderboard = await readPaperRunBoard(env, date);
    return json(
      {
        date,
        challengeNumber: challenge.challengeNumber,
        seed: challenge.seed,
        alreadyPlayed: Boolean(result),
        result: publicPaperRunResult(result),
        leaderboard: publicPaperRunBoard(leaderboard),
      },
      200,
      cors,
    );
  }

  if (request.method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "bad body" }, 400, cors);
    }

    const cleaned = sanitizePaperRunResult(body, date, challenge);
    if (cleaned.error) return json({ error: cleaned.error }, 400, cors);

    const key = paperRunResultKey(date, cleaned.result.uid);
    const existing = await env.DAILY_GAME.get(key, "json");
    if (existing) {
      return json(
        {
          error: "already played",
          result: publicPaperRunResult(existing),
          leaderboard: publicPaperRunBoard(await readPaperRunBoard(env, date)),
        },
        409,
        cors,
      );
    }

    await env.DAILY_GAME.put(key, JSON.stringify(cleaned.result), { expirationTtl: PAPER_RUN_TTL });
    const leaderboard = await writePaperRunBoard(env, date, cleaned.result);
    return json({ result: publicPaperRunResult(cleaned.result), leaderboard: publicPaperRunBoard(leaderboard) }, 200, cors);
  }

  return json({ error: "method not allowed" }, 405, cors);
}

function sanitizePaperRunResult(body, date, challenge) {
  const uid = cleanUid(body?.uid);
  if (!uid) return { error: "missing uid" };
  const raw = {
    date,
    name: cleanPaperRunName(body?.name),
    score: Number(body?.score),
    deliveries: Number(body?.deliveries),
    perfects: Number(body?.perfects),
    smashes: Number(body?.smashes),
    finished: Boolean(body?.finished),
    distancePct: Number(body?.distancePct),
    team: cleanLabel(body?.team, 32) || undefined,
    submittedAt: Date.now(),
    clientVersion: Number(body?.clientVersion) || 1,
  };
  const valid = validateClientResult(raw, challenge);
  if (!valid.ok) return { error: valid.error };
  return { result: { ...normalizeResult(raw, challenge), uid } };
}

async function readPaperRunBoard(env, date) {
  const board = await env.DAILY_GAME.get(paperRunBoardKey(date), "json");
  return Array.isArray(board) ? board : [];
}

async function writePaperRunBoard(env, date, result) {
  const current = await readPaperRunBoard(env, date);
  const withoutUser = current.filter((row) => row.uid !== result.uid);
  const next = sortLeaderboard([...withoutUser, result]).slice(0, 32);
  await env.DAILY_GAME.put(paperRunBoardKey(date), JSON.stringify(next), { expirationTtl: PAPER_RUN_TTL });
  return next;
}

function publicPaperRunBoard(rows) {
  return sortLeaderboard((rows ?? []).map(publicPaperRunResult).filter(Boolean));
}

function publicPaperRunResult(result) {
  if (!result) return null;
  return {
    name: result.name,
    score: result.score,
    deliveries: result.deliveries,
    perfects: result.perfects ?? 0,
    smashes: result.smashes ?? 0,
    finished: Boolean(result.finished),
    distancePct: result.distancePct ?? 0,
    team: result.team,
    submittedAt: result.submittedAt,
    clientVersion: result.clientVersion,
  };
}

function paperRunResultKey(date, uid) {
  return `paperrun:${date}:${uid}`;
}

function paperRunBoardKey(date) {
  return `paperrun-board:${date}`;
}

function cleanUid(value) {
  return String(value ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
}

function cleanName(value) {
  const name = String(value ?? "").replace(/[<>]/g, "").trim().slice(0, 24);
  return name || "Someone";
}

function cleanLabel(value, maxLength) {
  return String(value ?? "")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
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

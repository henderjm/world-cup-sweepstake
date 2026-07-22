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
// Endpoints: GET /:comp/live (and legacy /live for the default competition),
// GET /match/:id, GET /analysis/:id, GET /health. Match-scoped routes take no
// competition segment: football-data match ids are globally unique, so ids are
// validated against the union of all configured competitions' fixtures.

import Anthropic from "@anthropic-ai/sdk";
import { buildPushHTTPRequest } from "@pushforge/builder";
import { mapFootballDataMatches } from "../src/domain.js";
import { mapMatchDetail } from "../src/mapDetail.js";
import {
  ANALYSIS_SCHEMA,
  ANALYSIS_SYSTEM_PROMPT,
  analysisCacheSignature,
  analysisEligible,
  analysisEventSignature,
  buildAnalysisPrompt,
} from "../src/analysisPrompt.js";
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

// Banter: the allowed reaction set. A fixed allowlist stops the store being used
// to stash arbitrary strings.
const REACTIONS = ["🔥", "😂", "😱", "🧂", "🐐", "💀"];
const PAPER_RUN_TTL = 90 * 24 * 60 * 60; // 90 days

// Best-effort stale fallback held in the isolate's memory, one entry per competition.
const lastLive = new Map();

// The configured competitions, as "CODE:season" pairs: "PL:2026,CL:2026". The first
// entry is the default for legacy unprefixed routes. Falls back to the old singular
// vars so an un-migrated deploy keeps working.
function parseCompetitions(env) {
  const raw =
    env.FOOTBALL_DATA_COMPETITIONS ||
    `${env.FOOTBALL_DATA_COMPETITION || "PL"}:${env.FOOTBALL_DATA_SEASON || "2026"}`;
  return raw
    .split(",")
    .map((pair) => {
      const [code, season] = pair.split(":").map((part) => part?.trim());
      return { code: (code ?? "").toUpperCase(), season: season || "2026" };
    })
    .filter((comp) => /^[A-Z0-9]{2,6}$/.test(comp.code));
}

// Is this match id in any configured competition's fixture list? Each getLive is
// edge-cached, so checking the union costs at most one upstream call per competition
// per cache window.
async function matchKnown(competitions, id, token) {
  for (const comp of competitions) {
    try {
      const live = await getLive(comp.code, comp.season, token);
      if (live.matches.some((match) => match.id === id)) return true;
    } catch {
      // one competition's feed being down must not 404 the others
    }
  }
  return false;
}

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

    // Accounts: Google sign-in, bearer sessions in D1, followed clubs and
    // notification preferences. Everything degrades to a clear status code when
    // the D1 binding or the Google client id is missing, so the site can ship
    // the UI before the OAuth client exists.
    if (url.pathname === "/auth/google" && request.method === "POST") {
      return handleGoogleAuth(request, env, cors);
    }
    if (url.pathname === "/auth/logout" && request.method === "POST") {
      return handleLogout(request, env, cors);
    }
    if (url.pathname === "/me" && request.method === "GET") {
      return handleMe(request, env, cors);
    }
    if (url.pathname === "/follows/toggle" && request.method === "POST") {
      return handleFollowToggle(request, env, cors);
    }
    if (url.pathname === "/prefs" && request.method === "POST") {
      return handlePrefs(request, env, cors);
    }
    if (url.pathname === "/push/subscribe" && request.method === "POST") {
      return handlePushSubscribe(request, env, cors);
    }
    if (url.pathname === "/push/unsubscribe" && request.method === "POST") {
      return handlePushUnsubscribe(request, env, cors);
    }
    if (url.pathname === "/push/test" && request.method === "POST") {
      return handlePushTest(request, env, cors);
    }

    const token = env.FOOTBALL_DATA_TOKEN;
    if (!token) return json({ error: "service not configured" }, 500, cors);
    const competitions = parseCompetitions(env);
    if (!competitions.length) return json({ error: "service not configured" }, 500, cors);

    // Banter: shared per-match reactions and one-line messages in D1. GET reads the
    // current state (public); POST toggles a reaction or appends a message and
    // requires a signed-in session. The match id is validated against the real
    // fixtures so junk ids cannot fill storage.
    const banterRoute = url.pathname.match(/^\/banter\/(\d{1,12})$/);
    if (banterRoute) {
      return handleBanter(request, env, Number(banterRoute[1]), competitions, token, cors);
    }

    if (request.method !== "GET") return json({ error: "method not allowed" }, 405, cors);

    try {
      // /:comp/live, plus legacy /live serving the default (first) competition.
      const liveRoute = url.pathname.match(/^\/(?:([A-Za-z0-9]{2,6})\/)?live$/);
      if (liveRoute) {
        const comp = liveRoute[1]
          ? competitions.find((entry) => entry.code === liveRoute[1].toUpperCase())
          : competitions[0];
        if (!comp) return json({ error: "unknown competition" }, 404, cors);
        const data = await getLive(comp.code, comp.season, token);
        return json(data, 200, { ...cors, "Cache-Control": "public, max-age=15" });
      }

      const detailRoute = url.pathname.match(/^\/match\/(\d{1,12})$/);
      if (detailRoute) {
        const id = Number(detailRoute[1]);
        if (!(await matchKnown(competitions, id, token))) {
          return json({ error: "unknown match" }, 404, cors);
        }
        const detail = await fetchJson(`/v4/matches/${id}`, token, 25);
        return json(mapMatchDetail(detail), 200, { ...cors, "Cache-Control": "public, max-age=25" });
      }

      const analysisRoute = url.pathname.match(/^\/analysis\/(\d{1,12})$/);
      if (analysisRoute) {
        return handleAnalysis(env, Number(analysisRoute[1]), cors);
      }

      if (url.pathname === "/" || url.pathname === "/health") {
        return json({ ok: true, service: "goon-squad-data" }, 200, cors);
      }
      return json({ error: "not found" }, 404, cors);
    } catch {
      return json({ error: "upstream unavailable" }, 502, cors);
    }
  },

  // Cron (see [triggers] in wrangler.toml): pre-generates AI analyses during live
  // play and fans out push notifications for followed clubs. Both passes read the
  // same edge-cached /live responses, so running them together costs no extra
  // upstream calls.
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(Promise.all([runScheduledAnalysis(env), runScheduledNotifications(env)]));
  },
};

async function getLive(competition, season, token) {
  try {
    // Both calls pin the season: an unpinned /standings returns football-data's
    // "current season", which between seasons is still last year's final table and
    // silently disagrees with the season-pinned fixtures. Standings are optional:
    // a cup before its league phase has fixtures but no table yet (upstream 404s),
    // and that must not take down the whole feed. A transient standings blip reuses
    // the last good table rather than flashing an empty one.
    const [matches, standings] = await Promise.all([
      fetchJson(`/v4/competitions/${competition}/matches?season=${season}`, token, 15),
      fetchJson(`/v4/competitions/${competition}/standings?season=${season}`, token, 30).catch(
        () => null,
      ),
    ]);
    const body = {
      source: "football-data.org",
      lastUpdated: new Date().toISOString(),
      competition,
      season,
      matches: mapFootballDataMatches(matches),
      standings: standings?.standings ?? lastLive.get(competition)?.standings ?? [],
    };
    lastLive.set(competition, body);
    return body;
  } catch (error) {
    const stale = lastLive.get(competition);
    if (stale) return stale; // serve stale rather than fail when upstream blips
    throw error;
  }
}

// -- AI match analysis (Claude) -----------------------------------------------
// Generation is cron-driven, never visit-driven: the scheduled handler ticks every
// minute, checks the feed, and writes one analysis per live match (plus a single
// full-time read once a match finishes) into ANALYSIS_CACHE KV under a stable
// per-match key. Most ticks generate nothing: the signature decides the cadence
// (10-minute buckets in normal play, 5 in extra time, per kick during a shootout,
// immediately on any goal, red card or status change). The prompt is assembled
// server-side from feed data only, and the GET route is a pure KV read, so browsers
// can never trigger an Anthropic call and cost is fixed per match regardless of
// visitors.

const ANALYSIS_KV_TTL = 60 * 24 * 60 * 60; // stored analyses self-clean after the tournament
const ANALYSIS_FINAL_WINDOW_MS = 48 * 60 * 60 * 1000; // full-time reads only for fresh finishes
const ANALYSIS_MEMORY_MS = 60 * 1000; // per-isolate read cache; cron rewrites land within a tick
const analysisMemory = new Map(); // key -> { entry, expires }

async function handleAnalysis(env, id, cors) {
  if (!env.ANALYSIS_CACHE) return json({ error: "analysis not configured" }, 503, cors);
  const stored = await readLatestAnalysis(env, id);
  if (!stored?.body) return json({ error: "no analysis yet" }, 404, cors);
  return json(stored.body, 200, { ...cors, "Cache-Control": "public, max-age=60" });
}

async function runScheduledAnalysis(env) {
  if (!env.ANTHROPIC_API_KEY || !env.ANALYSIS_CACHE || !env.FOOTBALL_DATA_TOKEN) return;
  for (const comp of parseCompetitions(env)) {
    await analyseCompetition(env, comp);
  }
}

async function analyseCompetition(env, comp) {
  let live;
  try {
    live = await getLive(comp.code, comp.season, env.FOOTBALL_DATA_TOKEN);
  } catch {
    return; // feed down; the next tick retries
  }

  for (const match of live.matches.filter(analysisWorthGenerating)) {
    try {
      // Live matches also fetch detail so event changes the live feed cannot see
      // (red cards) regenerate on the next tick; the detail is reused for the
      // generation itself, so a regenerating tick costs no extra upstream call.
      let detail = null;
      let signature = analysisCacheSignature(match);
      if (!isMatchFinished(match)) {
        detail = mapMatchDetail(await fetchJson(`/v4/matches/${match.id}`, env.FOOTBALL_DATA_TOKEN, 25));
        signature += `:${analysisEventSignature(detail)}`;
      }
      const current = await readLatestAnalysis(env, match.id);
      if (current?.signature === signature) continue; // game state unchanged since last tick
      const body = await generateAnalysis(env, match, live, env.FOOTBALL_DATA_TOKEN, detail);
      await writeLatestAnalysis(env, match.id, { signature, body });
      // "Analysis ready" pushes only for the full-time read: live analyses
      // regenerate every few minutes and would spam followers.
      if (isMatchFinished(match) && pushConfigured(env)) {
        await sendMatchEvent(env, comp, match, {
          pref: "analysis",
          title: `Analysis ready: ${match.homeTeam} v ${match.awayTeam}`,
          body: body.headline ?? "The full-time read is in.",
        });
      }
    } catch {
      // one broken match must not block the others; the next tick retries
    }
  }
}

// Live matches always qualify; finished ones only within a window so the cron gives
// each match its full-time read shortly after the whistle without ever backfilling
// the whole tournament in one expensive burst.
function analysisWorthGenerating(match) {
  if (!analysisEligible(match)) return false;
  if (!isMatchFinished(match)) return true;
  const kickoff = new Date(match.utcDate).getTime();
  return Number.isFinite(kickoff) && Date.now() - kickoff < ANALYSIS_FINAL_WINDOW_MS;
}

async function generateAnalysis(env, match, live, token, detail = null) {
  detail = detail ?? mapMatchDetail(await fetchJson(`/v4/matches/${match.id}`, token, 25));

  // Model override must support adaptive thinking + structured outputs.
  const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1, timeout: 60_000 });
  const response = await anthropic.messages.create({
    model: env.ANTHROPIC_MODEL || "claude-sonnet-5",
    max_tokens: 4000,
    thinking: { type: "adaptive" },
    output_config: {
      effort: "low",
      format: { type: "json_schema", schema: ANALYSIS_SCHEMA },
    },
    system: ANALYSIS_SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildAnalysisPrompt(detail, live) }],
  });

  if (response.stop_reason === "refusal") throw new Error("analysis refused");
  const text = response.content.find((block) => block.type === "text")?.text ?? "";
  const analysis = JSON.parse(text); // schema-constrained: {headline, match, context}

  return {
    matchId: match.id,
    status: match.status,
    minute: match.minute ?? null,
    score: match.score,
    generatedAt: new Date().toISOString(),
    ...analysis,
  };
}

async function readLatestAnalysis(env, id) {
  const key = `analysis:latest:${id}`;
  const local = analysisMemory.get(key);
  if (local && local.expires > Date.now()) return local.entry;
  analysisMemory.delete(key);
  try {
    const entry = await env.ANALYSIS_CACHE.get(key, "json");
    if (entry) {
      analysisMemory.set(key, { entry, expires: Date.now() + ANALYSIS_MEMORY_MS });
      trimAnalysisMemory();
    }
    return entry;
  } catch {
    return null;
  }
}

async function writeLatestAnalysis(env, id, entry) {
  const key = `analysis:latest:${id}`;
  analysisMemory.set(key, { entry, expires: Date.now() + ANALYSIS_MEMORY_MS });
  trimAnalysisMemory();
  await env.ANALYSIS_CACHE.put(key, JSON.stringify(entry), { expirationTtl: ANALYSIS_KV_TTL });
}

function trimAnalysisMemory() {
  if (analysisMemory.size <= 64) return;
  const oldest = analysisMemory.keys().next().value;
  analysisMemory.delete(oldest);
}

function isMatchFinished(match) {
  return match.status === "FINISHED" || match.status === "AWARDED";
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

// -- Accounts (D1-backed) ------------------------------------------------------
// Google Identity Services hands the browser an ID token (JWT). The Worker
// verifies it against Google's tokeninfo endpoint (signature, expiry) and then
// checks the audience and issuer itself, upserts the user, and issues an opaque
// bearer session token. Only the token's SHA-256 is stored, so a database read
// can never leak a usable credential. The client keeps the token in localStorage
// and sends it as Authorization: Bearer.

const SESSION_TTL_DAYS = 30;
const MAX_FOLLOWS = 50;
const GOOGLE_ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);

async function handleGoogleAuth(request, env, cors) {
  if (!env.DB) return json({ error: "accounts not configured" }, 501, cors);
  if (!env.GOOGLE_CLIENT_ID) return json({ error: "sign-in not configured" }, 501, cors);

  let credential;
  try {
    credential = String((await request.json())?.credential ?? "");
  } catch {
    return json({ error: "bad body" }, 400, cors);
  }
  if (!credential || credential.length > 4096) return json({ error: "bad credential" }, 400, cors);

  // tokeninfo validates the JWT signature and expiry server-side at Google;
  // audience and issuer are ours to check.
  let info;
  try {
    const response = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`,
    );
    if (!response.ok) return json({ error: "invalid credential" }, 401, cors);
    info = await response.json();
  } catch {
    return json({ error: "verifier unavailable" }, 502, cors);
  }
  if (
    info.aud !== env.GOOGLE_CLIENT_ID ||
    !GOOGLE_ISSUERS.has(info.iss) ||
    !info.sub ||
    info.email_verified !== "true"
  ) {
    return json({ error: "invalid credential" }, 401, cors);
  }

  try {
    await env.DB.prepare(
      `INSERT INTO users (google_sub, email, name, avatar) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(google_sub) DO UPDATE SET email = ?2, name = ?3, avatar = ?4`,
    )
      .bind(info.sub, info.email ?? "", info.name ?? null, info.picture ?? null)
      .run();
    const user = await env.DB.prepare("SELECT id, email, name, avatar, prefs FROM users WHERE google_sub = ?1")
      .bind(info.sub)
      .first();

    const token = sessionToken();
    const expires = new Date(Date.now() + SESSION_TTL_DAYS * 864e5).toISOString();
    await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?1, ?2, ?3)")
      .bind(await sha256Hex(token), user.id, expires)
      .run();
    // Opportunistic cleanup keeps the sessions table from accumulating forever.
    await env.DB.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();

    return json({ token, user: publicUser(user), follows: await userFollows(env, user.id) }, 200, cors);
  } catch {
    return json({ error: "accounts unavailable" }, 502, cors);
  }
}

async function handleLogout(request, env, cors) {
  if (!env.DB) return json({ error: "accounts not configured" }, 501, cors);
  const token = bearerToken(request);
  if (token) {
    try {
      await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?1")
        .bind(await sha256Hex(token))
        .run();
    } catch {
      // logout is best-effort; the client drops its token regardless
    }
  }
  return json({ ok: true }, 200, cors);
}

async function handleMe(request, env, cors) {
  if (!env.DB) return json({ error: "accounts not configured" }, 501, cors);
  const user = await sessionUser(request, env);
  if (!user) return json({ error: "signed out" }, 401, cors);
  return json({ user: publicUser(user), follows: await userFollows(env, user.id) }, 200, cors);
}

async function handleFollowToggle(request, env, cors) {
  if (!env.DB) return json({ error: "accounts not configured" }, 501, cors);
  const user = await sessionUser(request, env);
  if (!user) return json({ error: "signed out" }, 401, cors);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad body" }, 400, cors);
  }
  const competition = String(body?.competition ?? "").toUpperCase();
  const team = String(body?.team ?? "").trim();
  if (!/^[A-Z0-9]{2,6}$/.test(competition) || !team || team.length > 60) {
    return json({ error: "bad follow" }, 400, cors);
  }

  try {
    const existing = await env.DB.prepare(
      "SELECT 1 AS x FROM follows WHERE user_id = ?1 AND competition = ?2 AND team = ?3",
    )
      .bind(user.id, competition, team)
      .first();
    if (existing) {
      await env.DB.prepare("DELETE FROM follows WHERE user_id = ?1 AND competition = ?2 AND team = ?3")
        .bind(user.id, competition, team)
        .run();
    } else {
      const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM follows WHERE user_id = ?1")
        .bind(user.id)
        .first();
      if ((count?.n ?? 0) >= MAX_FOLLOWS) return json({ error: "too many follows" }, 400, cors);
      await env.DB.prepare("INSERT INTO follows (user_id, competition, team) VALUES (?1, ?2, ?3)")
        .bind(user.id, competition, team)
        .run();
    }
    return json({ follows: await userFollows(env, user.id) }, 200, cors);
  } catch {
    return json({ error: "accounts unavailable" }, 502, cors);
  }
}

// Notification preferences, stored now so Phase 3 (push) is pure delivery.
const PREF_KEYS = new Set(["goals", "kickoff", "fulltime", "red", "analysis"]);

async function handlePrefs(request, env, cors) {
  if (!env.DB) return json({ error: "accounts not configured" }, 501, cors);
  const user = await sessionUser(request, env);
  if (!user) return json({ error: "signed out" }, 401, cors);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad body" }, 400, cors);
  }
  const current = safePrefs(user.prefs);
  Object.entries(body?.prefs ?? {}).forEach(([key, value]) => {
    if (PREF_KEYS.has(key)) current[key] = Boolean(value);
  });

  try {
    await env.DB.prepare("UPDATE users SET prefs = ?1 WHERE id = ?2")
      .bind(JSON.stringify(current), user.id)
      .run();
    return json({ prefs: current }, 200, cors);
  } catch {
    return json({ error: "accounts unavailable" }, 502, cors);
  }
}

function bearerToken(request) {
  const header = request.headers.get("Authorization") ?? "";
  const match = header.match(/^Bearer\s+([A-Za-z0-9_-]{20,128})$/);
  return match ? match[1] : null;
}

async function sessionUser(request, env) {
  const token = bearerToken(request);
  if (!token) return null;
  try {
    return await env.DB.prepare(
      `SELECT u.id, u.email, u.name, u.avatar, u.prefs FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?1 AND s.expires_at > datetime('now')`,
    )
      .bind(await sha256Hex(token))
      .first();
  } catch {
    return null;
  }
}

async function userFollows(env, userId) {
  const rows = await env.DB.prepare("SELECT competition, team FROM follows WHERE user_id = ?1 ORDER BY team")
    .bind(userId)
    .all();
  return rows.results ?? [];
}

function publicUser(user) {
  return { email: user.email, name: user.name, avatar: user.avatar, prefs: safePrefs(user.prefs) };
}

function safePrefs(raw) {
  try {
    const parsed = JSON.parse(raw ?? "{}");
    return typeof parsed === "object" && parsed ? parsed : {};
  } catch {
    return {};
  }
}

function sessionToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// -- Web Push (Phase 3) --------------------------------------------------------
// Subscriptions live in D1, one row per browser. The minute cron diffs each
// followed-relevant match against notify_state and fans out encrypted pushes
// (VAPID, aes128gcm via @pushforge/builder) for kickoff, goals, red cards and
// full-time, honouring each user's prefs. Targeting is the follows table; a dead
// endpoint (404/410 from the push service) is pruned on send.

const LIVE_SET = new Set(["IN_PLAY", "PAUSED", "LIVE", "EXTRA_TIME", "PENALTY_SHOOTOUT", "BREAK"]);
const NOTIFY_WINDOW_MS = 3 * 60 * 60 * 1000; // only matches near their kickoff get diffed
const DEFAULT_PREFS = { goals: true, kickoff: true, fulltime: true, red: false, analysis: false };

function pushConfigured(env) {
  return Boolean(env.DB && env.VAPID_PRIVATE_JWK && env.VAPID_PUBLIC_KEY);
}

async function handlePushSubscribe(request, env, cors) {
  if (!pushConfigured(env)) return json({ error: "push not configured" }, 501, cors);
  const user = await sessionUser(request, env);
  if (!user) return json({ error: "signed out" }, 401, cors);
  let sub;
  try {
    sub = (await request.json())?.subscription;
  } catch {
    return json({ error: "bad body" }, 400, cors);
  }
  const endpoint = String(sub?.endpoint ?? "");
  const p256dh = String(sub?.keys?.p256dh ?? "");
  const auth = String(sub?.keys?.auth ?? "");
  if (!endpoint.startsWith("https://") || endpoint.length > 1024 || !p256dh || p256dh.length > 256 || !auth || auth.length > 256) {
    return json({ error: "bad subscription" }, 400, cors);
  }
  try {
    // A browser re-subscribing (or a device changing hands between accounts)
    // simply re-points the endpoint at the current user.
    await env.DB.prepare(
      `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(endpoint) DO UPDATE SET user_id = ?2, p256dh = ?3, auth = ?4`,
    )
      .bind(endpoint, user.id, p256dh, auth)
      .run();
    return json({ ok: true }, 200, cors);
  } catch {
    return json({ error: "push unavailable" }, 502, cors);
  }
}

async function handlePushUnsubscribe(request, env, cors) {
  if (!pushConfigured(env)) return json({ error: "push not configured" }, 501, cors);
  const user = await sessionUser(request, env);
  if (!user) return json({ error: "signed out" }, 401, cors);
  let endpoint;
  try {
    endpoint = String((await request.json())?.endpoint ?? "");
  } catch {
    return json({ error: "bad body" }, 400, cors);
  }
  try {
    await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?1 AND user_id = ?2")
      .bind(endpoint, user.id)
      .run();
    return json({ ok: true }, 200, cors);
  } catch {
    return json({ error: "push unavailable" }, 502, cors);
  }
}

// Sends a test notification to every device the caller has enabled, so the whole
// pipeline (encryption, the push service, the service worker) is verifiable
// without waiting for a goal.
async function handlePushTest(request, env, cors) {
  if (!pushConfigured(env)) return json({ error: "push not configured" }, 501, cors);
  const user = await sessionUser(request, env);
  if (!user) return json({ error: "signed out" }, 401, cors);
  try {
    const subs = await env.DB.prepare(
      "SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?1",
    )
      .bind(user.id)
      .all();
    let sent = 0;
    for (const sub of subs.results ?? []) {
      const ok = await sendPush(env, sub, {
        title: "Squad Goals test",
        body: "Push notifications are working on this device.",
        url: env.SITE_ORIGIN ?? "",
        tag: "sg-test",
      });
      if (ok) sent += 1;
    }
    return json({ sent, devices: subs.results?.length ?? 0 }, 200, cors);
  } catch {
    return json({ error: "push unavailable" }, 502, cors);
  }
}

async function runScheduledNotifications(env) {
  if (!pushConfigured(env) || !env.FOOTBALL_DATA_TOKEN) return;
  for (const comp of parseCompetitions(env)) {
    try {
      await notifyCompetition(env, comp);
    } catch {
      // one competition failing must not block the others; the next tick retries
    }
  }
}

async function notifyCompetition(env, comp) {
  const live = await getLive(comp.code, comp.season, env.FOOTBALL_DATA_TOKEN);
  const now = Date.now();
  const relevant = live.matches.filter((match) => {
    if (LIVE_SET.has(match.status)) return true;
    const kickoff = new Date(match.utcDate).getTime();
    return isMatchFinished(match) && Number.isFinite(kickoff) && now - kickoff < NOTIFY_WINDOW_MS;
  });

  for (const match of relevant) {
    // Red cards come from match detail; the analysis pass fetches the same URL on
    // the same tick, so this rides the edge cache rather than spending new calls.
    let reds = 0;
    let lastRed = null;
    if (LIVE_SET.has(match.status)) {
      try {
        const detail = mapMatchDetail(await fetchJson(`/v4/matches/${match.id}`, env.FOOTBALL_DATA_TOKEN, 25));
        const redCards = (detail.cards ?? []).filter((card) => card.card === "RED");
        reds = redCards.length;
        lastRed = redCards[redCards.length - 1] ?? null;
      } catch {
        // detail blip: reds stay 0 this tick; the guard below only fires on increases
      }
    }

    const state = {
      status: match.status,
      home: match.score?.home ?? null,
      away: match.score?.away ?? null,
      reds,
    };
    const signature = JSON.stringify(state);
    const prevRow = await env.DB.prepare("SELECT signature FROM notify_state WHERE match_id = ?1")
      .bind(match.id)
      .first();
    if (prevRow?.signature === signature) continue;
    await env.DB.prepare(
      `INSERT INTO notify_state (match_id, signature, updated_at) VALUES (?1, ?2, datetime('now'))
       ON CONFLICT(match_id) DO UPDATE SET signature = ?2, updated_at = datetime('now')`,
    )
      .bind(match.id, signature)
      .run();
    if (!prevRow) continue; // first sighting is a baseline, never a burst of catch-up pushes

    let prev;
    try {
      prev = JSON.parse(prevRow.signature);
    } catch {
      continue;
    }
    for (const event of diffMatchEvents(prev, state, match, lastRed)) {
      await sendMatchEvent(env, comp, match, event);
    }
  }
}

function diffMatchEvents(prev, cur, match, lastRed) {
  const events = [];
  const score = `${cur.home ?? 0}–${cur.away ?? 0}`;
  const fixture = `${match.homeTeam} v ${match.awayTeam}`;
  const scoreline = `${match.homeTeam} ${score} ${match.awayTeam}`;

  if (!LIVE_SET.has(prev.status) && LIVE_SET.has(cur.status)) {
    events.push({ pref: "kickoff", title: `Kick-off: ${fixture}`, body: "They're off." });
  }
  if ((cur.home ?? 0) > (prev.home ?? 0) || (cur.away ?? 0) > (prev.away ?? 0)) {
    events.push({ pref: "goals", title: `⚽ ${scoreline}`, body: match.minute ? `${match.minute}'` : "Goal!" });
  }
  if ((cur.reds ?? 0) > (prev.reds ?? 0)) {
    events.push({
      pref: "red",
      title: `🟥 Red card in ${fixture}`,
      body: lastRed ? `${lastRed.player} (${lastRed.team}) is off.` : "Down to ten.",
    });
  }
  if (cur.status === "FINISHED" && prev.status !== "FINISHED") {
    events.push({ pref: "fulltime", title: `FT: ${scoreline}`, body: "Full time." });
  }
  return events;
}

async function sendMatchEvent(env, comp, match, event) {
  const subs = await env.DB.prepare(
    `SELECT DISTINCT s.endpoint, s.p256dh, s.auth, u.prefs FROM follows f
     JOIN users u ON u.id = f.user_id
     JOIN push_subscriptions s ON s.user_id = u.id
     WHERE f.competition = ?1 AND f.team IN (?2, ?3)`,
  )
    .bind(comp.code, match.homeTeam, match.awayTeam)
    .all();

  const payload = {
    title: event.title,
    body: event.body ?? "",
    url: `${env.SITE_ORIGIN ?? ""}/?match=${match.id}`,
    tag: `m${match.id}-${event.pref}`,
  };
  for (const sub of subs.results ?? []) {
    const prefs = safePrefs(sub.prefs);
    if (!(prefs[event.pref] ?? DEFAULT_PREFS[event.pref])) continue;
    await sendPush(env, sub, payload);
  }
}

async function sendPush(env, sub, payload) {
  try {
    const { endpoint, headers, body } = await buildPushHTTPRequest({
      privateJWK: env.VAPID_PRIVATE_JWK,
      message: {
        payload,
        options: { ttl: 3600, urgency: "high", topic: payload.tag?.slice(0, 32) },
        adminContact: env.PUSH_CONTACT ?? "mailto:admin@example.com",
      },
      subscription: { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
    });
    const response = await fetch(endpoint, { method: "POST", headers, body });
    if (response.status === 404 || response.status === 410) {
      await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?1").bind(sub.endpoint).run();
      return false;
    }
    return response.status < 300;
  } catch {
    return false;
  }
}

// -- Banter (D1-backed) ------------------------------------------------------
// Comments are an append-only log per match (banter_messages); reactions are one
// row per user x match x emoji (banter_reactions), rolled up to counts on read.
// D1 is strongly consistent, so the state a POST returns always includes the
// caller's own write — the old KV version's flickering reactions and vanishing
// messages came from list() lagging behind puts. Reads are public; posting
// requires a signed-in account, which also makes names unspoofable.

const MAX_BANTER_MESSAGES_PER_MATCH = 500;

async function handleBanter(request, env, id, competitions, token, cors) {
  if (!env.DB) return json({ error: "banter not configured" }, 503, cors);
  if (!(await matchKnown(competitions, id, token))) {
    return json({ error: "unknown match" }, 404, cors);
  }

  if (request.method === "GET") {
    const user = await sessionUser(request, env);
    return json(await readBanter(env, id, user?.id ?? null), 200, cors);
  }
  if (request.method === "POST") {
    const user = await sessionUser(request, env);
    if (!user) return json({ error: "sign in to join the banter" }, 401, cors);
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "bad body" }, 400, cors);
    }
    if (body.action === "react") {
      if (!REACTIONS.includes(body.emoji)) return json({ error: "bad emoji" }, 400, cors);
      // Toggle: delete wins if the row exists, otherwise insert. Two statements,
      // but the primary key makes a lost race harmless (idempotent either way).
      const deleted = await env.DB.prepare(
        "DELETE FROM banter_reactions WHERE match_id = ?1 AND user_id = ?2 AND emoji = ?3",
      )
        .bind(id, user.id, body.emoji)
        .run();
      if ((deleted.meta?.changes ?? 0) === 0) {
        await env.DB.prepare(
          "INSERT OR IGNORE INTO banter_reactions (match_id, user_id, emoji) VALUES (?1, ?2, ?3)",
        )
          .bind(id, user.id, body.emoji)
          .run();
      }
    } else if (body.action === "message") {
      const text = cleanText(body.text);
      if (!text) return json({ error: "empty message" }, 400, cors);
      const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM banter_messages WHERE match_id = ?1")
        .bind(id)
        .first();
      if ((count?.n ?? 0) >= MAX_BANTER_MESSAGES_PER_MATCH) {
        return json({ error: "banter is full for this match" }, 400, cors);
      }
      await env.DB.prepare("INSERT INTO banter_messages (match_id, user_id, text) VALUES (?1, ?2, ?3)")
        .bind(id, user.id, text)
        .run();
    } else {
      return json({ error: "bad action" }, 400, cors);
    }
    return json(await readBanter(env, id, user.id), 200, cors);
  }
  return json({ error: "method not allowed" }, 405, cors);
}

async function readBanter(env, id, userId) {
  const [counts, mine, msgs] = await Promise.all([
    env.DB.prepare("SELECT emoji, COUNT(*) AS n FROM banter_reactions WHERE match_id = ?1 GROUP BY emoji")
      .bind(id)
      .all(),
    userId
      ? env.DB.prepare("SELECT emoji FROM banter_reactions WHERE match_id = ?1 AND user_id = ?2")
          .bind(id, userId)
          .all()
      : Promise.resolve({ results: [] }),
    env.DB.prepare(
      `SELECT m.id, m.text, m.created_at, u.name, u.email FROM banter_messages m
       JOIN users u ON u.id = m.user_id
       WHERE m.match_id = ?1 ORDER BY m.id DESC LIMIT 50`,
    )
      .bind(id)
      .all(),
  ]);

  const countMap = {};
  (counts.results ?? []).forEach((row) => {
    countMap[row.emoji] = row.n;
  });
  return {
    reactions: {
      counts: countMap,
      mine: (mine.results ?? []).map((row) => row.emoji),
    },
    messages: (msgs.results ?? [])
      .reverse()
      .map((row) => ({
        id: row.id,
        name: row.name || String(row.email ?? "").split("@")[0] || "Someone",
        text: row.text,
        ts: row.created_at,
      })),
    signedIn: Boolean(userId),
  };
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
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
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

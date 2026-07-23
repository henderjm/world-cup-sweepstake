// Goon Squad data API (Cloudflare Worker).
//
// Proxies API-Football so the static site can poll for live data many times a
// minute without a deploy. The API key lives here as a Worker secret and never
// reaches the browser.
//
// Abuse hardening:
//   - Per-IP rate limit (binding) blocks single-source floods. Cloudflare's network
//     absorbs volumetric/distributed DDoS automatically on top of this.
//   - /match/:id is validated against the real fixture list, so id enumeration cannot
//     amplify into unbounded upstream calls and burn the daily request budget.
//   - Upstream calls are edge-cached, so a crowd of pollers collapses into roughly one
//     upstream call per cache window. A per-isolate copy of the last good /live is
//     served if upstream errors (stale-on-error).
//   - CORS is restricted to the site origin so other sites cannot freeload the quota.
//   - Errors are generic; no token or upstream detail is leaked.
//
// Endpoints: GET /:comp/live (and legacy /live for the default competition),
// GET /match/:id, GET /analysis/:id, GET /health. Match-scoped routes take no
// competition segment: API-Football fixture ids are globally unique, so ids are
// validated against the union of all configured competitions' fixtures.

import Anthropic from "@anthropic-ai/sdk";
import { buildPushHTTPRequest } from "@pushforge/builder";
import { COMPETITIONS } from "../src/competitions.js";
import { assertApiFootballPayload } from "../src/apiFootballPayload.js";
import {
  fixturePollingPlan,
  mapApiFootballMatchDetail,
  mapApiFootballMatchDetailFromSummary,
  mapApiFootballMatches,
  mapApiFootballStandingsPayload,
  mergeFixtureUpdates,
} from "../src/mapApiFootball.js";
import { isLive } from "../src/format.js";
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
import { MAX_LEAGUE_SIZE } from "../src/fantasy.js";
import { defaultLineup, resolveEffectiveLineup, validateLineupSelection } from "../src/fantasyLineups.js";

export { FantasyDraftRoom } from "./draftRoom.js";

const API = "https://v3.football.api-sports.io";

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

// Per-match detail is 3 upstream requests; pacing between matches keeps a busy
// multi-match minute-tick under the Ultra tier's ~7 req/sec ceiling instead of
// firing every match's requests back-to-back.
const MATCH_DETAIL_PACING_MS = 150;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The configured competitions, as "CODE:season" pairs: "PL:2026,CL:2026". The first
// entry is the default for legacy unprefixed routes.
function parseCompetitions(env) {
  const raw = env.API_FOOTBALL_COMPETITIONS || "PL:2026";
  return raw
    .split(",")
    .map((pair) => {
      const [code, season] = pair.split(":").map((part) => part?.trim());
      const normalizedCode = (code ?? "").toUpperCase();
      return {
        code: normalizedCode,
        season: season || "2026",
        leagueId: COMPETITIONS[normalizedCode]?.apiFootballLeagueId,
      };
    })
    .filter((comp) => /^[A-Z0-9]{2,6}$/.test(comp.code) && Number.isInteger(comp.leagueId));
}

// Is this match id in any configured competition's fixture list? Each getLive is
// edge-cached, so checking the union costs at most one upstream call per competition
// per cache window.
async function matchKnown(competitions, id, token) {
  for (const comp of competitions) {
    try {
      const live = await getLive(comp, token);
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

    // Fantasy H2H draft league (Phase 4.2). All routes require a signed-in
    // session; D1/DRAFT_ROOM absence degrades to 501 like the rest of accounts.
    if (url.pathname === "/fantasy/leagues" && request.method === "POST") {
      return handleFantasyLeagueCreate(request, env, cors);
    }
    if (url.pathname === "/fantasy/leagues" && request.method === "GET") {
      return handleFantasyLeagueList(request, env, cors);
    }
    if (url.pathname === "/fantasy/leagues/join" && request.method === "POST") {
      return handleFantasyLeagueJoin(request, env, cors);
    }
    const fantasyDraftWsRoute = url.pathname.match(/^\/fantasy\/league\/(\d+)\/draft\/ws$/);
    if (fantasyDraftWsRoute && request.method === "GET") {
      return handleFantasyDraftWs(request, env, Number(fantasyDraftWsRoute[1]), cors);
    }
    const fantasyDraftStartRoute = url.pathname.match(/^\/fantasy\/league\/(\d+)\/draft\/start$/);
    if (fantasyDraftStartRoute && request.method === "POST") {
      return handleFantasyDraftStart(request, env, Number(fantasyDraftStartRoute[1]), cors);
    }
    const fantasyLineupRoute = url.pathname.match(/^\/fantasy\/league\/(\d+)\/lineup$/);
    if (fantasyLineupRoute && request.method === "GET") {
      return handleFantasyLineupGet(request, env, Number(fantasyLineupRoute[1]), cors);
    }
    if (fantasyLineupRoute && request.method === "POST") {
      return handleFantasyLineupSet(request, env, Number(fantasyLineupRoute[1]), cors);
    }
    const fantasyLeagueDetailRoute = url.pathname.match(/^\/fantasy\/league\/(\d+)$/);
    if (fantasyLeagueDetailRoute && request.method === "GET") {
      return handleFantasyLeagueDetail(request, env, Number(fantasyLeagueDetailRoute[1]), cors);
    }

    const token = env.API_FOOTBALL_KEY;
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
        const data = await getLive(comp, token);
        return json(data, 200, { ...cors, "Cache-Control": "public, max-age=15" });
      }

      const detailRoute = url.pathname.match(/^\/match\/(\d{1,12})$/);
      if (detailRoute) {
        const id = Number(detailRoute[1]);
        if (!(await matchKnown(competitions, id, token))) {
          return json({ error: "unknown match" }, 404, cors);
        }
        const detail = await fetchMatchDetail(id, token);
        return json(detail, 200, { ...cors, "Cache-Control": "public, max-age=25" });
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
  // play and fans out push notifications for followed clubs. Run sequentially, not
  // concurrently: both passes fetch the same /live and per-match detail URLs, and
  // only a sequential order lets the second pass land on the edge cache the first
  // one just warmed. Running them in parallel would fire both fetches before either
  // response is cached, needlessly spending the daily API-Football allowance.
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      (async () => {
        await runScheduledAnalysis(env);
        await runScheduledNotifications(env);
      })(),
    );
  },
};

async function getLive(comp, token) {
  try {
    // The cron can tick every minute without calling upstream every minute. The
    // season schedule is the clock: idle fixtures make no status request, upcoming
    // fixtures refresh every 15 minutes (with the final cache clipped to kickoff),
    // and kickoff-wait/live fixtures refresh every minute until a final state lands.
    const schedulePayload = await fetchJson(
      `/fixtures?league=${comp.leagueId}&season=${comp.season}`,
      token,
      6 * 60 * 60,
    );
    const schedule = mapApiFootballMatches(schedulePayload);
    const pollingMatches = carryForwardFixtureStates(schedule, lastLive.get(comp.code)?.matches);
    const polling = fixturePollingPlan(pollingMatches, Date.now());
    let matches = pollingMatches;
    for (const request of polling.requests) {
      const livePayload = await fetchJson(
        `/fixtures?ids=${request.fixtures.map((match) => match.id).join("-")}`,
        token,
        request.ttl,
      );
      matches = mergeFixtureUpdates(matches, mapApiFootballMatches(livePayload));
    }
    const standings = await fetchJson(
      `/standings?league=${comp.leagueId}&season=${comp.season}`,
      token,
      polling.mode === "live" || polling.mode === "kickoff_wait" ? 5 * 60 : 6 * 60 * 60,
    ).catch(() => null);
    const body = {
      source: "API-Football",
      lastUpdated: new Date().toISOString(),
      competition: comp.code,
      season: comp.season,
      matches,
      standings: standings
        ? mapApiFootballStandingsPayload(standings)
        : lastLive.get(comp.code)?.standings ?? [],
    };
    lastLive.set(comp.code, body);
    return body;
  } catch (error) {
    const stale = lastLive.get(comp.code);
    if (stale) return stale; // serve stale rather than fail when upstream blips
    throw error;
  }
}

function carryForwardFixtureStates(schedule, previous) {
  if (!previous?.length) return schedule;
  const previousById = new Map(previous.map((match) => [match.id, match]));
  return schedule.map((current) => {
    const prior = previousById.get(current.id);
    if (!prior || prior.utcDate !== current.utcDate || current.status !== "TIMED") return current;
    return prior;
  });
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
  if (!env.ANTHROPIC_API_KEY || !env.ANALYSIS_CACHE || !env.API_FOOTBALL_KEY) return;
  for (const comp of parseCompetitions(env)) {
    await analyseCompetition(env, comp);
  }
}

async function analyseCompetition(env, comp) {
  let live;
  try {
    live = await getLive(comp, env.API_FOOTBALL_KEY);
  } catch {
    return; // feed down; the next tick retries
  }

  const worthGenerating = live.matches.filter(analysisWorthGenerating);
  for (const [index, match] of worthGenerating.entries()) {
    try {
      // Live matches also fetch detail so event changes the live feed cannot see
      // (red cards) regenerate on the next tick; the detail is reused for the
      // generation itself, so a regenerating tick costs no extra upstream call.
      let detail = null;
      let signature = analysisCacheSignature(match);
      if (!isMatchFinished(match)) {
        if (index > 0) await sleep(MATCH_DETAIL_PACING_MS);
        detail = await fetchLiveMatchDetail(match, env.API_FOOTBALL_KEY);
        signature += `:${analysisEventSignature(detail)}`;
      }
      const current = await readLatestAnalysis(env, match.id);
      if (current?.signature === signature) continue; // game state unchanged since last tick
      const body = await generateAnalysis(env, match, live, env.API_FOOTBALL_KEY, detail);
      await writeLatestAnalysis(env, match.id, { signature, body });
      // "Analysis ready" pushes only for the full-time read, and only once ever
      // per match: gated on a dedicated KV marker rather than the analysis cache
      // signature, so a later regeneration (e.g. an ANALYSIS_PROMPT_VERSION bump
      // that changes the signature of every recently-finished match) can never
      // re-send it. Live analyses regenerate every few minutes and would spam
      // followers, so this only fires for the finished-match read.
      if (isMatchFinished(match) && pushConfigured(env)) {
        const notifiedKey = `analysis:notified:${match.id}`;
        const alreadyNotified = await env.ANALYSIS_CACHE.get(notifiedKey);
        if (!alreadyNotified) {
          await sendMatchEvents(env, comp, match, [
            {
              pref: "analysis",
              title: `Analysis ready: ${match.homeTeam} v ${match.awayTeam}`,
              body: body.headline ?? "The full-time read is in.",
            },
          ]);
          await env.ANALYSIS_CACHE.put(notifiedKey, "1", { expirationTtl: ANALYSIS_KV_TTL });
        }
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
  detail = detail ?? (await fetchMatchDetail(match.id, token));

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
  return sessionUserForToken(bearerToken(request), env);
}

async function sessionUserForToken(token, env) {
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

// Browsers' WebSocket constructor cannot set an Authorization header on the
// handshake request, so the draft-room upgrade route accepts the same bearer
// session token as a query parameter as a fallback (checked after the header, so
// any client that *can* send Authorization still gets the normal path).
async function sessionUserFromWsRequest(request, env) {
  const headerToken = bearerToken(request);
  if (headerToken) return sessionUserForToken(headerToken, env);
  const queryToken = new URL(request.url).searchParams.get("token") ?? "";
  return /^[A-Za-z0-9_-]{20,128}$/.test(queryToken) ? sessionUserForToken(queryToken, env) : null;
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

// -- Fantasy H2H draft league (Phase 4.2) -------------------------------------
// League CRUD and draft bootstrap live here; the live draft clock itself is the
// FantasyDraftRoom Durable Object (draftRoom.js), one instance per league. This
// Worker is the only place a client-supplied token is ever checked for the draft
// room: handleFantasyDraftWs verifies the session and league membership against
// D1, then forwards the upgrade to the DO with the verified user id in a header
// the DO trusts blindly (it never re-parses a token itself).

const FANTASY_NAME_MAX = 60;

async function handleFantasyLeagueCreate(request, env, cors) {
  if (!env.DB) return json({ error: "fantasy not configured" }, 501, cors);
  const user = await sessionUser(request, env);
  if (!user) return json({ error: "signed out" }, 401, cors);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad body" }, 400, cors);
  }
  const name = cleanLabel(body?.name, FANTASY_NAME_MAX);
  if (!name) return json({ error: "bad name" }, 400, cors);

  try {
    let leagueId = null;
    // Invite codes are unique; a collision is astronomically unlikely at 40 bits
    // of entropy but retried a few times rather than trusted blindly.
    for (let attempt = 0; attempt < 5 && leagueId == null; attempt++) {
      try {
        const result = await env.DB.prepare(
          `INSERT INTO fantasy_leagues (name, commissioner_user_id, invite_code) VALUES (?1, ?2, ?3)`,
        )
          .bind(name, user.id, fantasyInviteCode())
          .run();
        leagueId = result.meta.last_row_id;
      } catch (error) {
        if (attempt === 4) throw error;
      }
    }
    await env.DB.prepare(`INSERT INTO fantasy_league_members (league_id, user_id) VALUES (?1, ?2)`)
      .bind(leagueId, user.id)
      .run();
    return json({ league: await fantasyLeagueSummary(env, leagueId, { includeInviteCode: true }) }, 200, cors);
  } catch {
    return json({ error: "fantasy unavailable" }, 502, cors);
  }
}

async function handleFantasyLeagueJoin(request, env, cors) {
  if (!env.DB) return json({ error: "fantasy not configured" }, 501, cors);
  const user = await sessionUser(request, env);
  if (!user) return json({ error: "signed out" }, 401, cors);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad body" }, 400, cors);
  }
  const code = String(body?.code ?? "").trim().toUpperCase();
  if (!code) return json({ error: "bad code" }, 400, cors);

  try {
    const league = await env.DB.prepare(`SELECT id, draft_status FROM fantasy_leagues WHERE invite_code = ?1`)
      .bind(code)
      .first();
    if (!league) return json({ error: "unknown invite code" }, 404, cors);
    if (league.draft_status !== "pending") return json({ error: "draft already started" }, 400, cors);

    const existing = await env.DB.prepare(
      `SELECT 1 AS x FROM fantasy_league_members WHERE league_id = ?1 AND user_id = ?2`,
    )
      .bind(league.id, user.id)
      .first();
    if (!existing) {
      // A single guarded INSERT...SELECT...WHERE instead of COUNT-then-INSERT:
      // two racing joins reading the same pre-insert count could otherwise both
      // pass the check and push membership past MAX_LEAGUE_SIZE. D1 executes
      // this one statement as a single atomic unit, so the COUNT it evaluates
      // always reflects every previously committed insert; only as many racing
      // joins as there are free seats can ever affect a row.
      const insert = await env.DB.prepare(
        `INSERT INTO fantasy_league_members (league_id, user_id)
         SELECT ?1, ?2 WHERE (SELECT COUNT(*) FROM fantasy_league_members WHERE league_id = ?1) < ?3`,
      )
        .bind(league.id, user.id, MAX_LEAGUE_SIZE)
        .run();
      if ((insert.meta?.changes ?? 0) === 0) return json({ error: "league is full" }, 400, cors);
    }
    return json({ league: await fantasyLeagueSummary(env, league.id, { includeInviteCode: true }) }, 200, cors);
  } catch {
    return json({ error: "fantasy unavailable" }, 502, cors);
  }
}

async function handleFantasyLeagueList(request, env, cors) {
  if (!env.DB) return json({ error: "fantasy not configured" }, 501, cors);
  const user = await sessionUser(request, env);
  if (!user) return json({ error: "signed out" }, 401, cors);

  try {
    const rows = await env.DB.prepare(
      `SELECT l.id, l.name, l.draft_status, l.commissioner_user_id,
              (SELECT COUNT(*) FROM fantasy_league_members m WHERE m.league_id = l.id) AS member_count
       FROM fantasy_leagues l
       JOIN fantasy_league_members mine ON mine.league_id = l.id AND mine.user_id = ?1
       ORDER BY l.created_at DESC`,
    )
      .bind(user.id)
      .all();
    return json(
      {
        leagues: (rows.results ?? []).map((row) => ({
          id: row.id,
          name: row.name,
          draftStatus: row.draft_status,
          memberCount: row.member_count,
          isCommissioner: row.commissioner_user_id === user.id,
        })),
      },
      200,
      cors,
    );
  } catch {
    return json({ error: "fantasy unavailable" }, 502, cors);
  }
}

async function handleFantasyLeagueDetail(request, env, leagueId, cors) {
  if (!env.DB) return json({ error: "fantasy not configured" }, 501, cors);
  const user = await sessionUser(request, env);
  if (!user) return json({ error: "signed out" }, 401, cors);

  try {
    const league = await env.DB.prepare(
      `SELECT id, name, commissioner_user_id, invite_code, draft_status FROM fantasy_leagues WHERE id = ?1`,
    )
      .bind(leagueId)
      .first();
    if (!league) return json({ error: "unknown league" }, 404, cors);

    const membership = await env.DB.prepare(
      `SELECT 1 AS x FROM fantasy_league_members WHERE league_id = ?1 AND user_id = ?2`,
    )
      .bind(leagueId, user.id)
      .first();
    if (!membership) return json({ error: "not a member" }, 403, cors);

    const [members, picks, roster, currentGameweek] = await Promise.all([
      env.DB.prepare(
        `SELECT m.user_id, m.draft_position, u.name, u.email FROM fantasy_league_members m
         JOIN users u ON u.id = m.user_id
         WHERE m.league_id = ?1 ORDER BY m.draft_position IS NULL, m.draft_position, m.joined_at`,
      )
        .bind(leagueId)
        .all(),
      env.DB.prepare(
        `SELECT p.round, p.pick_in_round, p.overall_pick, p.user_id, p.player_id, pl.name, pl.team, pl.position
         FROM fantasy_draft_picks p JOIN fantasy_players pl ON pl.id = p.player_id
         WHERE p.league_id = ?1 ORDER BY p.overall_pick`,
      )
        .bind(leagueId)
        .all(),
      fantasyRosterFor(env, leagueId, user.id),
      currentFantasyGameweek(env),
    ]);

    return json(
      {
        // members[], picks[] and the draft room's onClockUserId are all keyed by
        // numeric user id, so the caller needs to know which one is theirs.
        viewerUserId: user.id,
        currentGameweek,
        league: {
          id: league.id,
          name: league.name,
          draftStatus: league.draft_status,
          commissionerUserId: league.commissioner_user_id,
          isCommissioner: league.commissioner_user_id === user.id,
          inviteCode: league.invite_code,
        },
        members: (members.results ?? []).map((row) => ({
          userId: row.user_id,
          name: row.name || String(row.email ?? "").split("@")[0] || "Someone",
          draftPosition: row.draft_position,
        })),
        picks: (picks.results ?? []).map((row) => ({
          round: row.round,
          pickInRound: row.pick_in_round,
          overallPick: row.overall_pick,
          userId: row.user_id,
          player: { id: row.player_id, name: row.name, team: row.team, position: row.position },
        })),
        roster,
      },
      200,
      cors,
    );
  } catch {
    return json({ error: "fantasy unavailable" }, 502, cors);
  }
}

async function handleFantasyDraftStart(request, env, leagueId, cors) {
  if (!env.DB) return json({ error: "fantasy not configured" }, 501, cors);
  if (!env.DRAFT_ROOM) return json({ error: "draft not configured" }, 501, cors);
  const user = await sessionUser(request, env);
  if (!user) return json({ error: "signed out" }, 401, cors);

  try {
    const league = await env.DB.prepare(
      `SELECT id, commissioner_user_id, draft_status FROM fantasy_leagues WHERE id = ?1`,
    )
      .bind(leagueId)
      .first();
    if (!league) return json({ error: "unknown league" }, 404, cors);
    if (league.commissioner_user_id !== user.id) return json({ error: "commissioner only" }, 403, cors);
    if (league.draft_status !== "pending") return json({ error: "draft already started" }, 400, cors);

    const members = await env.DB.prepare(`SELECT user_id FROM fantasy_league_members WHERE league_id = ?1`)
      .bind(leagueId)
      .all();
    const memberIds = (members.results ?? []).map((row) => row.user_id);
    if (memberIds.length < 2) return json({ error: "need at least 2 members" }, 400, cors);

    await upsertFantasyPlayerPool(env);

    const order = shuffle(memberIds);
    await env.DB.batch([
      ...order.map((userId, index) =>
        env.DB.prepare(
          `UPDATE fantasy_league_members SET draft_position = ?1 WHERE league_id = ?2 AND user_id = ?3`,
        ).bind(index + 1, leagueId, userId),
      ),
      env.DB.prepare(`UPDATE fantasy_leagues SET draft_status = 'drafting' WHERE id = ?1`).bind(leagueId),
    ]);

    // Wake the DO immediately so the first pick clock starts now, rather than
    // waiting for whichever manager opens the draft room first.
    try {
      const id = env.DRAFT_ROOM.idFromName(String(leagueId));
      await env.DRAFT_ROOM.get(id).fetch("https://draft-room/start", {
        method: "POST",
        headers: { "X-Draft-League-Id": String(leagueId) },
      });
    } catch {
      // the DO self-hydrates on the first WebSocket join even if this wake fails
    }

    return json({ league: await fantasyLeagueSummary(env, leagueId) }, 200, cors);
  } catch {
    return json({ error: "fantasy unavailable" }, 502, cors);
  }
}

// Forwards a verified WebSocket upgrade to the league's Durable Object. Browsers
// cannot set an Authorization header on a WebSocket handshake, so this is the one
// route that also accepts the bearer token as a ?token= query parameter (see
// sessionUserFromWsRequest); everywhere else in the API keeps Authorization only.
async function handleFantasyDraftWs(request, env, leagueId, cors) {
  if (!env.DB) return json({ error: "fantasy not configured" }, 501, cors);
  if (!env.DRAFT_ROOM) return json({ error: "draft not configured" }, 501, cors);

  const origin = request.headers.get("Origin");
  if (origin && !ALLOWED_ORIGINS.has(origin)) return json({ error: "origin not allowed" }, 403, cors);
  if (request.headers.get("Upgrade") !== "websocket") {
    return json({ error: "expected websocket upgrade" }, 426, cors);
  }

  const user = await sessionUserFromWsRequest(request, env);
  if (!user) return json({ error: "signed out" }, 401, cors);

  try {
    const membership = await env.DB.prepare(
      `SELECT 1 AS x FROM fantasy_league_members WHERE league_id = ?1 AND user_id = ?2`,
    )
      .bind(leagueId, user.id)
      .first();
    if (!membership) return json({ error: "not a member" }, 403, cors);
  } catch {
    return json({ error: "fantasy unavailable" }, 502, cors);
  }

  const id = env.DRAFT_ROOM.idFromName(String(leagueId));
  const stub = env.DRAFT_ROOM.get(id);
  const forwardUrl = new URL(request.url);
  forwardUrl.pathname = "/join";
  // new Request(url, request) is the documented Cloudflare pattern for changing a
  // WebSocket upgrade request's URL before forwarding it to a Durable Object: it
  // preserves the runtime's underlying client-socket linkage, which a Request
  // built from a plain {method, headers} init would lose.
  const forwarded = new Request(forwardUrl, request);
  forwarded.headers.set("X-Draft-User-Id", String(user.id));
  forwarded.headers.set("X-Draft-League-Id", String(leagueId));
  return stub.fetch(forwarded);
}

function fantasyInviteCode() {
  const bytes = new Uint8Array(5); // 40 bits, unguessable, short enough to share
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

async function fantasyLeagueSummary(env, leagueId, { includeInviteCode = false } = {}) {
  const league = await env.DB.prepare(
    `SELECT id, name, draft_status, commissioner_user_id, invite_code FROM fantasy_leagues WHERE id = ?1`,
  )
    .bind(leagueId)
    .first();
  const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM fantasy_league_members WHERE league_id = ?1`)
    .bind(leagueId)
    .first();
  const summary = {
    id: league.id,
    name: league.name,
    draftStatus: league.draft_status,
    memberCount: count?.n ?? 0,
  };
  if (includeInviteCode) summary.inviteCode = league.invite_code;
  return summary;
}

// Fisher-Yates, used only to pick a random snake draft order; not
// security-sensitive, but crypto.getRandomValues costs nothing extra here.
function shuffle(list) {
  const array = [...list];
  for (let i = array.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

// Upserts the baked draftable player pool into fantasy_players so the draft's
// foreign keys (fantasy_draft_picks.player_id, fantasy_rosters.player_id) hold.
// Fetched from the same static site origin the frontend and the DO both read,
// so there is exactly one source for "what a player id means".
async function upsertFantasyPlayerPool(env) {
  const origin = env.SITE_ORIGIN ?? "";
  const response = await fetch(`${origin}/data/PL/players.json`);
  if (!response.ok) throw new Error(`player pool fetch failed: ${response.status}`);
  const body = await response.json();
  const players = (body.players ?? []).filter((player) => player?.id != null);
  if (!players.length) return;

  // D1 batches are practically bounded; chunk the upsert so a large squad pool
  // (all 20 PL clubs, ~500-600 players) never risks a single oversized batch.
  const CHUNK = 100;
  for (let i = 0; i < players.length; i += CHUNK) {
    const chunk = players.slice(i, i + CHUNK);
    await env.DB.batch(
      chunk.map((player) =>
        env.DB.prepare(
          `INSERT INTO fantasy_players (id, name, team, position) VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT(id) DO UPDATE SET name = ?2, team = ?3, position = ?4, updated_at = datetime('now')`,
        ).bind(player.id, player.name ?? "", player.team ?? "", player.position ?? "MID"),
      ),
    );
  }
}

// -- Fantasy starting lineups (Phase 4.4) -------------------------------------
// Reads resolve the effective lineup for the current gameweek per the
// fantasy_lineups inheritance rule (see schema.sql and src/fantasyLineups.js);
// nothing is ever copy-written between gameweeks. Writes are always for the
// server-derived current gameweek, never a client-supplied one, so nobody can
// rewrite an earlier week's result after it has already scored.

// PL is the only fantasy competition (see schema.sql's fantasy_lineups comment
// on why the 38-matchday PL season maps 1:1 onto weekly gameweeks), so this is
// unconditionally the PL feed. The smallest matchday still in play is "now";
// once every match is finished the season's final matchday holds until the
// next one opens. Any failure (feed down, PL not configured, local dev with a
// dummy API key) falls back to gameweek 1 rather than erroring the route.
async function currentFantasyGameweek(env) {
  try {
    const comp = parseCompetitions(env).find((entry) => entry.code === "PL");
    if (!comp || !env.API_FOOTBALL_KEY) return 1;
    const live = await getLive(comp, env.API_FOOTBALL_KEY);
    const matchdays = (live.matches ?? [])
      .filter((match) => Number.isInteger(match.matchday))
      .map((match) => ({ matchday: match.matchday, finished: isMatchFinished(match) }));
    if (!matchdays.length) return 1;
    const unfinished = matchdays.filter((entry) => !entry.finished);
    if (unfinished.length) return Math.min(...unfinished.map((entry) => entry.matchday));
    return Math.max(...matchdays.map((entry) => entry.matchday));
  } catch {
    return 1;
  }
}

async function fantasyRosterFor(env, leagueId, userId) {
  const rows = await env.DB.prepare(
    `SELECT r.player_id AS id, pl.name, pl.team, pl.position FROM fantasy_rosters r
     JOIN fantasy_players pl ON pl.id = r.player_id
     WHERE r.league_id = ?1 AND r.user_id = ?2`,
  )
    .bind(leagueId, userId)
    .all();
  return rows.results ?? [];
}

async function handleFantasyLineupGet(request, env, leagueId, cors) {
  if (!env.DB) return json({ error: "fantasy not configured" }, 501, cors);
  const user = await sessionUser(request, env);
  if (!user) return json({ error: "signed out" }, 401, cors);

  try {
    const membership = await env.DB.prepare(
      `SELECT 1 AS x FROM fantasy_league_members WHERE league_id = ?1 AND user_id = ?2`,
    )
      .bind(leagueId, user.id)
      .first();
    if (!membership) return json({ error: "not a member" }, 403, cors);

    const gameweek = await currentFantasyGameweek(env);
    const [roster, lineupRows] = await Promise.all([
      fantasyRosterFor(env, leagueId, user.id),
      env.DB.prepare(
        `SELECT gameweek, player_id, is_captain FROM fantasy_lineups WHERE league_id = ?1 AND user_id = ?2`,
      )
        .bind(leagueId, user.id)
        .all(),
    ]);

    const resolved = resolveEffectiveLineup(lineupRows.results ?? [], gameweek);
    let source = "set";
    let starters = resolved.starters;
    if (resolved.gameweek == null) {
      starters = defaultLineup(roster).starters; // computed on read, never written to D1
      source = "default";
    } else if (resolved.inherited) {
      source = "inherited";
    }

    const starterIds = new Set(starters.map((entry) => entry.playerId));
    const bench = roster.filter((player) => !starterIds.has(player.id)).map((player) => player.id);

    return json({ gameweek, source, starters, bench }, 200, cors);
  } catch {
    return json({ error: "fantasy unavailable" }, 502, cors);
  }
}

async function handleFantasyLineupSet(request, env, leagueId, cors) {
  if (!env.DB) return json({ error: "fantasy not configured" }, 501, cors);
  const user = await sessionUser(request, env);
  if (!user) return json({ error: "signed out" }, 401, cors);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad body" }, 400, cors);
  }
  const starters = Array.isArray(body?.starters) ? body.starters.map(Number) : null;
  const captainId = body?.captainId == null ? null : Number(body.captainId);
  if (!starters || starters.some((id) => !Number.isInteger(id)) || !Number.isInteger(captainId)) {
    return json({ error: "bad selection" }, 400, cors);
  }

  try {
    const league = await env.DB.prepare(`SELECT draft_status FROM fantasy_leagues WHERE id = ?1`)
      .bind(leagueId)
      .first();
    if (!league) return json({ error: "unknown league" }, 404, cors);

    const membership = await env.DB.prepare(
      `SELECT 1 AS x FROM fantasy_league_members WHERE league_id = ?1 AND user_id = ?2`,
    )
      .bind(leagueId, user.id)
      .first();
    if (!membership) return json({ error: "not a member" }, 403, cors);
    if (league.draft_status !== "complete") return json({ error: "draft not complete" }, 400, cors);

    const roster = await fantasyRosterFor(env, leagueId, user.id);
    const validation = validateLineupSelection({ starters, captainId, roster });
    if (!validation.ok) return json({ error: validation.error }, 400, cors);

    const gameweek = await currentFantasyGameweek(env);
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM fantasy_lineups WHERE league_id = ?1 AND user_id = ?2 AND gameweek = ?3`).bind(
        leagueId,
        user.id,
        gameweek,
      ),
      ...starters.map((playerId) =>
        env.DB.prepare(
          `INSERT INTO fantasy_lineups (league_id, user_id, gameweek, player_id, is_captain) VALUES (?1, ?2, ?3, ?4, ?5)`,
        ).bind(leagueId, user.id, gameweek, playerId, playerId === captainId ? 1 : 0),
      ),
    ]);

    const starterEntries = starters.map((playerId) => ({ playerId, isCaptain: playerId === captainId }));
    const starterIds = new Set(starters);
    const bench = roster.filter((player) => !starterIds.has(player.id)).map((player) => player.id);

    return json({ gameweek, source: "set", starters: starterEntries, bench }, 200, cors);
  } catch {
    return json({ error: "fantasy unavailable" }, 502, cors);
  }
}

// -- Web Push (Phase 3) --------------------------------------------------------
// Subscriptions live in D1, one row per browser. The minute cron diffs each
// followed-relevant match against notify_state and fans out encrypted pushes
// (VAPID, aes128gcm via @pushforge/builder) for kickoff, goals, red cards and
// full-time, honouring each user's prefs. Targeting is the follows table; a dead
// endpoint (404/410 from the push service) is pruned on send.

const NOTIFY_WINDOW_MS = 3 * 60 * 60 * 1000; // matches within this window of kickoff/full-time get diffed
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
    const results = await Promise.all(
      (subs.results ?? []).map((sub) =>
        sendPush(env, sub, {
          title: "Squad Goals test",
          body: "Push notifications are working on this device.",
          url: env.SITE_ORIGIN ?? "",
          tag: "sg-test",
        }),
      ),
    );
    return json({ sent: results.filter(Boolean).length, devices: subs.results?.length ?? 0 }, 200, cors);
  } catch {
    return json({ error: "push unavailable" }, 502, cors);
  }
}

async function runScheduledNotifications(env) {
  if (!pushConfigured(env) || !env.API_FOOTBALL_KEY) return;
  for (const comp of parseCompetitions(env)) {
    try {
      await notifyCompetition(env, comp);
    } catch {
      // one competition failing must not block the others; the next tick retries
    }
  }
}

async function notifyCompetition(env, comp) {
  const live = await getLive(comp, env.API_FOOTBALL_KEY);
  const now = Date.now();
  const relevant = live.matches.filter((match) => {
    if (isLive(match.status)) return true;
    const kickoff = new Date(match.utcDate).getTime();
    if (!Number.isFinite(kickoff)) return false;
    if (isMatchFinished(match)) return now - kickoff < NOTIFY_WINDOW_MS;
    // Not kicked off yet: baseline it shortly before kickoff so the live
    // transition below has a non-live prior state to diff against once it
    // actually goes live, instead of the match's first sighting already being
    // live (which the "first sighting is a baseline" rule then swallows).
    return kickoff > now && kickoff - now < NOTIFY_WINDOW_MS;
  });

  let liveDetailFetches = 0;
  for (const match of relevant) {
    const prevRow = await env.DB.prepare("SELECT signature FROM notify_state WHERE match_id = ?1")
      .bind(match.id)
      .first();
    let prev = null;
    if (prevRow) {
      try {
        prev = JSON.parse(prevRow.signature);
      } catch {
        prev = null;
      }
    }

    // Red cards come from match detail; the analysis pass fetches the same URL on
    // the same tick, so this rides the edge cache rather than spending new calls.
    // A transient fetch failure carries the previous tick's count forward instead
    // of resetting it to zero: zeroing it would make the signature regress, and
    // recovery on a later tick would then read as a fresh increase and fire a
    // duplicate red-card push for the same dismissal.
    let reds = prev?.reds ?? 0;
    let lastRed = null;
    let detailMinute = null;
    if (isLive(match.status)) {
      try {
        if (liveDetailFetches > 0) await sleep(MATCH_DETAIL_PACING_MS);
        liveDetailFetches += 1;
        const detail = await fetchLiveMatchDetail(match, env.API_FOOTBALL_KEY);
        // YELLOW_RED is a second-yellow dismissal, not a separate RED booking.
        const redCards = (detail.cards ?? []).filter(
          (card) => card.card === "RED" || card.card === "YELLOW_RED",
        );
        reds = redCards.length;
        lastRed = redCards[redCards.length - 1] ?? null;
        detailMinute = detail.minute ?? null;
      } catch {
        // detail blip: reds/minute carry forward from the last good read above
      }
    }

    const state = {
      status: match.status,
      home: match.score?.home ?? null,
      away: match.score?.away ?? null,
      reds,
    };
    const signature = JSON.stringify(state);
    if (prevRow?.signature === signature) continue;
    await env.DB.prepare(
      `INSERT INTO notify_state (match_id, signature, updated_at) VALUES (?1, ?2, datetime('now'))
       ON CONFLICT(match_id) DO UPDATE SET signature = ?2, updated_at = datetime('now')`,
    )
      .bind(match.id, signature)
      .run();
    if (!prevRow) continue; // first sighting is a baseline, never a burst of catch-up pushes

    const events = diffMatchEvents(prev, state, match, lastRed, detailMinute);
    await sendMatchEvents(env, comp, match, events);
  }
}

function diffMatchEvents(prev, cur, match, lastRed, detailMinute) {
  const events = [];
  const score = `${cur.home ?? 0}-${cur.away ?? 0}`;
  const fixture = `${match.homeTeam} v ${match.awayTeam}`;
  const scoreline = `${match.homeTeam} ${score} ${match.awayTeam}`;
  const minute = detailMinute ?? match.minute;

  if (!isLive(prev.status) && isLive(cur.status)) {
    events.push({ pref: "kickoff", title: `Kick-off: ${fixture}`, body: "They're off." });
  }
  if ((cur.home ?? 0) > (prev.home ?? 0) || (cur.away ?? 0) > (prev.away ?? 0)) {
    events.push({ pref: "goals", title: `⚽ ${scoreline}`, body: minute ? `${minute}'` : "Goal!" });
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

// Sends every event for one match on one tick against a single subscriber lookup
// (diffMatchEvents can emit up to four events for the same match/tick, and the
// follows x users x push_subscriptions join is identical across all of them), and
// fans each event's sends out concurrently rather than one device at a time.
async function sendMatchEvents(env, comp, match, events) {
  if (!events.length) return;
  const subs = await env.DB.prepare(
    `SELECT DISTINCT s.endpoint, s.p256dh, s.auth, u.prefs FROM follows f
     JOIN users u ON u.id = f.user_id
     JOIN push_subscriptions s ON s.user_id = u.id
     WHERE f.competition = ?1 AND f.team IN (?2, ?3)`,
  )
    .bind(comp.code, match.homeTeam, match.awayTeam)
    .all();
  const subscribers = subs.results ?? [];
  if (!subscribers.length) return;

  for (const event of events) {
    const payload = {
      title: event.title,
      body: event.body ?? "",
      url: `${env.SITE_ORIGIN ?? ""}/?match=${match.id}`,
      tag: `m${match.id}-${event.pref}`,
    };
    const recipients = subscribers.filter((sub) => {
      const prefs = safePrefs(sub.prefs);
      return prefs[event.pref] ?? DEFAULT_PREFS[event.pref];
    });
    await Promise.all(recipients.map((sub) => sendPush(env, sub, payload)));
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

async function fetchMatchDetail(id, token) {
  // Interactive detail reads include the fixture endpoint for half-time scores and
  // referee data. Slow-changing payloads keep longer cache windows so opening the
  // drawer cannot multiply upstream usage.
  const fixture = await fetchJson(`/fixtures?id=${id}`, token, 60);
  const lineups = await fetchJson(`/fixtures/lineups?fixture=${id}`, token, 15 * 60);
  const events = await fetchJson(`/fixtures/events?fixture=${id}`, token, 60);
  const players = await fetchJson(`/fixtures/players?fixture=${id}`, token, 5 * 60);
  return mapApiFootballMatchDetail(fixture, lineups, events, players);
}

async function fetchLiveMatchDetail(summary, token) {
  // The minute cron already has the fixture summary from the batched live request.
  // Reuse it instead of spending another /fixtures call per match per minute. Events
  // remain minute-fresh; lineups are effectively immutable after kick-off and player
  // totals only need a five-minute scoring cadence. At ~105 live minutes this costs
  // about 133 requests per match instead of 420.
  const lineups = await fetchJson(`/fixtures/lineups?fixture=${summary.id}`, token, 15 * 60);
  const events = await fetchJson(`/fixtures/events?fixture=${summary.id}`, token, 60);
  const players = await fetchJson(`/fixtures/players?fixture=${summary.id}`, token, 5 * 60);
  return mapApiFootballMatchDetailFromSummary(summary, lineups, events, players);
}

async function fetchJson(path, token, cacheTtl) {
  const response = await fetch(`${API}${path}`, {
    headers: { "x-apisports-key": token },
    cf: { cacheTtl, cacheEverything: true },
  });
  if (!response.ok) throw new Error(`upstream ${response.status}`);
  return assertApiFootballPayload(await response.json());
}

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extra },
  });
}

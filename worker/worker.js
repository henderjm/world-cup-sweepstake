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
// GET /match/:id, GET /analysis/:id, GET /health, GET /health/draft-ready and
// GET /health/quota (upstream call accounting). Match-scoped routes take no
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
  MATCH_DETAIL_LIVE,
  matchDetailBrowserMaxAge,
  matchDetailCacheProfile,
} from "../src/matchDetailCache.js";
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
import { MAX_LEAGUE_SIZE, bucketPosition } from "../src/fantasy.js";
import { defaultLineup, repairLineup, resolveEffectiveLineup, validateLineupSelection } from "../src/fantasyLineups.js";
import { scoreMatchForPlayers } from "../src/fantasyScoring.js";
import {
  currentGameweekFromMatches,
  gameweekStatus,
  rosterGameweekPoints,
  standingsFromFixtures,
  sumPlayerPoints,
} from "../src/fantasyGameweek.js";
import { assignGameweeks, clubFixtureCounts, gameweekOf } from "../src/fantasyCalendar.js";
import {
  DEFAULT_FAAB_BUDGET,
  WAIVER_MODES,
  claimGameweek,
  playerAvailability,
  resolveWaiverRun,
  validateAcquisition,
  waiverRunReady,
  waiverRunWindow,
} from "../src/fantasyWaivers.js";
import { lineupChangedPlayerIds, lockedPlayerIds, playerLockState } from "../src/fantasyLocks.js";
import { dueDraftReminder, validateDraftSchedule } from "../src/fantasyScheduling.js";
import { blendWithCurrentSeason } from "../src/fantasyExpectedPoints.js";
import {
  CHAT_EVENTS,
  CHAT_PAGE_SIZE,
  CHAT_REACTIONS,
  MAX_CHAT_MESSAGES_PER_LEAGUE,
  cleanChatText,
} from "../src/fantasyChat.js";
import {
  attachRankMovement,
  buildPowerRankings,
  gameweekAwards,
  matchupResults,
} from "../src/fantasyRecap.js";
import {
  RECAP_PROMPT_VERSION,
  RECAP_SCHEMA,
  RECAP_SYSTEM_PROMPT,
  buildRecapPrompt,
  mergeRecap,
} from "../src/fantasyRecapPrompt.js";
import { endpointFamily } from "../src/apiQuota.js";
import {
  bufferSize,
  bufferUsage,
  buildQuotaReport,
  chunkRows,
  createUsageBuffer,
  drainUsage,
  latestQuota,
  usageDay,
} from "../src/apiQuotaStore.js";
import { createResponseCache, pruneCache, readCached, writeCached } from "../src/apiCache.js";
import {
  BUDGET_NORMAL,
  allowsAnalysis,
  allowsInteractiveDetail,
  allowsLiveEventDetail,
  budgetLevel,
  matchDetailPlan,
} from "../src/apiBudget.js";

export { FantasyDraftRoom } from "./draftRoom.js";

const API = "https://v3.football.api-sports.io";

const ALLOWED_ORIGINS = new Set([
  // The site is moving from GitHub Pages to the kickoffdraft.com custom domain.
  // Keep the github.io entry until DNS has propagated and the domain move is
  // confirmed live; drop it only once henderjm.github.io is no longer serving
  // the site, so nobody's mid-transition browser tab loses the backend.
  "https://henderjm.github.io",
  "https://kickoffdraft.com",
  "https://www.kickoffdraft.com",
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

// Returns the known fixture summary, or null if the id belongs to no configured
// competition. Returning the match rather than a boolean is what lets the
// caller choose cache windows from its status (see matchDetailCacheProfile).
//
// What this costs, measured rather than assumed, because the previous note here
// ("at most one upstream call per competition per cache window") and the route's
// own "four upstream calls" were both optimistic. Each getLive is two or three
// URLs (season schedule, standings, and a batched live request when anything is
// in play), and this loops until the id matches, so on a COLD isolate a drawer
// open cost 6 calls for a Premier League fixture and 8 for a Champions League
// one, not 4. On a warm isolate the memo in fetchJson makes every one of them
// free and only the match-detail payloads are actually spent.
async function findKnownMatch(competitions, id, token) {
  for (const comp of competitions) {
    try {
      const live = await getLive(comp, token);
      const match = live.matches.find((entry) => entry.id === id);
      if (match) return match;
    } catch {
      // one competition's feed being down must not 404 the others
    }
  }
  return null;
}


export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(request);

    // Writes out what EARLIER requests on this isolate recorded about upstream
    // API-Football usage. At the top and handed to waitUntil on purpose: it
    // must never sit between a user and their response, and by definition it
    // only ever flushes calls that have already completed. No-ops unless the
    // buffer is due, so this is a couple of comparisons on most requests. See
    // runScheduledApiUsage for the cron's own forced flush.
    ctx?.waitUntil?.(flushApiUsage(env));

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
    const fantasyDraftScheduleRoute = url.pathname.match(/^\/fantasy\/league\/(\d+)\/draft\/schedule$/);
    if (fantasyDraftScheduleRoute && request.method === "POST") {
      return handleFantasyDraftScheduleSet(request, env, Number(fantasyDraftScheduleRoute[1]), cors);
    }
    if (fantasyDraftScheduleRoute && request.method === "DELETE") {
      return handleFantasyDraftScheduleClear(request, env, Number(fantasyDraftScheduleRoute[1]), cors);
    }
    // A manager's own draft-pick shortlist. Plain D1 read/write, never routed
    // through the FantasyDraftRoom Durable Object: there is no turn-order
    // race to arbitrate here (a manager only ever touches their own row), so
    // this is exactly like the lineup routes below rather than the pick
    // itself. The Durable Object's alarm autopick (worker/draftRoom.js) reads
    // this same table straight from D1 on every wake.
    const fantasyDraftQueueRoute = url.pathname.match(/^\/fantasy\/league\/(\d+)\/draft\/queue$/);
    if (fantasyDraftQueueRoute && request.method === "GET") {
      return handleFantasyDraftQueueGet(request, env, Number(fantasyDraftQueueRoute[1]), cors);
    }
    if (fantasyDraftQueueRoute && request.method === "POST") {
      return handleFantasyDraftQueueSet(request, env, Number(fantasyDraftQueueRoute[1]), cors);
    }
    // The league feed: one stream carrying both the app's own events (picks,
    // waiver runs, free-agent adds, the weekly recap) and managers' messages
    // about them. Member-only in BOTH directions, unlike match banter which is
    // publicly readable: a private league's transactions are nobody else's
    // business.
    const fantasyChatRoute = url.pathname.match(/^\/fantasy\/league\/(\d+)\/chat$/);
    if (fantasyChatRoute && (request.method === "GET" || request.method === "POST")) {
      return handleFantasyChat(request, env, Number(fantasyChatRoute[1]), cors);
    }
    const fantasyLineupRoute = url.pathname.match(/^\/fantasy\/league\/(\d+)\/lineup$/);
    if (fantasyLineupRoute && request.method === "GET") {
      return handleFantasyLineupGet(request, env, Number(fantasyLineupRoute[1]), cors);
    }
    if (fantasyLineupRoute && request.method === "POST") {
      return handleFantasyLineupSet(request, env, Number(fantasyLineupRoute[1]), cors);
    }
    const fantasyMatchupRoute = url.pathname.match(/^\/fantasy\/league\/(\d+)\/matchup$/);
    if (fantasyMatchupRoute && request.method === "GET") {
      return handleFantasyMatchup(request, env, Number(fantasyMatchupRoute[1]), cors);
    }
    const fantasyStandingsRoute = url.pathname.match(/^\/fantasy\/league\/(\d+)\/standings$/);
    if (fantasyStandingsRoute && request.method === "GET") {
      return handleFantasyStandings(request, env, Number(fantasyStandingsRoute[1]), cors);
    }
    const fantasyWaiversRoute = url.pathname.match(/^\/fantasy\/league\/(\d+)\/waivers$/);
    if (fantasyWaiversRoute && request.method === "GET") {
      return handleFantasyWaiversView(request, env, Number(fantasyWaiversRoute[1]), cors);
    }
    const fantasyWaiverClaimRoute = url.pathname.match(/^\/fantasy\/league\/(\d+)\/waivers\/claim$/);
    if (fantasyWaiverClaimRoute && request.method === "POST") {
      return handleFantasyWaiverClaimCreate(request, env, Number(fantasyWaiverClaimRoute[1]), cors);
    }
    const fantasyWaiverClaimCancelRoute = url.pathname.match(/^\/fantasy\/league\/(\d+)\/waivers\/claim\/(\d+)$/);
    if (fantasyWaiverClaimCancelRoute && request.method === "DELETE") {
      return handleFantasyWaiverClaimCancel(
        request,
        env,
        Number(fantasyWaiverClaimCancelRoute[1]),
        Number(fantasyWaiverClaimCancelRoute[2]),
        cors,
      );
    }
    const fantasyFreeAgentAddRoute = url.pathname.match(/^\/fantasy\/league\/(\d+)\/freeagents\/add$/);
    if (fantasyFreeAgentAddRoute && request.method === "POST") {
      return handleFantasyFreeAgentAdd(request, env, Number(fantasyFreeAgentAddRoute[1]), cors);
    }
    const fantasyWaiverSettingsRoute = url.pathname.match(/^\/fantasy\/league\/(\d+)\/waivers\/settings$/);
    if (fantasyWaiverSettingsRoute && request.method === "POST") {
      return handleFantasyWaiverSettings(request, env, Number(fantasyWaiverSettingsRoute[1]), cors);
    }
    const fantasyLeagueDetailRoute = url.pathname.match(/^\/fantasy\/league\/(\d+)$/);
    if (fantasyLeagueDetailRoute && request.method === "GET") {
      return handleFantasyLeagueDetail(request, env, Number(fantasyLeagueDetailRoute[1]), cors);
    }
    // Public, not league-scoped: xP is a property of the player, not of any
    // one manager's league membership, and the figure itself carries nothing
    // sensitive (see /analysis/:id for the same "public read" precedent).
    if (url.pathname === "/fantasy/players/xp" && request.method === "GET") {
      return handleFantasyPlayersXp(env, cors);
    }

    // Deliberately above the API_FOOTBALL_KEY guard below. This answers the
    // one question that decides whether a draft can run, and it is worth the
    // most exactly when the Worker is misconfigured, so it must not be gated
    // behind a config check that a broken deployment would fail first.
    if (url.pathname === "/health/draft-ready" && request.method === "GET") {
      return handleDraftReadyHealth(env, cors);
    }

    // Above the same guard, for the same reason plus one of its own: the
    // question this answers is "how much of the paid API-Football allowance is
    // left", and a deployment that has lost its key is exactly when someone
    // wants to look.
    if (url.pathname === "/health/quota" && request.method === "GET") {
      return handleQuotaHealth(env, cors);
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
        // A second, much tighter limit on top of the general per-IP one. This
        // route is the only unauthenticated path that fans out into several
        // upstream calls (four match-detail payloads, plus up to four more
        // validating the id on a cold isolate, see findKnownMatch), so the
        // 200/min that is generous for polling /live is far too loose here.
        // Keyed per IP and separate from LIMITER so hammering the
        // drawer cannot also lock a user out of the rest of the API. No-ops if
        // the binding is absent, same convention as LIMITER.
        if (env.DETAIL_LIMITER) {
          const ip = request.headers.get("CF-Connecting-IP") || "anon";
          try {
            const { success } = await env.DETAIL_LIMITER.limit({ key: ip });
            if (!success) return json({ error: "rate limited" }, 429, { ...cors, "Retry-After": "30" });
          } catch {
            // limiter unavailable, fail open
          }
        }
        const id = Number(detailRoute[1]);
        const known = await findKnownMatch(competitions, id, token);
        if (!known) {
          return json({ error: "unknown match" }, 404, cors);
        }
        const profile = matchDetailCacheProfile(known);
        // Cost scales with TRAFFIC here, unlike every cron pass, whose cost is
        // fixed. That shape is the dangerous one against a hard daily cap, so
        // this route is the first to give ground when the allowance runs low:
        // it sheds payloads by budget level and, at the tightest level, is
        // built entirely from the fixture summary findKnownMatch already
        // returned for zero upstream calls. It always answers with a real
        // match rather than an error, naming whatever it could not fetch on
        // detail.degraded exactly as a genuine upstream failure would.
        const detail = await fetchMatchDetail(id, token, profile, known, currentBudgetLevel());
        // The browser cache window follows the same reasoning as the edge one:
        // a finished match does not need re-fetching every 25 seconds. A read
        // that degraded is capped much shorter so a transient upstream fault
        // cannot outlive itself in every reader's cache.
        const browserMaxAge = matchDetailBrowserMaxAge(profile, Boolean(detail.degraded));
        return json(detail, 200, { ...cors, "Cache-Control": `public, max-age=${browserMaxAge}` });
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
  // play, fans out push notifications for followed clubs, and scores finished PL
  // fantasy matches. Run sequentially, not concurrently: all three passes fetch the
  // same /live and per-match detail URLs, and only a sequential order lets each
  // later pass land on the edge cache an earlier one just warmed. Running them in
  // parallel would fire the fetches before any response is cached, needlessly
  // spending the daily API-Football allowance.
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      (async () => {
        // Each pass is isolated. They used to be bare sequential awaits, which
        // meant any one of them throwing silently skipped every pass behind it
        // for as long as the fault lasted. That was not hypothetical: an
        // unchunked IN clause in the scoring pass (see fantasyScoredMatchIds)
        // would have started throwing every tick around gameweek 11 and taken
        // waivers, draft reminders and the xP blend down with it for the rest
        // of the season, with nothing in the product to show anything was
        // wrong. Isolation is what makes the ordering below a preference
        // rather than a dependency chain.
        //
        // Order still matters for cache warmth and for priority: the passes
        // share the same upstream fetches, and a sequential order lets each
        // later one land on the edge cache an earlier one just warmed. The
        // pool seed leads because a draft that cannot start is the worst
        // failure here and its check is a COUNT that costs nothing; the xP
        // blend trails because it only refreshes a display figure.
        await runCronPass("player-pool", () => ensureFantasyPlayerPool(env));
        await runCronPass("analysis", () => runScheduledAnalysis(env));
        await runCronPass("notifications", () => runScheduledNotifications(env));
        await runCronPass("fantasy-scoring", () => runScheduledFantasyScoring(env));
        await runCronPass("waiver-runs", () => runScheduledWaiverRuns(env));
        await runCronPass("draft-reminders", () => runScheduledDraftReminders(env));
        await runCronPass("xp-blend", () => runScheduledFantasyXpBlend(env));
        // Last on purpose. The recap is the only pass that spends money per
        // run and the only one nothing else depends on: a league that gets its
        // recap ten minutes late has lost nothing, whereas a scoring or waiver
        // pass starved behind it would corrupt a season. It also reads
        // fantasy_gameweek_scores, which the scoring pass above may only just
        // have written, so trailing it is what lets a recap describe the
        // gameweek that settled this very tick.
        await runCronPass("league-recaps", () => runScheduledLeagueRecaps(env));
        // Dead last, after the recap. Every pass above spends API-Football
        // calls, so running the flush behind all of them is what lets one tick
        // record its own spend instead of leaving it for the next one. It is
        // also the pass that must never sit upstream of anything: analytics
        // failing is a blank chart, whereas scoring or waivers failing corrupts
        // a season.
        await runCronPass("api-usage", () => runScheduledApiUsage(env));
      })(),
    );
  },
};

// Runs one cron pass so a fault in it cannot reach its neighbours. Every pass
// is already internally idempotent and retried by the next minute's tick, so
// swallowing here loses nothing that the next tick will not redo. The name is
// logged rather than discarded: a pass that fails every minute for a season
// must be findable in the Worker's logs, since none of this is visible in the
// product until something a user cares about has already stopped working.
async function runCronPass(name, run) {
  try {
    await run();
  } catch (error) {
    console.error(`cron pass failed: ${name}`, error?.message ?? error);
  }
}

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
  // First pass to be shed when the allowance runs low, and by a distance. It
  // is the most expensive per live match (three upstream payloads every tick
  // just to compute a signature, plus an Anthropic call when it regenerates)
  // and the least load-bearing: a missing analysis renders as no card, while
  // the same calls spent on scoring settle a gameweek. See src/apiBudget.js.
  if (!allowsAnalysis(currentBudgetLevel())) {
    console.warn("analysis pass skipped: API-Football allowance low");
    return;
  }
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
// "draft" (draft-day reminders, Phase 4.5) defaults true - see DEFAULT_PREFS
// and publicUser's merge below for why an account created before this key
// existed still reads it as on rather than off.
const PREF_KEYS = new Set(["goals", "kickoff", "fulltime", "red", "analysis", "draft", "recap"]);

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
  // DEFAULT_PREFS underneath whatever is actually stored: an account created
  // before a given pref key existed (e.g. "draft", added after every other
  // key) has no entry for it in its stored JSON at all, and the client-facing
  // toggle (renderSignedIn in views.js) reads user.prefs[key] directly with
  // no fallback of its own, so a missing key must resolve to the DEFAULT_PREFS
  // value here rather than reading as off. Computed at read time, same
  // discipline as the rest of fantasy's inheritance rules - never backfilled.
  return { email: user.email, name: user.name, avatar: user.avatar, prefs: { ...DEFAULT_PREFS, ...safePrefs(user.prefs) } };
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
    await postLeagueEvent(env, leagueId, CHAT_EVENTS.LEAGUE_CREATED, { actor: memberDisplayName(user) });
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
      // Only on an actual join. Re-opening a league you are already in must
      // not announce you again on every visit.
      await postLeagueEvent(env, league.id, CHAT_EVENTS.MEMBER_JOINED, { actor: memberDisplayName(user) });
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

    const [members, picks, roster, currentGameweek, scheduleRow] = await Promise.all([
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
      env.DB.prepare(`SELECT scheduled_at, created_by FROM fantasy_draft_schedule WHERE league_id = ?1`)
        .bind(leagueId)
        .first(),
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
        // null means "not scheduled yet" (renderFantasyLobby's pre-existing
        // manual-start-only state), never an empty object.
        schedule: scheduleRow ? { scheduledAt: scheduleRow.scheduled_at, createdBy: scheduleRow.created_by } : null,
      },
      200,
      cors,
    );
  } catch {
    return json({ error: "fantasy unavailable" }, 502, cors);
  }
}

// Shared by the manual route below and the scheduled cron auto-start
// (runScheduledDraftReminders/autoStartOrNotifyLeague further down): assigns
// the snake draft position order, flips the league to "drafting", and wakes
// the FantasyDraftRoom Durable Object so the first pick clock starts
// immediately rather than waiting for whichever manager opens the draft room
// first. Factored out so the manual "start early/start unscheduled" path and
// the scheduled auto-start path can never drift apart - callers are
// responsible for their own authorization/status/member-count checks first,
// this function only does the actual starting.
async function startFantasyDraft(env, leagueId, memberIds) {
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

  await postLeagueEvent(env, leagueId, CHAT_EVENTS.DRAFT_STARTED, { managers: order.length });

  try {
    const id = env.DRAFT_ROOM.idFromName(String(leagueId));
    await env.DRAFT_ROOM.get(id).fetch("https://draft-room/start", {
      method: "POST",
      headers: { "X-Draft-League-Id": String(leagueId) },
    });
  } catch {
    // the DO self-hydrates on the first WebSocket join even if this wake fails
  }
}

// Every binding and row a draft needs, reported individually rather than as a
// single ok/not-ok, so a failure names its own cause. Deliberately unauthed
// and free of counts that reveal anything about a league's members.
async function handleDraftReadyHealth(env, cors) {
  const checks = { db: Boolean(env.DB), draftRoom: Boolean(env.DRAFT_ROOM), players: 0 };
  if (env.DB) {
    try {
      const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM fantasy_players`).first();
      checks.players = row?.count ?? 0;
    } catch {
      checks.players = null; // the table itself is unreadable, a different fault to "empty"
    }
  }
  const ready = checks.db && checks.draftRoom && checks.players > 0;
  return json({ ready, checks }, ready ? 200 : 503, cors);
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

    await startFantasyDraft(env, leagueId, memberIds);

    return json({ league: await fantasyLeagueSummary(env, leagueId) }, 200, cors);
  } catch (error) {
    // A missing player pool is the one failure a commissioner can neither
    // diagnose nor retry their way out of, so it gets its own message rather
    // than hiding inside the generic 502 that told two real leagues only
    // "fantasy unavailable".
    if (error?.message === "EMPTY_PLAYER_POOL") {
      return json({ error: "player pool unavailable, the draft cannot start yet" }, 503, cors);
    }
    return json({ error: "fantasy unavailable" }, 502, cors);
  }
}

// POST /fantasy/league/:id/draft/schedule: commissioner-only, league must
// still be pending (a started/complete draft has nothing left to schedule).
// Upserts fantasy_draft_schedule and wipes any reminder ledger rows for this
// league (see fantasy_draft_reminders' own comment in schema.sql): reminders
// already sent for an OLD scheduled time must never suppress the same kind
// firing again for a rescheduled one.
async function handleFantasyDraftScheduleSet(request, env, leagueId, cors) {
  if (!env.DB) return json({ error: "fantasy not configured" }, 501, cors);
  const user = await sessionUser(request, env);
  if (!user) return json({ error: "signed out" }, 401, cors);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad body" }, 400, cors);
  }

  try {
    const league = await env.DB.prepare(`SELECT commissioner_user_id, draft_status FROM fantasy_leagues WHERE id = ?1`)
      .bind(leagueId)
      .first();
    if (!league) return json({ error: "unknown league" }, 404, cors);
    if (league.commissioner_user_id !== user.id) return json({ error: "commissioner only" }, 403, cors);
    if (league.draft_status !== "pending") return json({ error: "draft already started" }, 400, cors);

    const validation = validateDraftSchedule(body?.scheduledAt);
    if (!validation.ok) return json({ error: validation.error }, 400, cors);

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO fantasy_draft_schedule (league_id, scheduled_at, created_by, updated_at) VALUES (?1, ?2, ?3, datetime('now'))
         ON CONFLICT(league_id) DO UPDATE SET scheduled_at = ?2, created_by = ?3, updated_at = datetime('now')`,
      ).bind(leagueId, validation.scheduledAtIso, user.id),
      env.DB.prepare(`DELETE FROM fantasy_draft_reminders WHERE league_id = ?1`).bind(leagueId),
    ]);

    return json({ schedule: { scheduledAt: validation.scheduledAtIso } }, 200, cors);
  } catch {
    return json({ error: "fantasy unavailable" }, 502, cors);
  }
}

// DELETE /fantasy/league/:id/draft/schedule: commissioner-only, league must
// still be pending. Clears both the schedule and its reminder ledger, so a
// later fresh schedule for this league starts with a clean slate.
async function handleFantasyDraftScheduleClear(request, env, leagueId, cors) {
  if (!env.DB) return json({ error: "fantasy not configured" }, 501, cors);
  const user = await sessionUser(request, env);
  if (!user) return json({ error: "signed out" }, 401, cors);

  try {
    const league = await env.DB.prepare(`SELECT commissioner_user_id, draft_status FROM fantasy_leagues WHERE id = ?1`)
      .bind(leagueId)
      .first();
    if (!league) return json({ error: "unknown league" }, 404, cors);
    if (league.commissioner_user_id !== user.id) return json({ error: "commissioner only" }, 403, cors);
    if (league.draft_status !== "pending") return json({ error: "draft already started" }, 400, cors);

    await env.DB.batch([
      env.DB.prepare(`DELETE FROM fantasy_draft_schedule WHERE league_id = ?1`).bind(leagueId),
      env.DB.prepare(`DELETE FROM fantasy_draft_reminders WHERE league_id = ?1`).bind(leagueId),
    ]);

    return json({ schedule: null }, 200, cors);
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

// Seeds the pool when it is empty, so a fresh database (or one whose first
// seeding attempt failed) heals itself on the next cron tick rather than
// waiting for a commissioner to discover it at draft time. Ordered before
// runScheduledDraftReminders in the tick so a scheduled auto-start later in
// the same tick finds a pool already there. Gated on a COUNT rather than
// refreshing unconditionally: this runs every minute, and re-upserting ~556
// rows a minute would be pure waste. Squad churn is picked up by the draft
// start's own refresh and the nightly bake, not here.
async function ensureFantasyPlayerPool(env) {
  if (!env.DB) return;
  try {
    const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM fantasy_players`).first();
    if ((row?.count ?? 0) > 0) return;
    await upsertFantasyPlayerPool(env);
  } catch {
    // nothing here is load-bearing for this tick: the next one retries, and
    // the draft-start path checks the pool again anyway
  }
}

// Upserts the baked draftable player pool into fantasy_players so the draft's
// foreign keys (fantasy_draft_picks.player_id, fantasy_rosters.player_id) hold.
// Fetched from the same static site origin the frontend and the DO both read,
// so there is exactly one source for "what a player id means".
//
// A refresh is best-effort, but having SOME pool is not: a draft that starts
// against an empty fantasy_players hits a foreign-key failure on the very
// first pick, which is how two real drafts died (the site origin was minutes
// old and not yet resolving, so this threw and took the whole draft start with
// it). So a failed or empty fetch is survivable whenever D1 already holds a
// usable pool, and only a genuinely empty pool is fatal. Throws
// EMPTY_PLAYER_POOL in that case so the caller can say something true rather
// than a generic 502.
async function upsertFantasyPlayerPool(env) {
  const origin = env.SITE_ORIGIN ?? "";
  let players = [];
  try {
    const response = await fetch(`${origin}/data/PL/players.json`);
    if (!response.ok) throw new Error(`player pool fetch failed: ${response.status}`);
    const body = await response.json();
    players = (body.players ?? []).filter((player) => player?.id != null);
  } catch {
    players = [];
  }

  if (!players.length) {
    const existing = await env.DB.prepare(`SELECT COUNT(*) AS count FROM fantasy_players`).first();
    if ((existing?.count ?? 0) > 0) return;
    throw new Error("EMPTY_PLAYER_POOL");
  }

  // D1 batches are practically bounded; chunk the upsert so a large squad pool
  // (all 20 PL clubs, ~500-600 players) never risks a single oversized batch.
  // Each chunk also seeds fantasy_player_xp's historical_xp/historical_basis
  // from the baked pool's own xp/xpBasis (Phase 4.5's expected-points bake -
  // see scripts/fetch-fantasy-players.mjs). historical_* is always refreshed
  // from the pool; xp/xp_basis (what the app actually reads) is only
  // INSERTed for a player fantasy_player_xp has never seen before - an
  // existing row's xp/xp_basis is left alone here so a re-bake never
  // clobbers whatever runScheduledFantasyXpBlend already computed this
  // season with the untouched historical figure.
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
    await env.DB.batch(
      chunk.map((player) => {
        const xp = typeof player.xp === "number" && Number.isFinite(player.xp) ? player.xp : null;
        const basis = typeof player.xpBasis === "string" ? player.xpBasis : null;
        return env.DB.prepare(
          `INSERT INTO fantasy_player_xp (player_id, historical_xp, historical_basis, xp, xp_basis, updated_at)
           VALUES (?1, ?2, ?3, ?2, ?3, datetime('now'))
           ON CONFLICT(player_id) DO UPDATE SET historical_xp = ?2, historical_basis = ?3, updated_at = datetime('now')`,
        ).bind(player.id, xp, basis);
      }),
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
// unconditionally the PL feed. A gameweek is a WINDOW of wall-clock time, not
// the provider's matchday label (see src/fantasyCalendar.js): the earliest
// window still holding an unsettled fixture is "now", floored by whichever
// window the clock is actually in so the answer can never move backwards when
// a fixture is rescheduled. Any failure (feed down, PL not configured, local
// dev with a dummy API key) falls back to gameweek 1 rather than erroring.
async function currentFantasyGameweek(env) {
  try {
    // Local development only: the gameweek is normally derived from live match
    // data, which a dev machine has no API key for, so it would be pinned at 1
    // forever and standings (which only count gameweeks before the current one)
    // could never show anything. Set FANTASY_GAMEWEEK_OVERRIDE in worker/.dev.vars
    // to walk a simulated season. Unset in production, so no behavior changes there.
    const override = Number(env.FANTASY_GAMEWEEK_OVERRIDE);
    if (Number.isInteger(override) && override > 0) return override;

    const comp = parseCompetitions(env).find((entry) => entry.code === "PL");
    if (!comp || !env.API_FOOTBALL_KEY) return 1;
    const live = await getLive(comp, env.API_FOOTBALL_KEY);
    return currentGameweekFromMatches(live.matches, Date.now());
  } catch {
    return 1;
  }
}

// The PL match list for kickoff-lock checks (src/fantasyLocks.js), gameweek
// status and the waiver timetable, read off the same edge-cached getLive()
// every other fantasy handler already calls. Returns null, not an empty array,
// when the feed is unavailable (no API key locally, upstream down, PL not
// configured), so a caller can tell "nothing to check against" apart from
// "checked, nothing is locked" and choose to fail open rather than block every
// free-agent move on a feed blip.
//
// Stamped with calendar gameweeks HERE, once per call, so every consumer sees
// a fixture in the window it was actually played in rather than the window its
// provider matchday label claims. A consumer that re-derived this for itself
// would be one postponement away from disagreeing with the others.
async function currentFantasyMatches(env) {
  try {
    if (!env.API_FOOTBALL_KEY) return null;
    const comp = parseCompetitions(env).find((entry) => entry.code === "PL");
    if (!comp) return null;
    const live = await getLive(comp, env.API_FOOTBALL_KEY);
    return assignGameweeks(live.matches ?? []);
  } catch {
    return null;
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

// Shared by the /lineup GET route and the scoring cron: resolves one
// manager's starting XI for `gameweek` exactly the same way in both places
// (fantasy_lineups exact-match, else inherited from the latest earlier
// gameweek, else defaultLineup's computed-on-read fill), so the two callers
// can never disagree about "what were they playing that week".
//
// A set-or-inherited lineup can reference a player the manager no longer
// owns (dropped since via free agency or a waiver claim, Phase 4.4);
// repairLineup filters those out and tops up from the current roster so the
// XI is always exactly STARTING_SIZE and legal, never silently short or
// scoring a lost player as a permanent dead slot. Never written back to
// fantasy_lineups: the repair is recomputed on every read, same discipline
// as defaultLineup, so a manager who later re-sets their lineup themselves
// simply overwrites it as normal.
async function resolveManagerLineup(env, leagueId, userId, gameweek) {
  const [roster, lineupRows] = await Promise.all([
    fantasyRosterFor(env, leagueId, userId),
    env.DB.prepare(`SELECT gameweek, player_id, is_captain FROM fantasy_lineups WHERE league_id = ?1 AND user_id = ?2`)
      .bind(leagueId, userId)
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

  const repair = repairLineup(starters, roster);
  if (repair.repaired) {
    starters = repair.starters;
    source = "repaired";
  }
  return { roster, starters, source };
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
    const { roster, starters, source } = await resolveManagerLineup(env, leagueId, user.id, gameweek);

    const starterIds = new Set(starters.map((entry) => entry.playerId));
    const bench = roster.filter((player) => !starterIds.has(player.id)).map((player) => player.id);

    // How many times each club plays inside this gameweek's window, so the
    // pitch view can label a blank (a club absent from this map plays no match
    // and scores nothing) or a double (2) instead of showing a manager an XI
    // that silently returns zero and looks broken. A missing feed sends no map
    // at all rather than an empty one, so the client can tell "no fixtures"
    // apart from "we could not look".
    const matches = await currentFantasyMatches(env);
    const clubFixtures = matches ? Object.fromEntries(clubFixtureCounts(matches, gameweek)) : null;

    return json({ gameweek, source, starters, bench, clubFixtures }, 200, cors);
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

    // Kickoff lock. Writing to the server-derived current gameweek stops a
    // manager rewriting a gameweek that has already SETTLED, but not one that
    // is still in progress, and a Premier League gameweek stays current until
    // its last fixture finishes. Without this check a manager could wait until
    // Saturday's matches were done, then start the players who scored, bench
    // the ones who blanked and captain the hat-trick, and the Monday-night
    // rollup would score the rewritten XI. That is the exact exploit
    // src/fantasyLocks.js exists to close, and it was wired into free agency
    // and waivers but never into the lineup route itself.
    //
    // Only players whose status actually changes are checked, so a manager can
    // still freely reshuffle team-mates who have not kicked off.
    //
    // Fails OPEN when the feed is unavailable, deliberately and identically to
    // the free-agent path: freezing every manager's team on a feed blip is
    // worse than the rare window it would leave open.
    // Resolved unconditionally, not only on the locked path: the same diff
    // decides whether this save is worth announcing in the league feed below.
    // A manager nudging their XI six times before kickoff should produce one
    // feed line, not six.
    const previous = await resolveManagerLineup(env, leagueId, user.id, gameweek);
    const changed = lineupChangedPlayerIds({
      previousStarterIds: previous.starters.map((entry) => entry.playerId),
      previousCaptainId: previous.starters.find((entry) => entry.isCaptain)?.playerId ?? null,
      nextStarterIds: starters,
      nextCaptainId: captainId,
    });

    const matches = await currentFantasyMatches(env);
    if (matches) {
      const rosterById = new Map(roster.map((player) => [player.id, player]));
      for (const playerId of changed) {
        const player = rosterById.get(playerId);
        if (!player) continue;
        const lock = playerLockState({ team: player.team, matches, gameweek, now: Date.now() });
        if (lock.locked) {
          return json(
            { error: `${player.name} is locked: ${player.team} have already kicked off this gameweek` },
            400,
            cors,
          );
        }
      }
    }

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

    // Only when something actually moved (see `changed` above), and only the
    // captain by name: the full eleven would drown the feed, and the armband
    // is the part of an XI a league argues about. `changed` is a Set, so this
    // is .size and not .length.
    if (changed.size) {
      await postLeagueEvent(env, leagueId, CHAT_EVENTS.LINEUP_SET, {
        actor: memberDisplayName(user),
        gameweek,
        captain: roster.find((player) => player.id === captainId)?.name ?? null,
      });
    }

    return json({ gameweek, source: "set", starters: starterEntries, bench }, 200, cors);
  } catch {
    return json({ error: "fantasy unavailable" }, 502, cors);
  }
}

// A shortlist longer than the draftable pool is meaningless, and the pool is
// roughly 550. This is the ceiling the write route enforces, sized well above
// any real shortlist so it never inconveniences a manager, and well below a
// number that would make one request expensive to serve.
const MAX_DRAFT_QUEUE_LENGTH = 600;

// GET the caller's own draft-pick shortlist: { queue: [playerId, ...] } in
// queue order, or an empty array if they have never saved one. Member-only,
// same 401/403/501 shape as the lineup routes above.
async function handleFantasyDraftQueueGet(request, env, leagueId, cors) {
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

    const rows = await env.DB.prepare(
      `SELECT player_id FROM fantasy_draft_queue WHERE league_id = ?1 AND user_id = ?2 ORDER BY position`,
    )
      .bind(leagueId, user.id)
      .all();
    return json({ queue: (rows.results ?? []).map((row) => row.player_id) }, 200, cors);
  } catch {
    return json({ error: "fantasy unavailable" }, 502, cors);
  }
}

// POST replaces the caller's own shortlist wholesale (delete-then-insert for
// this league+user, same pattern as handleFantasyLineupSet above) - the
// client always sends the whole ordered list, never a single mutation, so
// there is nothing to diff. Never routed through FantasyDraftRoom: a manager
// only ever writes their own row, so there is no turn-order race to
// arbitrate, unlike an actual pick. The Durable Object's alarm autopick
// (worker/draftRoom.js) reads this table directly on every wake.
async function handleFantasyDraftQueueSet(request, env, leagueId, cors) {
  if (!env.DB) return json({ error: "fantasy not configured" }, 501, cors);
  const user = await sessionUser(request, env);
  if (!user) return json({ error: "signed out" }, 401, cors);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad body" }, 400, cors);
  }
  const queue = Array.isArray(body?.queue) ? body.queue.map(Number) : null;
  if (!queue || queue.some((id) => !Number.isInteger(id))) {
    return json({ error: "bad queue" }, 400, cors);
  }
  // Defensive de-dup: the client-side queue helpers (src/fantasyDraft.js)
  // already prevent duplicates, but a stale/replayed save must not trip the
  // (league_id, user_id, player_id) primary key.
  const deduped = [...new Set(queue)];
  // Hard cap. The UI can only queue players that exist in the pool (roughly
  // 550), but this route trusts nothing from the client: without a ceiling one
  // authenticated member could post an arbitrarily long list and have us write
  // a row per entry, in a single batch, on every request. Rejected outright
  // rather than truncated, so a client that somehow built an oversized queue
  // is told instead of quietly losing the tail.
  if (deduped.length > MAX_DRAFT_QUEUE_LENGTH) {
    return json({ error: "queue too long" }, 400, cors);
  }

  try {
    const membership = await env.DB.prepare(
      `SELECT 1 AS x FROM fantasy_league_members WHERE league_id = ?1 AND user_id = ?2`,
    )
      .bind(leagueId, user.id)
      .first();
    if (!membership) return json({ error: "not a member" }, 403, cors);

    await env.DB.batch([
      env.DB.prepare(`DELETE FROM fantasy_draft_queue WHERE league_id = ?1 AND user_id = ?2`).bind(leagueId, user.id),
      ...deduped.map((playerId, index) =>
        env.DB.prepare(
          `INSERT INTO fantasy_draft_queue (league_id, user_id, player_id, position) VALUES (?1, ?2, ?3, ?4)`,
        ).bind(leagueId, user.id, playerId, index),
      ),
    ]);

    return json({ queue: deduped }, 200, cors);
  } catch {
    return json({ error: "fantasy unavailable" }, 502, cors);
  }
}

// -- Fantasy gameweek scoring (Phase 4.3) -------------------------------------
// PL-only, same reasoning as everywhere else in fantasy. A match scores into
// the gameweek WINDOW its kickoff falls in (src/fantasyCalendar.js), which is
// not always the window its provider matchday label names: a postponed fixture
// replayed months later scores into the week it was actually played, which is
// what produces a correct double gameweek for the two clubs involved.
//
// The minute cron finds newly-FINISHED PL matches, scores each one exactly
// once via scoreMatchForPlayers, and only then rolls the affected gameweek(s)
// up into every complete-draft league's fantasy_gameweek_scores and
// fantasy_h2h_fixtures. Double-scoring/double-counting is avoided two ways:
//   - fantasy_scored_matches is a dedup ledger checked BEFORE a match is
//     processed, so a match already scored on an earlier tick is never
//     refetched or rescored (mirrors notify_state's "first sighting" pattern).
//   - fantasy_player_match_scores is keyed on (match_id, player_id) and written
//     with INSERT OR REPLACE, so even a rare retry (e.g. this tick dies after
//     writing scores but before the match makes it into the dedup ledger)
//     lands the same values again rather than summing them twice. The key is
//     per MATCH and not per gameweek precisely because a player can feature
//     twice inside one window; keying on (gameweek, player_id) silently threw
//     the first of his two matches away. Gameweek totals are always recomputed
//     by resumming this table, never incremented, so the same idempotency
//     extends to fantasy_gameweek_scores and fantasy_h2h_fixtures.

async function runScheduledFantasyScoring(env) {
  if (!env.DB || !env.API_FOOTBALL_KEY) return;
  const comp = parseCompetitions(env).find((entry) => entry.code === "PL");
  if (!comp) return; // fantasy is PL-only; nothing to score without PL configured

  let live;
  try {
    live = await getLive(comp, env.API_FOOTBALL_KEY);
  } catch {
    return; // feed down; the next tick retries
  }

  const matches = assignGameweeks(live.matches ?? []);
  const candidates = matches.filter((match) => isMatchFinished(match) && Number.isInteger(gameweekOf(match)));
  if (!candidates.length) return;

  const alreadyScored = await fantasyScoredMatchIds(
    env,
    candidates.map((match) => match.id),
  );
  const newlyFinished = candidates.filter((match) => !alreadyScored.has(match.id));
  if (!newlyFinished.length) return;

  const touchedGameweeks = new Set();
  for (const [index, match] of newlyFinished.entries()) {
    try {
      if (index > 0) await sleep(MATCH_DETAIL_PACING_MS);
      const detail = await fetchMatchDetail(match.id, env.API_FOOTBALL_KEY);
      const scores = scoreMatchForPlayers(detail);
      // Players never in the baked squad pool (a late loan, a call-up who
      // missed the fetch:fantasy-players bake) still need a fantasy_players
      // row before fantasy_player_match_scores/fantasy_rosters can reference
      // them. OR IGNORE so the curated pool is never clobbered for a player
      // already known good. scoreMatchForPlayers can credit a goal/assist/card
      // id that never appears in the lineup or bench (an events/lineups
      // discrepancy upstream), so every scored id gets a placeholder row too,
      // not just the lineup+bench ids, or that match's whole score write would
      // fail its foreign key and retry forever on every future tick.
      await upsertFantasyPlayersFromDetail(env, detail, scores.keys());
      await writeFantasyPlayerScores(env, match.id, gameweekOf(match), scores);
      await env.DB.prepare(`INSERT OR IGNORE INTO fantasy_scored_matches (match_id) VALUES (?1)`)
        .bind(match.id)
        .run();
      touchedGameweeks.add(gameweekOf(match));
    } catch {
      // one broken match must not block the others; since it never reaches
      // fantasy_scored_matches, the next tick retries it from scratch
    }
  }
  if (!touchedGameweeks.size) return; // no new data this tick, no D1 rollup work needed

  for (const gameweek of touchedGameweeks) {
    try {
      await recomputeFantasyGameweek(env, gameweek);
    } catch {
      // one gameweek's rollup failing must not block the others; retried next tick
    }
  }
}

// D1 caps a query at 100 bound parameters. The caller passes every FINISHED
// fixture in the season (getLive returns the whole schedule, so that set only
// grows), which means an unchunked IN clause silently works all pre-season and
// then throws from the moment the 101st match finishes, around gameweek 11.
// Worse, the throw used to escape the whole scoring pass and, because the cron
// awaits its passes sequentially without guards, took waivers, draft reminders
// and the xP blend down with it for the rest of the season.
//
// Chunked well under the cap rather than exactly at it: the limit applies to
// bound parameters, and leaving headroom means a future caller adding one more
// bound value to this query cannot quietly reintroduce the same cliff.
const D1_MAX_BOUND_PARAMS = 100;
const SCORED_MATCH_ID_CHUNK = 50;

async function fantasyScoredMatchIds(env, ids) {
  if (!ids.length) return new Set();
  const scored = new Set();
  for (let i = 0; i < ids.length; i += SCORED_MATCH_ID_CHUNK) {
    const chunk = ids.slice(i, i + SCORED_MATCH_ID_CHUNK);
    const placeholders = chunk.map((_, index) => `?${index + 1}`).join(",");
    const rows = await env.DB.prepare(
      `SELECT match_id FROM fantasy_scored_matches WHERE match_id IN (${placeholders})`,
    )
      .bind(...chunk)
      .all();
    for (const row of rows.results ?? []) scored.add(row.match_id);
  }
  return scored;
}

async function upsertFantasyPlayersFromDetail(env, detail, extraIds = []) {
  const players = [];
  const seen = new Set();
  for (const side of ["home", "away"]) {
    const team = detail[side];
    for (const player of [...(team?.lineup ?? []), ...(team?.bench ?? [])]) {
      if (player.id == null || seen.has(player.id)) continue;
      seen.add(player.id);
      players.push({
        id: player.id,
        name: player.name || "",
        team: team?.name || "",
        position: bucketPosition(player.pos) ?? "MID",
      });
    }
  }
  // scoreMatchForPlayers can credit an id (a goal scorer, assister or carded
  // player) that never showed up in either side's lineup or bench, an
  // events/lineups discrepancy upstream. A bare placeholder row is enough to
  // satisfy fantasy_player_scores' foreign key; a later squads-pool bake or
  // draft start fills in the real name/team/position via its own REPLACE.
  for (const id of extraIds) {
    if (id == null || seen.has(id)) continue;
    seen.add(id);
    players.push({ id, name: "", team: "", position: "MID" });
  }
  if (!players.length) return;
  await env.DB.batch(
    players.map((player) =>
      env.DB.prepare(
        `INSERT OR IGNORE INTO fantasy_players (id, name, team, position, active) VALUES (?1, ?2, ?3, ?4, 1)`,
      ).bind(player.id, player.name, player.team, player.position),
    ),
  );
}

// One row per player per MATCH, tagged with the gameweek window that match was
// played in. A squad is roughly 30 players, well inside D1's 100-bound-
// parameter cap for a single batch of one-row inserts.
async function writeFantasyPlayerScores(env, matchId, gameweek, scores) {
  const entries = [...scores.entries()];
  if (!entries.length) return;
  await env.DB.batch(
    entries.map(([playerId, entry]) =>
      env.DB.prepare(
        `INSERT OR REPLACE INTO fantasy_player_match_scores (match_id, player_id, gameweek, points, breakdown, computed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))`,
      ).bind(matchId, playerId, gameweek, entry.points, JSON.stringify(entry.breakdown)),
    ),
  );
}

// Every player's total for one gameweek, summed across every match they
// featured in inside that window. sumPlayerPoints rather than the SQL SUM so
// the accumulation is the same unit-tested pure function the rest of the
// fantasy rules use, and so a caller can never accidentally rebuild the map
// with `new Map(rows.map(...))` and drop the second match of a double
// gameweek on the floor.
async function fantasyPlayerPointsForGameweek(env, gameweek) {
  const rows = await env.DB.prepare(
    `SELECT player_id, points FROM fantasy_player_match_scores WHERE gameweek = ?1`,
  )
    .bind(gameweek)
    .all();
  return sumPlayerPoints((rows.results ?? []).map((row) => ({ playerId: row.player_id, points: row.points })));
}

// Rolls one gameweek's freshly-scored players up into every complete-draft
// league's totals and head-to-head fixtures.
async function recomputeFantasyGameweek(env, gameweek) {
  const playerPoints = await fantasyPlayerPointsForGameweek(env, gameweek);

  const leagues = await env.DB.prepare(`SELECT id FROM fantasy_leagues WHERE draft_status = 'complete'`).all();
  for (const league of leagues.results ?? []) {
    await recomputeLeagueGameweek(env, league.id, gameweek, playerPoints);
  }
}

async function recomputeLeagueGameweek(env, leagueId, gameweek, playerPoints) {
  const members = await env.DB.prepare(`SELECT user_id FROM fantasy_league_members WHERE league_id = ?1`)
    .bind(leagueId)
    .all();
  const memberIds = (members.results ?? []).map((row) => row.user_id);
  if (!memberIds.length) return;

  const gwScores = new Map();
  for (const userId of memberIds) {
    const { starters } = await resolveManagerLineup(env, leagueId, userId, gameweek);
    const { points } = rosterGameweekPoints({ starters }, playerPoints);
    gwScores.set(userId, points);
  }

  await env.DB.batch(
    memberIds.map((userId) =>
      env.DB.prepare(
        `INSERT INTO fantasy_gameweek_scores (league_id, user_id, gameweek, points, computed_at)
         VALUES (?1, ?2, ?3, ?4, datetime('now'))
         ON CONFLICT(league_id, user_id, gameweek) DO UPDATE SET points = ?4, computed_at = datetime('now')`,
      ).bind(leagueId, userId, gameweek, gwScores.get(userId)),
    ),
  );

  const fixtures = await env.DB.prepare(
    `SELECT home_user_id, away_user_id FROM fantasy_h2h_fixtures WHERE league_id = ?1 AND gameweek = ?2`,
  )
    .bind(leagueId, gameweek)
    .all();
  const fixtureUpdates = [];
  for (const fixture of fixtures.results ?? []) {
    // gwScores always has every league member (rosterGameweekPoints defaults
    // an unscored player to 0 rather than skipping them), so both sides of
    // every fixture get written every pass; the has() check just guards
    // against a fixture referencing a user who has since left the league.
    if (gwScores.has(fixture.home_user_id)) {
      fixtureUpdates.push(
        env.DB.prepare(
          `UPDATE fantasy_h2h_fixtures SET home_score = ?1 WHERE league_id = ?2 AND gameweek = ?3 AND home_user_id = ?4`,
        ).bind(gwScores.get(fixture.home_user_id), leagueId, gameweek, fixture.home_user_id),
      );
    }
    if (gwScores.has(fixture.away_user_id)) {
      fixtureUpdates.push(
        env.DB.prepare(
          `UPDATE fantasy_h2h_fixtures SET away_score = ?1 WHERE league_id = ?2 AND gameweek = ?3 AND home_user_id = ?4`,
        ).bind(gwScores.get(fixture.away_user_id), leagueId, gameweek, fixture.home_user_id),
      );
    }
  }
  if (fixtureUpdates.length) await env.DB.batch(fixtureUpdates);
}

// -- Expected points (xP): in-season blend (Phase 4.5) -----------------------
// data/PL/players.json bakes each player's HISTORICAL xP (see
// scripts/fetch-fantasy-players.mjs and src/fantasyExpectedPoints.js), seeded
// into fantasy_player_xp.historical_xp/historical_basis by
// upsertFantasyPlayerPool above. This pass blends that prior with the
// player's actual scoring so far THIS season
// (src/fantasyExpectedPoints.js's blendWithCurrentSeason) and writes the
// result to fantasy_player_xp.xp/xp_basis, which is what GET
// /fantasy/players/xp (and so the app) actually reads.
//
// Gated on a newly-COMPLETED gameweek, not run on every one-minute tick:
// fantasy_xp_state remembers the last gameweek this pass already blended
// through, so a tick that finds no new completed gameweek is a single cheap
// D1 read and nothing else - recomputing ~550 players' worth of scores every
// minute for a figure that only changes once a gameweek finishes would be
// pure waste.
async function runScheduledFantasyXpBlend(env) {
  if (!env.DB || !env.API_FOOTBALL_KEY) return;
  try {
    const comp = parseCompetitions(env).find((entry) => entry.code === "PL");
    if (!comp) return; // fantasy is PL-only; nothing to blend without PL configured

    // Reuses the same /live fetch runScheduledFantasyScoring already made
    // this tick (same edge cache, same reasoning as the scheduled() handler's
    // own docstring on why these passes run sequentially rather than in
    // parallel).
    const live = await getLive(comp, env.API_FOOTBALL_KEY);
    const currentGameweek = currentGameweekFromMatches(live.matches, Date.now());
    const latestCompleted = currentGameweek - 1;
    if (latestCompleted < 1) return; // season hasn't produced a completed gameweek yet

    const state = await env.DB.prepare(`SELECT last_completed_gameweek FROM fantasy_xp_state WHERE id = 1`).first();
    if ((state?.last_completed_gameweek ?? 0) >= latestCompleted) return; // nothing new to blend

    const [playersResult, scoresResult] = await Promise.all([
      env.DB.prepare(`SELECT id, historical_xp, historical_basis FROM fantasy_players WHERE active = 1`).all(),
      // Aggregated in SQL rather than row by row: the underlying table is one
      // row per player per MATCH, and blendWithCurrentSeason divides by
      // gameweeks played, so a double gameweek's two matches must count as one
      // gameweek (COUNT(DISTINCT gameweek)) while contributing both scores
      // (SUM(points)). Counting rows would quietly halve such a player's
      // per-gameweek average.
      env.DB.prepare(
        `SELECT player_id, SUM(points) AS points, COUNT(DISTINCT gameweek) AS gameweeks
         FROM fantasy_player_match_scores WHERE gameweek <= ?1 GROUP BY player_id`,
      )
        .bind(latestCompleted)
        .all(),
    ]);

    const pointsByPlayer = new Map();
    const gameweeksByPlayer = new Map();
    for (const row of scoresResult.results ?? []) {
      pointsByPlayer.set(row.player_id, row.points);
      gameweeksByPlayer.set(row.player_id, row.gameweeks);
    }

    const CHUNK = 100;
    const players = playersResult.results ?? [];
    for (let i = 0; i < players.length; i += CHUNK) {
      const chunk = players.slice(i, i + CHUNK);
      try {
        await env.DB.batch(
          chunk.map((player) => {
            const gameweeksPlayed = gameweeksByPlayer.get(player.id) ?? 0;
            const currentSeasonPoints = pointsByPlayer.get(player.id) ?? 0;
            const blended = blendWithCurrentSeason(player.historical_xp, currentSeasonPoints, gameweeksPlayed);
            const basis = gameweeksPlayed > 0 ? "blended" : player.historical_basis;
            return env.DB.prepare(
              `UPDATE fantasy_player_xp SET xp = ?2, xp_basis = ?3, updated_at = datetime('now') WHERE player_id = ?1`,
            ).bind(player.id, blended, basis);
          }),
        );
      } catch {
        // one bad chunk must not block the others; the next gameweek's blend
        // (or a later tick, once fantasy_xp_state hasn't advanced) retries it
      }
    }

    await env.DB.prepare(
      `INSERT INTO fantasy_xp_state (id, last_completed_gameweek, updated_at) VALUES (1, ?1, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET last_completed_gameweek = ?1, updated_at = datetime('now')`,
    )
      .bind(latestCompleted)
      .run();
  } catch {
    // best-effort, same discipline as the bake's own historical enrichment:
    // xP is a display figure, never a new single point of failure for the
    // rest of the cron (see the comment on its call site in scheduled())
  }
}

// GET /fantasy/players/xp: every active player's current xp/xpBasis, public
// and not league-scoped (xP is a property of the player, not of a manager's
// membership). Returns only players with a non-null xp, so the client never
// has to special-case an entry that carries nulls anyway.
async function handleFantasyPlayersXp(env, cors) {
  if (!env.DB) return json({ error: "fantasy not configured" }, 501, cors);
  try {
    const rows = await env.DB.prepare(`SELECT player_id, xp, xp_basis FROM fantasy_player_xp WHERE xp IS NOT NULL`).all();
    const players = Object.fromEntries(
      (rows.results ?? []).map((row) => [row.player_id, { xp: row.xp, xpBasis: row.xp_basis }]),
    );
    return json({ players }, 200, cors);
  } catch {
    return json({ error: "fantasy unavailable" }, 502, cors);
  }
}

async function fantasyGameweekScore(env, leagueId, userId, gameweek) {
  const row = await env.DB.prepare(
    `SELECT points FROM fantasy_gameweek_scores WHERE league_id = ?1 AND user_id = ?2 AND gameweek = ?3`,
  )
    .bind(leagueId, userId, gameweek)
    .first();
  return row?.points ?? 0;
}

// GET /fantasy/league/:id/matchup: the caller's current-gameweek head-to-head,
// with live-updating scores read straight from fantasy_gameweek_scores rather
// than the possibly-stale fantasy_h2h_fixtures row (which only settles once
// the cron rolls that gameweek up). A null opponent means a bye week, which
// round-robin scheduling can produce for an odd-sized league.
async function handleFantasyMatchup(request, env, leagueId, cors) {
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

    let status = "scheduled";
    try {
      if (env.API_FOOTBALL_KEY) {
        const comp = parseCompetitions(env).find((entry) => entry.code === "PL");
        if (comp) {
          const live = await getLive(comp, env.API_FOOTBALL_KEY);
          status = gameweekStatus(live.matches, gameweek);
        }
      }
    } catch {
      // feed unavailable this tick; "scheduled" is the safe, non-alarming default
    }

    const fixture = await env.DB.prepare(
      `SELECT home_user_id, away_user_id FROM fantasy_h2h_fixtures
       WHERE league_id = ?1 AND gameweek = ?2 AND (home_user_id = ?3 OR away_user_id = ?3)`,
    )
      .bind(leagueId, gameweek, user.id)
      .first();

    const meScore = await fantasyGameweekScore(env, leagueId, user.id, gameweek);
    const me = { userId: user.id, name: user.name || "You", score: meScore };

    if (!fixture) {
      return json({ gameweek, status, me, opponent: null }, 200, cors);
    }

    const opponentId = fixture.home_user_id === user.id ? fixture.away_user_id : fixture.home_user_id;
    const [opponentRow, opponentScore] = await Promise.all([
      env.DB.prepare(`SELECT name, email FROM users WHERE id = ?1`).bind(opponentId).first(),
      fantasyGameweekScore(env, leagueId, opponentId, gameweek),
    ]);
    const opponent = {
      userId: opponentId,
      name: opponentRow?.name || String(opponentRow?.email ?? "").split("@")[0] || "Someone",
      score: opponentScore,
    };

    return json({ gameweek, status, me, opponent }, 200, cors);
  } catch {
    return json({ error: "fantasy unavailable" }, 502, cors);
  }
}

// GET /fantasy/league/:id/standings: only gameweeks strictly before the
// current one count, so a mid-gameweek score can never flicker the table
// before that gameweek is actually done.
async function handleFantasyStandings(request, env, leagueId, cors) {
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

    const currentGameweek = await currentFantasyGameweek(env);
    const throughGameweek = currentGameweek - 1;

    const [membersRows, fixtureRows] = await Promise.all([
      env.DB.prepare(
        `SELECT m.user_id, u.name, u.email FROM fantasy_league_members m
         JOIN users u ON u.id = m.user_id
         WHERE m.league_id = ?1`,
      )
        .bind(leagueId)
        .all(),
      throughGameweek >= 1
        ? env.DB.prepare(
            `SELECT gameweek, home_user_id, away_user_id, home_score, away_score
             FROM fantasy_h2h_fixtures WHERE league_id = ?1 AND gameweek <= ?2`,
          )
            .bind(leagueId, throughGameweek)
            .all()
        : Promise.resolve({ results: [] }),
    ]);

    const members = (membersRows.results ?? []).map((row) => ({
      userId: row.user_id,
      name: row.name || String(row.email ?? "").split("@")[0] || "Someone",
    }));
    const fixtures = (fixtureRows.results ?? []).map((row) => ({
      gameweek: row.gameweek,
      homeUserId: row.home_user_id,
      awayUserId: row.away_user_id,
      homeScore: row.home_score,
      awayScore: row.away_score,
    }));

    return json({ throughGameweek, standings: standingsFromFixtures(fixtures, members) }, 200, cors);
  } catch {
    return json({ error: "fantasy unavailable" }, 502, cors);
  }
}

// -- League feed: chat + auto-posted system events (Phase 4.6) ----------------
//
// ONE stream per league carrying both what the app did and what managers said
// about it, never two surfaces. Built-in league chat is abandoned on ESPN and
// Yahoo and heavily used on Sleeper, and the difference managers describe is
// exactly this: the moves and the conversation about the moves are the same
// timeline, so a waiver run clearing at 9am produces a conversation instead of
// a notification nobody opens. A chat tab beside a separate transaction log
// would rebuild the version that fails.
//
// The pure half (validation, caps, the event vocabulary, and turning a stored
// event back into a sentence at READ time so a copy change never leaves old
// rows speaking an older dialect) lives in src/fantasyChat.js, the same split
// as fantasyWaivers.js and draftLogic.js.

// A member's display name, with the same fallback chain the rest of the
// fantasy routes already use. System-event payloads store the result rather
// than a user id: the feed is a permanent history and must keep reading
// correctly after a rename or a deleted account.
function memberDisplayName(row) {
  return row?.name || String(row?.email ?? "").split("@")[0] || "Someone";
}

// The prepared statement for one system event, so a caller can fold it into
// the same env.DB.batch as the change it describes and get atomicity for free
// (see the recap pass and the draft room's commitPick). Payload is JSON: facts
// only, never pre-rendered prose.
function leagueEventStatement(env, leagueId, event, payload) {
  return env.DB.prepare(
    `INSERT INTO fantasy_chat_messages (league_id, user_id, kind, event, payload) VALUES (?1, NULL, 'system', ?2, ?3)`,
  ).bind(leagueId, event, JSON.stringify(payload ?? {}));
}

// Fire-and-forget variant for the routes where the change has already
// committed and the feed row is commentary on it. Deliberately swallows: a
// manager's lineup save must not fail because the feed insert did, and the
// worst case is one missing line in a chat log.
async function postLeagueEvent(env, leagueId, event, payload) {
  try {
    await leagueEventStatement(env, leagueId, event, payload).run();
  } catch (error) {
    console.error("league feed event failed", event, error?.message ?? error);
  }
}

async function handleFantasyChat(request, env, leagueId, cors) {
  if (!env.DB) return json({ error: "fantasy not configured" }, 501, cors);
  const user = await sessionUser(request, env);
  if (!user) return json({ error: "signed out" }, 401, cors);

  try {
    // Membership is checked on reads as well as writes, unlike match banter
    // which is public: a private league's transactions and trash talk are not
    // for anyone who can guess a league id.
    const membership = await env.DB.prepare(
      `SELECT 1 AS x FROM fantasy_league_members WHERE league_id = ?1 AND user_id = ?2`,
    )
      .bind(leagueId, user.id)
      .first();
    if (!membership) return json({ error: "not a member" }, 403, cors);

    if (request.method === "GET") {
      return json(await readLeagueChat(env, leagueId, user.id), 200, cors);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "bad body" }, 400, cors);
    }

    if (body?.action === "message") {
      const text = cleanChatText(body.text);
      if (!text) return json({ error: "empty message" }, 400, cors);
      // Counts human messages only. A league that talked its way to the cap
      // must still be told that its waiver run happened, and the app's own
      // output is bounded by the season anyway.
      const count = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM fantasy_chat_messages WHERE league_id = ?1 AND kind = 'message'`,
      )
        .bind(leagueId)
        .first();
      if ((count?.n ?? 0) >= MAX_CHAT_MESSAGES_PER_LEAGUE) {
        return json({ error: "this league's feed is full" }, 400, cors);
      }
      await env.DB.prepare(
        `INSERT INTO fantasy_chat_messages (league_id, user_id, kind, text) VALUES (?1, ?2, 'message', ?3)`,
      )
        .bind(leagueId, user.id, text)
        .run();
    } else if (body?.action === "react") {
      if (!CHAT_REACTIONS.includes(body.emoji)) return json({ error: "bad emoji" }, 400, cors);
      const messageId = Number(body.messageId);
      if (!Number.isInteger(messageId)) return json({ error: "bad message" }, 400, cors);
      // The message must belong to THIS league. Message ids are globally
      // sequential, so without this check a member of one league could react
      // to (and by the response, learn the content of) another league's feed.
      const target = await env.DB.prepare(`SELECT 1 AS x FROM fantasy_chat_messages WHERE id = ?1 AND league_id = ?2`)
        .bind(messageId, leagueId)
        .first();
      if (!target) return json({ error: "unknown message" }, 404, cors);

      // Toggle: delete wins if the row exists, otherwise insert. Two
      // statements, but the primary key makes a lost race harmless, the same
      // reasoning as banter's reaction toggle.
      const deleted = await env.DB.prepare(
        `DELETE FROM fantasy_chat_reactions WHERE message_id = ?1 AND user_id = ?2 AND emoji = ?3`,
      )
        .bind(messageId, user.id, body.emoji)
        .run();
      if ((deleted.meta?.changes ?? 0) === 0) {
        await env.DB.prepare(
          `INSERT OR IGNORE INTO fantasy_chat_reactions (message_id, user_id, emoji) VALUES (?1, ?2, ?3)`,
        )
          .bind(messageId, user.id, body.emoji)
          .run();
      }
    } else {
      return json({ error: "bad action" }, 400, cors);
    }

    // D1 is strongly consistent, so the state returned here always includes
    // this very write and the optimistic UI reconciles without flicker (the
    // same contract banter.js relies on).
    return json(await readLeagueChat(env, leagueId, user.id), 200, cors);
  } catch {
    return json({ error: "fantasy unavailable" }, 502, cors);
  }
}

async function readLeagueChat(env, leagueId, userId) {
  const rows = await env.DB.prepare(
    `SELECT m.id, m.kind, m.event, m.payload, m.text, m.created_at, m.user_id, u.name, u.email
     FROM fantasy_chat_messages m
     LEFT JOIN users u ON u.id = m.user_id
     WHERE m.league_id = ?1 ORDER BY m.id DESC LIMIT ?2`,
  )
    .bind(leagueId, CHAT_PAGE_SIZE)
    .all();

  const window = (rows.results ?? []).slice().reverse();
  const oldestId = window.length ? window[0].id : 0;

  // Reactions for exactly the window just read, joined through the messages
  // table rather than bound as one parameter per message id: CHAT_PAGE_SIZE
  // ids would sit right against D1's 100-bound-parameter ceiling, and this
  // costs two parameters regardless of page size.
  const reactionRows = await env.DB.prepare(
    `SELECT r.message_id, r.user_id, r.emoji FROM fantasy_chat_reactions r
     JOIN fantasy_chat_messages m ON m.id = r.message_id
     WHERE m.league_id = ?1 AND m.id >= ?2`,
  )
    .bind(leagueId, oldestId)
    .all();

  const reactions = new Map();
  for (const row of reactionRows.results ?? []) {
    if (!CHAT_REACTIONS.includes(row.emoji)) continue; // a row from an older allowlist
    let entry = reactions.get(row.message_id);
    if (!entry) {
      entry = { counts: {}, mine: [] };
      reactions.set(row.message_id, entry);
    }
    entry.counts[row.emoji] = (entry.counts[row.emoji] ?? 0) + 1;
    if (row.user_id === userId) entry.mine.push(row.emoji);
  }

  return {
    entries: window.map((row) => ({
      id: row.id,
      kind: row.kind,
      // A human message's author name is read from the account live (this is a
      // conversation, so a rename should apply); a system event's actor comes
      // from its own frozen payload, because that is history.
      userId: row.user_id ?? null,
      name: row.kind === "message" ? memberDisplayName(row) : null,
      text: row.kind === "message" ? row.text : null,
      event: row.event ?? null,
      payload: row.kind === "system" ? safeJson(row.payload) : null,
      ts: row.created_at,
      reactions: reactions.get(row.id) ?? { counts: {}, mine: [] },
    })),
    viewerUserId: userId,
  };
}

function safeJson(raw) {
  try {
    return JSON.parse(raw ?? "{}");
  } catch {
    return {};
  }
}

// -- Fantasy free agency and waivers (Phase 4.4) ------------------------------
// Player state per league is exactly one of OWNED (a fantasy_rosters row),
// ON_WAIVERS (a fantasy_waiver_wire row) or FREE_AGENT (neither); the pure
// classification, validation and run-resolution rules live in
// src/fantasyWaivers.js, mirroring draftLogic.js and fantasyLineups.js. Every
// acquisition, instant or via a claim, pairs with a same-position-bucket drop
// (the roster invariant SQUAD_SLOTS enforces: every bucket is always exactly
// full), and the dropped player always lands on the wire rather than being
// instantly re-addable, which is what stops a drop-and-re-add cycle from
// dodging the waiver queue.

async function waiverSettings(env, leagueId) {
  const row = await env.DB.prepare(`SELECT mode, faab_budget FROM fantasy_waiver_settings WHERE league_id = ?1`)
    .bind(leagueId)
    .first();
  return { mode: row?.mode ?? "faab", faabBudget: row?.faab_budget ?? DEFAULT_FAAB_BUDGET };
}

// Lazily seeds fantasy_waiver_state for every current member: initial
// priority is reverse draft order (the last drafter gets first waiver call,
// the standard fantasy-league convention), computed once per call and
// inserted OR IGNORE so a repeat call (every waivers-view request, every
// claim submission) is a no-op for members that already have a row.
async function ensureLeagueWaiverState(env, leagueId, faabBudget) {
  const members = await env.DB.prepare(
    `SELECT user_id, draft_position FROM fantasy_league_members WHERE league_id = ?1 ORDER BY draft_position DESC`,
  )
    .bind(leagueId)
    .all();
  const rows = members.results ?? [];
  if (!rows.length) return;
  // draft_position DESC already puts the last drafter first; anyone somehow
  // missing a draft_position (should not happen post-draft) is appended last.
  const withPosition = rows.filter((row) => row.draft_position != null);
  const withoutPosition = rows.filter((row) => row.draft_position == null);
  const sequence = [...withPosition, ...withoutPosition];
  await env.DB.batch(
    sequence.map((row, index) =>
      env.DB.prepare(
        `INSERT OR IGNORE INTO fantasy_waiver_state (league_id, user_id, faab_remaining, priority) VALUES (?1, ?2, ?3, ?4)`,
      ).bind(leagueId, row.user_id, faabBudget, index + 1),
    ),
  );
}

async function fantasyPlayerLookup(env, playerId) {
  return env.DB.prepare(`SELECT id, name, team, position FROM fantasy_players WHERE id = ?1`).bind(playerId).first();
}

async function fantasyPlayerAvailability(env, leagueId, playerId) {
  const [ownedRow, wireRow] = await Promise.all([
    env.DB.prepare(`SELECT 1 AS x FROM fantasy_rosters WHERE league_id = ?1 AND player_id = ?2`)
      .bind(leagueId, playerId)
      .first(),
    env.DB.prepare(`SELECT 1 AS x FROM fantasy_waiver_wire WHERE league_id = ?1 AND player_id = ?2`)
      .bind(leagueId, playerId)
      .first(),
  ]);
  return playerAvailability({
    playerId,
    ownedIds: ownedRow ? [playerId] : [],
    wireIds: wireRow ? [playerId] : [],
  });
}

// GET /fantasy/league/:id/waivers: the whole waivers view in one call. The
// free-agent list is returned in full (like the draft pool already does) and
// filtered client-side rather than paginated server-side; ~500-600 players
// is not large enough to justify the complexity.
async function handleFantasyWaiversView(request, env, leagueId, cors) {
  if (!env.DB) return json({ error: "fantasy not configured" }, 501, cors);
  const user = await sessionUser(request, env);
  if (!user) return json({ error: "signed out" }, 401, cors);

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

    const settings = await waiverSettings(env, leagueId);
    await ensureLeagueWaiverState(env, leagueId, settings.faabBudget);

    const [currentGameweek, stateRows, ownedRows, wireRows, allPlayers, myClaimRows, lastRunRow] = await Promise.all([
      currentFantasyGameweek(env),
      env.DB.prepare(
        `SELECT s.user_id, s.faab_remaining, s.priority, u.name, u.email FROM fantasy_waiver_state s
         JOIN users u ON u.id = s.user_id WHERE s.league_id = ?1 ORDER BY s.priority`,
      )
        .bind(leagueId)
        .all(),
      env.DB.prepare(`SELECT player_id FROM fantasy_rosters WHERE league_id = ?1`).bind(leagueId).all(),
      env.DB.prepare(
        `SELECT w.player_id, w.clears_after_gameweek, pl.name, pl.team, pl.position FROM fantasy_waiver_wire w
         JOIN fantasy_players pl ON pl.id = w.player_id WHERE w.league_id = ?1 ORDER BY w.added_at`,
      )
        .bind(leagueId)
        .all(),
      env.DB.prepare(`SELECT id, name, team, position FROM fantasy_players WHERE active = 1`).all(),
      env.DB.prepare(
        `SELECT id, add_player_id, drop_player_id, bid, priority, status, reason, gameweek FROM fantasy_waivers
         WHERE league_id = ?1 AND user_id = ?2 ORDER BY id DESC LIMIT 50`,
      )
        .bind(leagueId, user.id)
        .all(),
      env.DB.prepare(
        `SELECT gameweek, processed_at FROM fantasy_waiver_runs WHERE league_id = ?1 ORDER BY gameweek DESC LIMIT 1`,
      )
        .bind(leagueId)
        .first(),
    ]);

    const ownedIds = new Set((ownedRows.results ?? []).map((row) => row.player_id));
    const wireIds = new Set((wireRows.results ?? []).map((row) => row.player_id));
    const freeAgents = (allPlayers.results ?? []).filter(
      (player) => !ownedIds.has(player.id) && !wireIds.has(player.id),
    );

    // Kickoff lock (src/fantasyLocks.js), computed over every active player so
    // the client can mark a free agent OR a roster player as locked without a
    // second round trip. A null match list (feed unavailable) means nothing
    // can be checked, so nothing is reported locked here either, matching the
    // instant-add route's own fail-open behavior rather than disagreeing with it.
    const matches = await currentFantasyMatches(env);
    const locked = matches ? lockedPlayerIds(allPlayers.results ?? [], matches, currentGameweek, Date.now()) : new Set();

    // The claim timetable, so the panel can state which run a claim submitted
    // right now would land in instead of leaving the manager to guess when the
    // gameweek turns over.
    const claimTarget = claimGameweek({ matches, currentGameweek, now: Date.now() });
    const currentWindow = waiverRunWindow({ matches, gameweek: currentGameweek, now: Date.now() });

    const mine = (stateRows.results ?? []).find((row) => row.user_id === user.id);

    let lastRun = null;
    if (lastRunRow) {
      const resultRows = await env.DB.prepare(
        `SELECT id, user_id, add_player_id, drop_player_id, bid, status, reason FROM fantasy_waivers
         WHERE league_id = ?1 AND gameweek = ?2 AND status != 'pending' ORDER BY id`,
      )
        .bind(leagueId, lastRunRow.gameweek)
        .all();
      lastRun = {
        gameweek: lastRunRow.gameweek,
        processedAt: lastRunRow.processed_at,
        results: (resultRows.results ?? []).map((row) => ({
          claimId: row.id,
          userId: row.user_id,
          status: row.status,
          reason: row.reason,
          addPlayerId: row.add_player_id,
          dropPlayerId: row.drop_player_id,
          bid: row.bid,
        })),
      };
    }

    return json(
      {
        mode: settings.mode,
        faabBudget: settings.faabBudget,
        myBudgetRemaining: mine?.faab_remaining ?? settings.faabBudget,
        myPriority: mine?.priority ?? null,
        currentGameweek,
        claimWindow: {
          gameweek: claimTarget.gameweek,
          deferred: claimTarget.deferred,
          phase: currentWindow.phase,
          quietFrom: currentWindow.quietFrom,
          runsAfter: claimTarget.runsAfter,
        },
        priorities: (stateRows.results ?? []).map((row) => ({
          userId: row.user_id,
          name: row.name || String(row.email ?? "").split("@")[0] || "Someone",
          priority: row.priority,
          budgetRemaining: row.faab_remaining,
        })),
        freeAgents,
        lockedPlayerIds: [...locked],
        wire: (wireRows.results ?? []).map((row) => ({
          player: { id: row.player_id, name: row.name, team: row.team, position: row.position },
          clearsAfterGameweek: row.clears_after_gameweek,
        })),
        myClaims: (myClaimRows.results ?? []).map((row) => ({
          claimId: row.id,
          addPlayerId: row.add_player_id,
          dropPlayerId: row.drop_player_id,
          bid: row.bid,
          priority: row.priority,
          status: row.status,
          reason: row.reason,
          gameweek: row.gameweek,
        })),
        lastRun,
      },
      200,
      cors,
    );
  } catch {
    return json({ error: "fantasy unavailable" }, 502, cors);
  }
}

// POST /fantasy/league/:id/waivers/claim: queues a claim against an
// ON_WAIVERS player. A free agent must use the instant /freeagents/add route
// instead; this route rejects an add target that isn't actually on the wire
// so the two acquisition paths can never be confused for each other.
async function handleFantasyWaiverClaimCreate(request, env, leagueId, cors) {
  if (!env.DB) return json({ error: "fantasy not configured" }, 501, cors);
  const user = await sessionUser(request, env);
  if (!user) return json({ error: "signed out" }, 401, cors);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad body" }, 400, cors);
  }
  const addPlayerId = Number(body?.addPlayerId);
  const dropPlayerId = Number(body?.dropPlayerId);
  const bid = body?.bid == null ? null : Number(body.bid);
  const requestedPriority = Number(body?.priority);
  if (!Number.isInteger(addPlayerId) || !Number.isInteger(dropPlayerId)) {
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

    const settings = await waiverSettings(env, leagueId);
    await ensureLeagueWaiverState(env, leagueId, settings.faabBudget);

    const [roster, addPlayer, dropPlayer, availability, stateRow] = await Promise.all([
      fantasyRosterFor(env, leagueId, user.id),
      fantasyPlayerLookup(env, addPlayerId),
      fantasyPlayerLookup(env, dropPlayerId),
      fantasyPlayerAvailability(env, leagueId, addPlayerId),
      env.DB.prepare(`SELECT faab_remaining FROM fantasy_waiver_state WHERE league_id = ?1 AND user_id = ?2`)
        .bind(leagueId, user.id)
        .first(),
    ]);
    if (!addPlayer) return json({ error: "unknown player" }, 404, cors);

    const validation = validateAcquisition({
      addPlayer,
      dropPlayer,
      roster,
      availability,
      path: "waiver",
      mode: settings.mode,
      bid,
      budgetRemaining: stateRow?.faab_remaining ?? settings.faabBudget,
    });
    if (!validation.ok) return json({ error: validation.error }, 400, cors);

    const currentGameweek = await currentFantasyGameweek(env);
    // Which run this claim belongs to. Inside the quiet period before a run
    // (src/fantasyWaivers.js) the answer is the NEXT gameweek, and `deferred`
    // is returned to the client so the manager is told which run their claim
    // is in rather than being silently included, silently excluded, or
    // rejected outright for being a minute late.
    const matches = await currentFantasyMatches(env);
    const target = claimGameweek({ matches, currentGameweek, now: Date.now() });
    // priority here is the claimant's OWN ranking among their own pending
    // claims (fantasy_waivers.priority, repurposed for exactly this, distinct
    // from the league-wide waiver order in fantasy_waiver_state). A caller
    // that doesn't send one is appended after every existing pending claim of
    // theirs, so it is tried last by default rather than colliding on 1.
    let ownClaimPriority = Number.isInteger(requestedPriority) ? requestedPriority : null;
    if (ownClaimPriority == null) {
      const pendingCount = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM fantasy_waivers WHERE league_id = ?1 AND user_id = ?2 AND status = 'pending'`,
      )
        .bind(leagueId, user.id)
        .first();
      ownClaimPriority = (pendingCount?.n ?? 0) + 1;
    }

    const insert = (gameweek) =>
      env.DB.prepare(
        // Guarded on that gameweek's run not having committed yet, the same
        // INSERT...SELECT...WHERE NOT EXISTS pattern the free-agent path uses
        // for the roster slot. The quiet period already keeps a claim well
        // clear of its run, but only a write-time guard can rule out the last
        // interleaving: this route reading the timetable, the run committing,
        // and only then this INSERT landing on a gameweek nobody will ever
        // look at again.
        `INSERT INTO fantasy_waivers (league_id, user_id, add_player_id, drop_player_id, priority, gameweek, bid)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
         WHERE NOT EXISTS (SELECT 1 FROM fantasy_waiver_runs WHERE league_id = ?1 AND gameweek = ?6)`,
      )
        .bind(
          leagueId,
          user.id,
          addPlayerId,
          dropPlayerId,
          ownClaimPriority,
          gameweek,
          settings.mode === "faab" ? bid ?? 0 : null,
        )
        .run();

    let gameweek = target.gameweek;
    let deferred = target.deferred;
    let result = await insert(gameweek);
    if ((result.meta?.changes ?? 0) === 0) {
      // That gameweek's run committed underneath us. One retry is enough: runs
      // are strictly sequential per league, so the next gameweek's run cannot
      // also have happened already.
      gameweek += 1;
      deferred = true;
      result = await insert(gameweek);
      if ((result.meta?.changes ?? 0) === 0) {
        return json({ error: "waivers are processing right now, please try again in a moment" }, 409, cors);
      }
    }

    const window = waiverRunWindow({ matches, gameweek, now: Date.now() });
    return json(
      { claimId: result.meta.last_row_id, gameweek, deferred, runsAfter: window.earliestRunAt, status: "pending" },
      200,
      cors,
    );
  } catch {
    return json({ error: "fantasy unavailable" }, 502, cors);
  }
}

// DELETE /fantasy/league/:id/waivers/claim/:claimId: cancel one's own
// still-pending claim. A claim already resolved by a run cannot be undone.
async function handleFantasyWaiverClaimCancel(request, env, leagueId, claimId, cors) {
  if (!env.DB) return json({ error: "fantasy not configured" }, 501, cors);
  const user = await sessionUser(request, env);
  if (!user) return json({ error: "signed out" }, 401, cors);

  try {
    const league = await env.DB.prepare(`SELECT draft_status FROM fantasy_leagues WHERE id = ?1`)
      .bind(leagueId)
      .first();
    if (!league) return json({ error: "unknown league" }, 404, cors);
    if (league.draft_status !== "complete") return json({ error: "draft not complete" }, 400, cors);

    const claim = await env.DB.prepare(
      `SELECT id, user_id, status FROM fantasy_waivers WHERE id = ?1 AND league_id = ?2`,
    )
      .bind(claimId, leagueId)
      .first();
    if (!claim) return json({ error: "unknown claim" }, 404, cors);
    if (claim.user_id !== user.id) return json({ error: "not your claim" }, 403, cors);
    if (claim.status !== "pending") return json({ error: "claim already resolved" }, 400, cors);

    await env.DB.prepare(`DELETE FROM fantasy_waivers WHERE id = ?1`).bind(claimId).run();
    return json({ ok: true }, 200, cors);
  } catch {
    return json({ error: "fantasy unavailable" }, 502, cors);
  }
}

// POST /fantasy/league/:id/freeagents/add: the instant path. Validates and
// atomically swaps a FREE_AGENT onto the caller's roster for a same-position
// drop, and puts the dropped player on the wire (never instantly re-addable,
// which is what stops a drop-and-instantly-re-add cycle from dodging the
// waiver queue). Rejects an add target that is owned or already on the wire;
// those go through a waiver claim instead.
async function handleFantasyFreeAgentAdd(request, env, leagueId, cors) {
  if (!env.DB) return json({ error: "fantasy not configured" }, 501, cors);
  const user = await sessionUser(request, env);
  if (!user) return json({ error: "signed out" }, 401, cors);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad body" }, 400, cors);
  }
  const addPlayerId = Number(body?.addPlayerId);
  const dropPlayerId = Number(body?.dropPlayerId);
  if (!Number.isInteger(addPlayerId) || !Number.isInteger(dropPlayerId)) {
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

    const [roster, addPlayer, dropPlayer, availability] = await Promise.all([
      fantasyRosterFor(env, leagueId, user.id),
      fantasyPlayerLookup(env, addPlayerId),
      fantasyPlayerLookup(env, dropPlayerId),
      fantasyPlayerAvailability(env, leagueId, addPlayerId),
    ]);
    if (!addPlayer) return json({ error: "unknown player" }, 404, cors);

    const validation = validateAcquisition({ addPlayer, dropPlayer, roster, availability, path: "free_agent" });
    if (!validation.ok) return json({ error: validation.error }, 400, cors);

    const gameweek = await currentFantasyGameweek(env);

    // Kickoff lock (see src/fantasyLocks.js): reject the swap if EITHER side's
    // club has already kicked off this gameweek, closing the exploit where an
    // instant add/drop could bank (or dodge) points that have already been
    // decided. Only the instant path needs this - a queued waiver claim
    // resolves at the gameweek boundary, by which point every match in the
    // settling gameweek is already terminal by construction, so the same
    // check there would reject every processed claim (see runLeagueWaiverRun
    // and CLAUDE.md). If the live feed is unavailable (no API key locally,
    // upstream down), currentFantasyMatches returns null and this fails OPEN,
    // allowing the move: freezing every free-agent transaction league-wide on
    // a feed blip is worse than the rare window where a manager could exploit
    // that specific outage, and a genuine feed error is never swallowed
    // silently, it is a deliberate null the lock check treats as "nothing to
    // check against" (see currentFantasyMatches's own comment).
    const matches = await currentFantasyMatches(env);
    if (matches) {
      const addLock = playerLockState({ team: addPlayer.team, matches, gameweek, now: Date.now() });
      if (addLock.locked) {
        return json(
          { error: `${addPlayer.name} is locked: ${addPlayer.team} have already kicked off this gameweek` },
          400,
          cors,
        );
      }
      const dropLock = playerLockState({ team: dropPlayer.team, matches, gameweek, now: Date.now() });
      if (dropLock.locked) {
        return json(
          { error: `${dropPlayer.name} is locked: ${dropPlayer.team} have already kicked off this gameweek` },
          400,
          cors,
        );
      }
    }

    // Guarded on the add player still being unowned/unwired at write time:
    // two managers racing the same free agent can both pass the read-time
    // check above, but only one INSERT...SELECT...WHERE can win the roster
    // slot, the same defense-in-depth pattern the league-join route uses.
    const insert = await env.DB.prepare(
      `INSERT INTO fantasy_rosters (league_id, user_id, player_id, acquired_via)
       SELECT ?1, ?2, ?3, 'free_agent'
       WHERE NOT EXISTS (SELECT 1 FROM fantasy_rosters WHERE league_id = ?1 AND player_id = ?3)
         AND NOT EXISTS (SELECT 1 FROM fantasy_waiver_wire WHERE league_id = ?1 AND player_id = ?3)`,
    )
      .bind(leagueId, user.id, addPlayerId)
      .run();
    if ((insert.meta?.changes ?? 0) === 0) return json({ error: "Player is not a free agent" }, 400, cors);

    await env.DB.batch([
      env.DB.prepare(`DELETE FROM fantasy_rosters WHERE league_id = ?1 AND user_id = ?2 AND player_id = ?3`).bind(
        leagueId,
        user.id,
        dropPlayerId,
      ),
      env.DB.prepare(
        `INSERT INTO fantasy_waiver_wire (league_id, player_id, clears_after_gameweek) VALUES (?1, ?2, ?3)
         ON CONFLICT(league_id, player_id) DO UPDATE SET added_at = datetime('now'), clears_after_gameweek = ?3`,
      ).bind(leagueId, dropPlayerId, gameweek),
    ]);

    await postLeagueEvent(env, leagueId, CHAT_EVENTS.FREE_AGENT_ADD, {
      actor: memberDisplayName(user),
      added: addPlayer.name,
      dropped: dropPlayer?.name ?? null,
      gameweek,
    });

    return json({ ok: true, roster: await fantasyRosterFor(env, leagueId, user.id) }, 200, cors);
  } catch {
    return json({ error: "fantasy unavailable" }, 502, cors);
  }
}

// POST /fantasy/league/:id/waivers/settings: commissioner only. Rejects a
// settings change while ANY claim is pending anywhere for the league,
// regardless of which gameweek it is tagged with: a claim is tagged with the
// gameweek it was submitted during, and in the window after that gameweek
// settles but before the cron's run actually fires, its claims are real and
// pending but no longer under the now-current gameweek number. Scoping this
// check to currentGameweek would miss exactly that window and let a mode
// change slip through onto claims it exists to protect.
async function handleFantasyWaiverSettings(request, env, leagueId, cors) {
  if (!env.DB) return json({ error: "fantasy not configured" }, 501, cors);
  const user = await sessionUser(request, env);
  if (!user) return json({ error: "signed out" }, 401, cors);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad body" }, 400, cors);
  }
  const mode = String(body?.mode ?? "");
  const faabBudget = Number(body?.faabBudget);
  if (!WAIVER_MODES.includes(mode)) return json({ error: "bad mode" }, 400, cors);
  if (!Number.isInteger(faabBudget) || faabBudget < 0) return json({ error: "bad faab budget" }, 400, cors);

  try {
    const league = await env.DB.prepare(
      `SELECT draft_status, commissioner_user_id FROM fantasy_leagues WHERE id = ?1`,
    )
      .bind(leagueId)
      .first();
    if (!league) return json({ error: "unknown league" }, 404, cors);
    if (league.commissioner_user_id !== user.id) return json({ error: "commissioner only" }, 403, cors);
    if (league.draft_status !== "complete") return json({ error: "draft not complete" }, 400, cors);

    const pending = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM fantasy_waivers WHERE league_id = ?1 AND status = 'pending'`,
    )
      .bind(leagueId)
      .first();
    if ((pending?.n ?? 0) > 0) {
      return json({ error: "cannot change waiver settings while any claims are pending" }, 400, cors);
    }

    await env.DB.prepare(
      `INSERT INTO fantasy_waiver_settings (league_id, mode, faab_budget, updated_at) VALUES (?1, ?2, ?3, datetime('now'))
       ON CONFLICT(league_id) DO UPDATE SET mode = ?2, faab_budget = ?3, updated_at = datetime('now')`,
    )
      .bind(leagueId, mode, faabBudget)
      .run();

    return json({ mode, faabBudget }, 200, cors);
  } catch {
    return json({ error: "fantasy unavailable" }, 502, cors);
  }
}

// Runs once per league per gameweek boundary, a separate pass from gameweek
// scoring rather than folded into it: this operates per LEAGUE (not per PL
// match), needs a completely different working state (rosters/budgets/
// priorities rather than player scores), and has its own idempotency gate
// (fantasy_waiver_runs' unique index) rather than the scoring pass' match
// dedup ledger. A distinct top-level function mirrors how analysis and
// notifications are already separate passes despite all three sharing
// getLive(); folding this into runScheduledFantasyScoring would tangle two
// unrelated failure/retry stories together.
async function runScheduledWaiverRuns(env) {
  if (!env.DB || !env.API_FOOTBALL_KEY) return;
  const currentGameweek = await currentFantasyGameweek(env);
  const settledGameweek = currentGameweek - 1;
  if (settledGameweek < 1) return; // nothing has settled yet this season

  // The settlement buffer (src/fantasyWaivers.js). The gameweek being settled
  // is already terminal by the time we get here, but "terminal" and "safe to
  // resolve" are not the same instant: claims stop counting towards this run
  // an hour before its last kickoff, and the run waits three hours past that
  // kickoff before reading the claim set, so there is a guaranteed multi-hour
  // gap rather than a millisecond race between the last claim and the run.
  // A feed we cannot read leaves the buffer undecidable, in which case
  // waiverRunReady fails open to the pre-buffer behaviour.
  const matches = await currentFantasyMatches(env);
  if (!waiverRunReady({ matches, settledGameweek, now: Date.now() })) return;

  const leagues = await env.DB.prepare(`SELECT id FROM fantasy_leagues WHERE draft_status = 'complete'`).all();
  for (const league of leagues.results ?? []) {
    try {
      await runLeagueWaiverRun(env, league.id, settledGameweek, currentGameweek);
    } catch {
      // one league's run failing must not block the others; the unique index
      // below means a partially-failed attempt is simply retried whole on
      // the next tick rather than half-applied
    }
  }
}

// How long a waiver-run lease is held before another tick may break it. Long
// enough that a genuinely slow run is never interrupted, short enough that a
// tick killed mid-run does not wedge a league's waivers until someone notices.
// Nothing about correctness depends on this number (see the schema comment on
// fantasy_waiver_locks): it only decides how much duplicated work happens.
const WAIVER_LOCK_LEASE_MS = 5 * 60 * 1000;

// Single guarded upsert, so exactly one of two racing ticks comes away with
// the lease: SQLite applies the ON CONFLICT ... WHERE atomically, and the
// loser's statement reports zero changes rather than overwriting the holder.
async function acquireWaiverLock(env, leagueId, gameweek) {
  const holder = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + WAIVER_LOCK_LEASE_MS).toISOString();
  const result = await env.DB.prepare(
    `INSERT INTO fantasy_waiver_locks (league_id, gameweek, holder, acquired_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(league_id) DO UPDATE SET gameweek = ?2, holder = ?3, acquired_at = ?4, expires_at = ?5
     WHERE fantasy_waiver_locks.expires_at <= ?4`,
  )
    .bind(leagueId, gameweek, holder, now.toISOString(), expiresAt)
    .run();
  return (result.meta?.changes ?? 0) > 0 ? holder : null;
}

// Every write this run makes, the fantasy_waiver_runs marker included, is
// issued as ONE env.DB.batch() call at the end of this function: D1 executes
// a batch's statements inside a single transaction, so the marker and every
// effect it implies (claim status, roster changes, the wire, budgets,
// priorities) commit together or not at all. This is what makes the run
// genuinely retryable: a failure partway through this function used to be
// impossible because the marker write happened up front, before any other
// write, as its own standalone statement; a crash between that insert and
// the rest of the work would permanently mark the gameweek processed while
// claims sat pending forever with zero state actually changed, and the next
// tick never looks at an already-settled gameweek again, so the run was
// silently lost. Folding the marker into the same atomic batch as
// everything else means a mid-run failure (a genuine D1 error, or the
// unique index rejecting a losing race against another overlapping tick)
// rolls back the ENTIRE batch, marker included, leaving the run exactly as
// unprocessed as before this function ran and free to be retried whole.
//
// What the atomic batch alone did NOT close, and what the trailing
// roll-forward statement below now does: a claim inserted after this
// function's SELECT but before its batch commits is invisible to the run, yet
// still tagged with the gameweek the run is closing. The marker then exists,
// so no later tick ever looks at that gameweek again, and the claim sat
// pending forever - never resolved, never rejected, and blocking the
// commissioner's own waiver-settings route, which refuses to change anything
// while any claim is pending. Rolling every still-pending claim for the
// settled gameweek onto the next one, inside the same transaction, means such
// a claim is deferred rather than orphaned. It is written last so it can only
// ever catch claims this run did not itself resolve (the earlier statements
// have already moved those out of 'pending').
async function runLeagueWaiverRun(env, leagueId, settledGameweek, newCurrentGameweek) {
  // Cheap read-only pre-check, NOT the correctness guard: avoids redoing all
  // the work below on every subsequent cron tick once a gameweek's run has
  // already committed. Two overlapping ticks could both pass this (it is
  // not exclusive), but that only means both build a batch; only one can
  // actually commit the marker, and the unique index fails the other one's
  // entire batch atomically, so nothing double-applies.
  const already = await env.DB.prepare(
    `SELECT 1 AS x FROM fantasy_waiver_runs WHERE league_id = ?1 AND gameweek = ?2`,
  )
    .bind(leagueId, settledGameweek)
    .first();
  if (already) return;

  // Advisory lease on top of that pre-check: the cron fires every minute and a
  // slow run is still in flight when the next tick arrives, so without this
  // both ticks would refetch everything and build a full batch just for one to
  // be rejected. Losing the race is a no-op, not an error, and the lease can
  // only ever cost duplicated work if it expires early (see the schema comment
  // on fantasy_waiver_locks for why correctness never rests on it).
  const holder = await acquireWaiverLock(env, leagueId, settledGameweek);
  if (!holder) return;
  let committed = false;
  try {
    committed = await executeLeagueWaiverRun(env, leagueId, settledGameweek, newCurrentGameweek, holder);
  } finally {
    // The committing batch releases the lease itself, atomically with the run.
    // This only covers the paths that never got that far (an exception, or a
    // batch that rolled back), and is guarded on `holder` so a tick can never
    // release a lease that has since been broken and retaken by another.
    if (!committed) {
      try {
        await env.DB.prepare(`DELETE FROM fantasy_waiver_locks WHERE league_id = ?1 AND holder = ?2`)
          .bind(leagueId, holder)
          .run();
      } catch {
        // the lease expiry is the backstop; a failed release just delays the
        // next attempt by at most WAIVER_LOCK_LEASE_MS
      }
    }
  }
}

// Returns true only if the run's batch actually committed, which is what tells
// the caller whether the lease still needs releasing.
async function executeLeagueWaiverRun(env, leagueId, settledGameweek, newCurrentGameweek, lockHolder) {
  const settings = await waiverSettings(env, leagueId);
  await ensureLeagueWaiverState(env, leagueId, settings.faabBudget);

  const pendingClaims = await env.DB.prepare(
    `SELECT id, user_id, add_player_id, drop_player_id, bid, priority FROM fantasy_waivers
     WHERE league_id = ?1 AND gameweek = ?2 AND status = 'pending'`,
  )
    .bind(leagueId, settledGameweek)
    .all();
  const claims = (pendingClaims.results ?? []).map((row) => ({
    claimId: row.id,
    userId: row.user_id,
    addPlayerId: row.add_player_id,
    dropPlayerId: row.drop_player_id,
    bid: row.bid,
    priority: row.priority,
  }));

  // The marker insert is the FIRST statement in the batch built below (see
  // this function's header comment): every other write in this run rides
  // its transaction. The wire clear comes right after it and before any of
  // this run's own drops are queued, or a fresh drop would be cleared by
  // the very run that created it (batch() runs statements in array order).
  const writes = [
    env.DB.prepare(`INSERT INTO fantasy_waiver_runs (league_id, gameweek) VALUES (?1, ?2)`).bind(
      leagueId,
      settledGameweek,
    ),
    env.DB.prepare(`DELETE FROM fantasy_waiver_wire WHERE league_id = ?1 AND clears_after_gameweek <= ?2`).bind(
      leagueId,
      settledGameweek,
    ),
  ];

  if (claims.length) {
    const playerIds = [...new Set(claims.flatMap((claim) => [claim.addPlayerId, claim.dropPlayerId]))];
    const [rosterRows, stateRows, playerRows] = await Promise.all([
      env.DB.prepare(`SELECT user_id, player_id FROM fantasy_rosters WHERE league_id = ?1`).bind(leagueId).all(),
      env.DB.prepare(`SELECT user_id, faab_remaining, priority FROM fantasy_waiver_state WHERE league_id = ?1`)
        .bind(leagueId)
        .all(),
      // `name` is only for the league feed's announcement below; the run
      // itself decides nothing from it.
      env.DB.prepare(
        `SELECT id, position, name FROM fantasy_players WHERE id IN (${playerIds.map((_, i) => `?${i + 1}`).join(",")})`,
      )
        .bind(...playerIds)
        .all(),
    ]);

    // Only the reverse index is needed: every check resolveWaiverRun
    // performs is "who owns this player id", never "what does this
    // manager's full roster look like".
    const ownedBy = new Map((rosterRows.results ?? []).map((row) => [row.player_id, row.user_id]));
    const budgets = new Map((stateRows.results ?? []).map((row) => [row.user_id, row.faab_remaining]));
    const priorities = (stateRows.results ?? []).map((row) => ({ userId: row.user_id, priority: row.priority }));
    const players = new Map(
      (playerRows.results ?? []).map((row) => [row.id, { position: row.position, name: row.name }]),
    );

    // reverse_standings orders the whole run worst-record-first, and faab uses
    // the same table purely to break ties between equal bids, so both need it
    // computed fresh. Only rolling ignores it, running off the stored queue.
    let standings = [];
    if (settings.mode === "reverse_standings" || settings.mode === "faab") {
      const [membersRows, fixtureRows] = await Promise.all([
        env.DB.prepare(
          `SELECT m.user_id, u.name, u.email FROM fantasy_league_members m
           JOIN users u ON u.id = m.user_id WHERE m.league_id = ?1`,
        )
          .bind(leagueId)
          .all(),
        env.DB.prepare(
          `SELECT gameweek, home_user_id, away_user_id, home_score, away_score
           FROM fantasy_h2h_fixtures WHERE league_id = ?1 AND gameweek <= ?2`,
        )
          .bind(leagueId, settledGameweek)
          .all(),
      ]);
      const members = (membersRows.results ?? []).map((row) => ({
        userId: row.user_id,
        name: row.name || String(row.email ?? "").split("@")[0] || "Someone",
      }));
      const fixtures = (fixtureRows.results ?? []).map((row) => ({
        gameweek: row.gameweek,
        homeUserId: row.home_user_id,
        awayUserId: row.away_user_id,
        homeScore: row.home_score,
        awayScore: row.away_score,
      }));
      standings = standingsFromFixtures(fixtures, members);
    }

    const run = resolveWaiverRun({
      claims,
      mode: settings.mode,
      ownedBy,
      budgets,
      priorities,
      standings,
      players,
    });

    for (const result of run.results) {
      writes.push(
        env.DB.prepare(
          `UPDATE fantasy_waivers SET status = ?1, reason = ?2, processed_at = datetime('now') WHERE id = ?3`,
        ).bind(result.status, result.reason, result.claimId),
      );
    }
    for (const change of run.rosterChanges) {
      writes.push(
        env.DB.prepare(`DELETE FROM fantasy_rosters WHERE league_id = ?1 AND user_id = ?2 AND player_id = ?3`).bind(
          leagueId,
          change.userId,
          change.dropPlayerId,
        ),
      );
      writes.push(
        env.DB.prepare(
          `INSERT INTO fantasy_rosters (league_id, user_id, player_id, acquired_via) VALUES (?1, ?2, ?3, 'waiver')
           ON CONFLICT(league_id, user_id, player_id) DO NOTHING`,
        ).bind(leagueId, change.userId, change.addPlayerId),
      );
    }
    // Tagged with newCurrentGameweek (the gameweek about to play out), so
    // these fresh drops survive on the wire until the NEXT run clears them.
    for (const playerId of run.wireAdds) {
      writes.push(
        env.DB.prepare(
          `INSERT INTO fantasy_waiver_wire (league_id, player_id, clears_after_gameweek) VALUES (?1, ?2, ?3)
           ON CONFLICT(league_id, player_id) DO UPDATE SET added_at = datetime('now'), clears_after_gameweek = ?3`,
        ).bind(leagueId, playerId, newCurrentGameweek),
      );
    }
    if (settings.mode === "faab") {
      for (const entry of run.budgets) {
        writes.push(
          env.DB.prepare(
            `UPDATE fantasy_waiver_state SET faab_remaining = ?1 WHERE league_id = ?2 AND user_id = ?3`,
          ).bind(entry.remaining, leagueId, entry.userId),
        );
      }
    }
    if (settings.mode === "rolling") {
      for (const entry of run.priorities) {
        writes.push(
          env.DB.prepare(`UPDATE fantasy_waiver_state SET priority = ?1 WHERE league_id = ?2 AND user_id = ?3`).bind(
            entry.priority,
            leagueId,
            entry.userId,
          ),
        );
      }
    }

    // The league feed's announcement rides the SAME batch as the run itself,
    // so it commits with the moves or not at all. A feed claiming a player was
    // won by a run that then rolled back would be worse than silence, and this
    // is the moment leagues actually talk to each other: waivers clear, then
    // everyone argues about who got what.
    //
    // Built from run.results rather than run.rosterChanges because only the
    // results carry the winning bid, which is the number a faab league cares
    // about most.
    const processed = run.results.filter((result) => result.status === "processed");
    const winnerNames = await waiverWinnerNames(env, processed);
    writes.push(
      leagueEventStatement(env, leagueId, CHAT_EVENTS.WAIVER_RUN, {
        gameweek: settledGameweek,
        mode: settings.mode,
        moves: processed.map((result) => ({
          actor: winnerNames.get(result.userId) ?? "Someone",
          added: players.get(result.addPlayerId)?.name ?? null,
          dropped: players.get(result.dropPlayerId)?.name ?? null,
          // Only faab has a meaningful bid; in the other modes it would print
          // as "for null", so they carry none at all.
          bid: settings.mode === "faab" ? (result.bid ?? null) : null,
        })),
        rejected: run.results.length - processed.length,
      }),
    );
  }

  // Last two statements, and both have to be last. The roll-forward catches
  // any claim that landed between this function's SELECT and this batch (see
  // the header comment): by now every claim the run DID resolve has already
  // been moved out of 'pending' by the statements above, so this can only
  // touch ones the run never saw, and it defers them to the next run instead
  // of leaving them orphaned. The lease release then rides the same
  // transaction as the marker, so the lock is given up exactly when the run
  // becomes visible, never before.
  writes.push(
    env.DB.prepare(
      `UPDATE fantasy_waivers SET gameweek = ?3 WHERE league_id = ?1 AND gameweek = ?2 AND status = 'pending'`,
    ).bind(leagueId, settledGameweek, newCurrentGameweek),
  );
  writes.push(
    env.DB.prepare(`DELETE FROM fantasy_waiver_locks WHERE league_id = ?1 AND holder = ?2`).bind(leagueId, lockHolder),
  );

  try {
    // One batch, not chunked: chunking would split this across multiple
    // transactions and reopen exactly the bug this function exists to
    // close. A league's claim volume (MAX_LEAGUE_SIZE managers, a handful
    // of claims each) is nowhere near D1's practical batch limits.
    await env.DB.batch(writes);
    return true;
  } catch {
    // Marker conflict (another tick already committed this run) or a
    // genuine D1 error: either way nothing in this batch was committed, so
    // the run is left exactly as unprocessed as before and the next tick
    // retries it from scratch.
    return false;
  }
}

// Display names for the managers who won something in a run, for the feed
// announcement only. Bounded by MAX_LEAGUE_SIZE (a manager appears once
// however many claims they won), so the IN clause stays far below D1's
// 100-bound-parameter cap without chunking.
async function waiverWinnerNames(env, processedResults) {
  const userIds = [...new Set((processedResults ?? []).map((result) => result.userId))];
  if (!userIds.length) return new Map();
  const rows = await env.DB.prepare(
    `SELECT id, name, email FROM users WHERE id IN (${userIds.map((_, i) => `?${i + 1}`).join(",")})`,
  )
    .bind(...userIds)
    .all();
  return new Map((rows.results ?? []).map((row) => [row.id, memberDisplayName(row)]));
}

// -- Fantasy draft scheduling and reminders -----------------------------------
// A commissioner can schedule a still-pending league's draft for a future UTC
// instant (fantasy_draft_schedule; see schema.sql). This pass fires three
// one-time pushes per league (24h before, 1h before, at the instant itself)
// and auto-starts the draft at that instant through startFantasyDraft, the
// exact same helper the manual /draft/start route uses above, so the two
// paths can never drift apart. dueDraftReminder (src/fantasyScheduling.js) is
// the pure decision of which reminder (if any) is due right now; this
// function is just the D1/push wiring around it, mirroring how
// runScheduledWaiverRuns is a thin shell around resolveWaiverRun.
//
// Sequential with the other cron passes and per-league try/catch, same
// convention as runScheduledFantasyScoring/runScheduledWaiverRuns: one bad
// league's schedule must never block the rest, and this pass shares no
// working state with the others (it does not even need the live feed).
async function runScheduledDraftReminders(env) {
  if (!env.DB) return;
  const schedules = await env.DB.prepare(
    `SELECT s.league_id, s.scheduled_at, l.commissioner_user_id FROM fantasy_draft_schedule s
     JOIN fantasy_leagues l ON l.id = s.league_id
     WHERE l.draft_status = 'pending'`,
  ).all();
  const now = Date.now();
  for (const row of schedules.results ?? []) {
    try {
      await processLeagueDraftSchedule(env, row, now);
    } catch {
      // one league's schedule failing must not block the others; the next
      // tick retries it (dueDraftReminder is re-evaluated fresh every time,
      // nothing here is left half-applied)
    }
  }
}

async function processLeagueDraftSchedule(env, row, now) {
  const sentRows = await env.DB.prepare(`SELECT kind FROM fantasy_draft_reminders WHERE league_id = ?1`)
    .bind(row.league_id)
    .all();
  const sentKinds = new Set((sentRows.results ?? []).map((r) => r.kind));

  const due = dueDraftReminder({ scheduledAt: row.scheduled_at, now, sentKinds });
  if (!due) return;

  if (due === "start") {
    await autoStartOrNotifyLeague(env, row);
  } else {
    await sendDraftReminderPush(env, row.league_id, due);
  }

  // Marked sent AFTER the work above, the same "check, act, then mark"
  // discipline the analysis pass uses for its own one-time "analysis ready"
  // push (see analyseCompetition's analysis:notified key): an overlapping
  // cron tick racing this one to the same row is a duplicate push at worst,
  // never a crash, and nothing here touches roster/money state the way the
  // waiver run's stricter insert-first transaction has to protect.
  await env.DB.prepare(`INSERT OR IGNORE INTO fantasy_draft_reminders (league_id, kind) VALUES (?1, ?2)`)
    .bind(row.league_id, due)
    .run();
}

// "start" is due: either actually start the draft, or - if it safely cannot -
// tell the commissioner why instead of silently doing nothing. Guarded on
// BOTH the league still being pending (a manual early start between this
// pass's read and this point would otherwise double-start it) and at least 2
// members (an empty or single-manager league cannot snake-draft at all).
async function autoStartOrNotifyLeague(env, row) {
  const leagueId = row.league_id;

  const league = await env.DB.prepare(`SELECT draft_status FROM fantasy_leagues WHERE id = ?1`).bind(leagueId).first();
  if (!league || league.draft_status !== "pending") return; // already started manually; nothing to do

  if (!env.DRAFT_ROOM) {
    await sendLeaguePush(env, [row.commissioner_user_id], {
      leagueId,
      tag: "cannot-start",
      title: "Draft could not start automatically",
      body: "The draft room isn't available on this deployment yet. Start the draft manually once it is.",
    });
    return;
  }

  const members = await env.DB.prepare(`SELECT user_id FROM fantasy_league_members WHERE league_id = ?1`)
    .bind(leagueId)
    .all();
  const memberIds = (members.results ?? []).map((r) => r.user_id);

  if (memberIds.length < 2) {
    await sendLeaguePush(env, [row.commissioner_user_id], {
      leagueId,
      tag: "cannot-start",
      title: "Draft could not start automatically",
      body: "Your league needs at least 2 managers before the draft can start. Invite more, then start it manually.",
    });
    return;
  }

  await startFantasyDraft(env, leagueId, memberIds);
  await sendLeaguePush(env, memberIds, {
    leagueId,
    tag: "start",
    title: "Your draft is starting now",
    body: "Head to the draft room, picks are on the clock.",
  });
}

async function sendDraftReminderPush(env, leagueId, kind) {
  const members = await env.DB.prepare(`SELECT user_id FROM fantasy_league_members WHERE league_id = ?1`)
    .bind(leagueId)
    .all();
  const memberIds = (members.results ?? []).map((r) => r.user_id);
  const copy =
    kind === "24h"
      ? { title: "Your draft is tomorrow", body: "Your fantasy draft kicks off in about 24 hours. Get your shortlist ready." }
      : { title: "Your draft starts in an hour", body: "The draft room opens in about an hour. Don't miss your picks." };
  await sendLeaguePush(env, memberIds, { ...copy, leagueId, tag: kind });
}

// League-scoped push send: targets league members directly by user id (unlike
// sendMatchEvents, which targets the follows table), gated on each recipient's
// own preference the same way sendMatchEvents gates on its own pref keys. The
// league-scoped keys ("draft", "recap") default to true since joining a league
// is itself an active opt-in, unlike a followed club's optional match alerts.
//
// MAX_LEAGUE_SIZE caps memberIds well under D1's 100-bound-parameter limit, so
// the IN clause below needs no chunking (see fantasyScoredMatchIds for the
// case that does).
async function sendLeaguePush(env, memberIds, { title, body, leagueId, tag, pref = "draft" }) {
  if (!pushConfigured(env) || !memberIds?.length) return;
  const placeholders = memberIds.map((_, i) => `?${i + 1}`).join(",");
  const subs = await env.DB.prepare(
    `SELECT s.endpoint, s.p256dh, s.auth, u.prefs FROM push_subscriptions s
     JOIN users u ON u.id = s.user_id
     WHERE s.user_id IN (${placeholders})`,
  )
    .bind(...memberIds)
    .all();
  const recipients = (subs.results ?? []).filter((sub) => {
    const prefs = safePrefs(sub.prefs);
    return prefs[pref] ?? DEFAULT_PREFS[pref] ?? false;
  });
  if (!recipients.length) return;
  const payload = {
    title,
    body,
    // No per-league deep link exists yet (the Fantasy section has no
    // league-id route parameter to land on); the section itself is still a
    // useful landing spot, since a signed-in manager only has their own
    // leagues to open from there.
    url: `${env.SITE_ORIGIN ?? ""}/#fantasy`,
    tag: `league-${leagueId}-${tag}`,
  };
  await Promise.all(recipients.map((sub) => sendPush(env, sub, payload)));
}

// -- AI weekly league recap (Phase 4.6) ---------------------------------------
//
// One Claude-written recap per league per settled gameweek, posted into that
// league's feed as a system message and pushed to its managers. Cron-generated
// only, never on a user visit, the same hard rule as the match analysis pass:
// a browser can reach the stored recap through the feed and can never reach an
// Anthropic call.
//
// EVERY NUMBER IS OURS. src/fantasyRecap.js computes the rankings, the awards,
// the matchup results and the movement from real D1 rows;
// src/fantasyRecapPrompt.js hands them to the model as data and takes back
// prose alone, then mergeRecap joins that prose onto our own numbers. Users of
// competing products say plainly that they forgive a bland AI recap and do not
// forgive a confidently wrong one, so the model is structurally unable to
// author a figure here: its schema has no numeric field at all.
//
// Cost: exactly one model call per league per gameweek. The ledger check below
// is the first thing that happens, so a minute-by-minute cron that finds
// nothing new spends one cheap D1 read per complete-draft league and nothing
// else.

async function runScheduledLeagueRecaps(env) {
  if (!env.DB || !env.ANTHROPIC_API_KEY) return;

  const currentGameweek = await currentFantasyGameweek(env);
  const settledGameweek = currentGameweek - 1;
  if (settledGameweek < 1) return; // nothing has settled yet this season

  const leagues = await env.DB.prepare(
    `SELECT id, name FROM fantasy_leagues WHERE draft_status = 'complete'`,
  ).all();
  for (const league of leagues.results ?? []) {
    try {
      await generateLeagueRecap(env, league, settledGameweek);
    } catch (error) {
      // One league's recap failing must not block the others, and a recap is
      // never load-bearing: the next tick retries from the ledger check, which
      // is still unmarked.
      console.error(`recap failed for league ${league.id}`, error?.message ?? error);
    }
  }
}

async function generateLeagueRecap(env, league, gameweek) {
  const leagueId = league.id;

  // Cheap read-only pre-check. Not the correctness guard (two overlapping
  // ticks could both pass it), just what stops every subsequent tick redoing
  // the work once a recap has landed. The real gate is the ledger's primary
  // key inside the atomic batch at the end.
  const already = await env.DB.prepare(
    `SELECT 1 AS x FROM fantasy_league_recaps WHERE league_id = ?1 AND gameweek = ?2`,
  )
    .bind(leagueId, gameweek)
    .first();
  if (already) return;

  const [memberRows, fixtureRows, scoreRows] = await Promise.all([
    env.DB.prepare(
      `SELECT m.user_id, u.name, u.email FROM fantasy_league_members m
       JOIN users u ON u.id = m.user_id WHERE m.league_id = ?1`,
    )
      .bind(leagueId)
      .all(),
    env.DB.prepare(
      `SELECT gameweek, home_user_id, away_user_id, home_score, away_score
       FROM fantasy_h2h_fixtures WHERE league_id = ?1 AND gameweek <= ?2`,
    )
      .bind(leagueId, gameweek + 1)
      .all(),
    env.DB.prepare(
      `SELECT user_id, gameweek, points FROM fantasy_gameweek_scores WHERE league_id = ?1 AND gameweek <= ?2`,
    )
      .bind(leagueId, gameweek)
      .all(),
  ]);

  const managers = (memberRows.results ?? []).map((row) => ({
    userId: row.user_id,
    name: memberDisplayName(row),
  }));
  if (managers.length < 2) return; // nothing to recap in a league of one

  const fixtures = (fixtureRows.results ?? []).map((row) => ({
    gameweek: row.gameweek,
    homeUserId: row.home_user_id,
    awayUserId: row.away_user_id,
    homeScore: row.home_score,
    awayScore: row.away_score,
  }));
  const scores = (scoreRows.results ?? []).map((row) => ({
    userId: row.user_id,
    gameweek: row.gameweek,
    points: row.points,
  }));

  const results = matchupResults({ fixtures, gameweek });
  // A settled gameweek with no decided fixture means the scoring pass has not
  // rolled this league up yet (or the league joined mid-season). Skipping
  // without marking the ledger leaves the next tick free to try again once the
  // scores are actually in, which is the whole reason the ledger is written
  // last rather than first.
  if (!results.length) return;

  // Movement is measured against the same ranking run one gameweek earlier.
  // For gameweek 1 there is no earlier run at all: ranking an empty season
  // would produce an alphabetical baseline and every manager would show a
  // meaningless arrow against it, so they are all correctly "new" instead.
  const rankings = attachRankMovement(
    buildPowerRankings({ managers, fixtures, scores, throughGameweek: gameweek }),
    gameweek > 1 ? buildPowerRankings({ managers, fixtures, scores, throughGameweek: gameweek - 1 }) : [],
  );

  const awards = await leagueGameweekAwards(env, leagueId, gameweek, managers, results, scores);

  const nextFixtures = fixtures.filter((fixture) => fixture.gameweek === gameweek + 1);

  const recap = mergeRecap({
    gameweek,
    managers,
    rankings,
    matchups: results,
    awards,
    generated: await writeRecapProse(env, {
      leagueId,
      leagueName: league.name,
      gameweek,
      managers,
      rankings,
      matchups: results,
      awards,
      nextFixtures,
    }),
  });

  try {
    // Ledger row and feed message in ONE batch, so two overlapping ticks that
    // both generated cannot both post: D1 runs a batch in a single
    // transaction, the primary key rejects the loser, and its feed message
    // rolls back with it. "Check, act, then mark" as the analysis pass does,
    // but with the mark and the effect made atomic, which is strictly safer
    // and costs nothing here.
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO fantasy_league_recaps (league_id, gameweek, prompt_version) VALUES (?1, ?2, ?3)`,
      ).bind(leagueId, gameweek, RECAP_PROMPT_VERSION),
      leagueEventStatement(env, leagueId, CHAT_EVENTS.RECAP, { gameweek, recap }),
    ]);
  } catch {
    // Lost the race (or a genuine D1 error): nothing committed, so there is no
    // duplicate to clean up and nothing to push about.
    return;
  }

  await sendLeaguePush(
    env,
    managers.map((manager) => manager.userId),
    {
      leagueId,
      tag: `recap-${gameweek}`,
      pref: "recap",
      title: `Gameweek ${gameweek} recap: ${league.name}`,
      body: recap.headline,
    },
  );
}

// Bench points, captain calls and the luckiest win all need each manager's
// resolved XI plus that gameweek's player scores. The lineup resolution is the
// same read-time walk the scoring pass uses (resolveManagerLineup), so a
// manager who inherited last week's XI is judged on the XI that actually
// scored, not on an empty row.
async function leagueGameweekAwards(env, leagueId, gameweek, managers, results, scores) {
  const [playerPoints, playerRows] = await Promise.all([
    fantasyPlayerPointsForGameweek(env, gameweek),
    env.DB.prepare(
      `SELECT p.id, p.name, p.team FROM fantasy_players p
       JOIN fantasy_rosters r ON r.player_id = p.id AND r.league_id = ?1`,
    )
      .bind(leagueId)
      .all(),
  ]);
  const players = new Map((playerRows.results ?? []).map((row) => [row.id, { name: row.name, team: row.team }]));

  const lineups = [];
  for (const manager of managers) {
    const { roster, starters } = await resolveManagerLineup(env, leagueId, manager.userId, gameweek);
    const starterIds = new Set(starters.map((entry) => entry.playerId));
    lineups.push({
      userId: manager.userId,
      starters,
      bench: roster.filter((player) => !starterIds.has(player.id)).map((player) => player.id),
    });
  }

  const gameweekScores = scores.filter((score) => score.gameweek === gameweek);
  return gameweekAwards({ managers, lineups, playerPoints, players, results, scores: gameweekScores });
}

// The one model call. Returns null on any failure, and mergeRecap then
// produces a recap of pure numbers with empty prose rather than nothing at
// all: the rankings and awards are the part readers actually trust.
async function writeRecapProse(env, args) {
  const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1, timeout: 60_000 });
  try {
    const response = await anthropic.messages.create({
      model: env.ANTHROPIC_MODEL || "claude-sonnet-5",
      max_tokens: 4000,
      thinking: { type: "adaptive" },
      output_config: {
        effort: "low",
        format: { type: "json_schema", schema: RECAP_SCHEMA },
      },
      system: RECAP_SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildRecapPrompt(args) }],
    });

    // Logged rather than discarded: this is the only pass in the cron that
    // spends money, and a per-league-per-gameweek cost is the number to watch
    // if it ever stops being one call a week.
    console.log(
      `recap generated league=${args.leagueId} gw=${args.gameweek} in=${response.usage?.input_tokens ?? "?"} out=${response.usage?.output_tokens ?? "?"}`,
    );

    if (response.stop_reason === "refusal") return null;
    const text = response.content.find((block) => block.type === "text")?.text ?? "";
    return JSON.parse(text); // schema-constrained
  } catch (error) {
    console.error(`recap generation failed league=${args.leagueId} gw=${args.gameweek}`, error?.message ?? error);
    return null;
  }
}

// -- Web Push (Phase 3) --------------------------------------------------------
// Subscriptions live in D1, one row per browser. The minute cron diffs each
// followed-relevant match against notify_state and fans out encrypted pushes
// (VAPID, aes128gcm via @pushforge/builder) for kickoff, goals, red cards and
// full-time, honouring each user's prefs. Targeting is the follows table; a dead
// endpoint (404/410 from the push service) is pruned on send.

const NOTIFY_WINDOW_MS = 3 * 60 * 60 * 1000; // matches within this window of kickoff/full-time get diffed
// "draft" and "recap" default true, unlike every match-alert key here:
// joining a league is itself an active opt-in (see PREF_KEYS' comment and
// schema.sql), so a manager should hear about their own draft and their own
// league's weekly recap unless they turn it off.
const DEFAULT_PREFS = {
  goals: true,
  kickoff: true,
  fulltime: true,
  red: false,
  analysis: false,
  draft: true,
  recap: true,
};

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
          title: "Kickoff Draft test",
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

    // Red cards come from match detail; the analysis pass fetches the same URL
    // on the same tick, so this is served from the in-isolate memo in fetchJson
    // rather than spending new calls. That used to be a hope about Cloudflare's
    // edge cache and is now a property of the program (see src/apiCache.js).
    // A transient fetch failure carries the previous tick's count forward instead
    // of resetting it to zero: zeroing it would make the signature regress, and
    // recovery on a later tick would then read as a fresh increase and fire a
    // duplicate red-card push for the same dismissal.
    //
    // Only the RED-CARD signal comes from detail. Goals, kickoff and full-time
    // are diffed from the batched live-fixture request that getLive already
    // made, so dropping this at the tightest budget level costs late red-card
    // pushes and nothing else; carrying the previous count forward is the same
    // behaviour a fetch failure already has, so no duplicate fires on recovery.
    let reds = prev?.reds ?? 0;
    let lastRed = null;
    let detailMinute = null;
    if (isLive(match.status) && allowsLiveEventDetail(currentBudgetLevel())) {
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
  if (!(await findKnownMatch(competitions, id, token))) {
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
    // DELETE covers cancelling a pending waiver claim, the only route using it.
    // Without it the browser's preflight rejects the call before it ever reaches
    // the Worker, even though the route itself works.
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

// `profile` is a matchDetailCacheProfile result: how long each payload may sit
// in the edge cache, chosen from the fixture's state rather than fixed. Defaults
// to the live windows so any caller that has not classified the match gets the
// safe-but-expensive behaviour rather than accidentally serving stale scores.
async function fetchMatchDetail(id, token, profile = MATCH_DETAIL_LIVE, summary = null, level = BUDGET_NORMAL) {
  // Interactive detail reads include the fixture endpoint for half-time scores and
  // referee data.
  //
  // Exactly one of these four is load-bearing. The fixture payload IS the
  // match: without it there are no teams, no kickoff and no venue to describe,
  // so it stays strict and a failure there is still a 502. The other three are
  // supplementary, and for a fixture that has not kicked off they have nothing
  // to contribute anyway. Failing the whole read on one of them was the bug:
  // any single upstream hiccup, error-shaped payload or per-minute rate limit
  // on lineups, events or player stats threw away the fixture payload that had
  // already arrived and turned an openable pre-match drawer into a 502. Note
  // that an EMPTY payload was never the problem: results:0 with response:[]
  // maps cleanly to a detail with no timeline, which is the correct pre-match
  // answer and is what a healthy upstream returns for an unplayed fixture.
  //
  // A payload the BUDGET declined is reported on `degraded` alongside the ones
  // that genuinely failed, and that conflation is deliberate: to the reader and
  // to src/matchDetail.js they are the same situation, "this section is
  // missing and the drawer should say so", and giving the client a second
  // vocabulary to handle would be two code paths for one outcome.
  const plan = matchDetailPlan(level);
  const degraded = [];
  const skip = (path) => {
    degraded.push(endpointFamily(path));
    return EMPTY_API_PAYLOAD;
  };

  // Zero upstream calls: the summary the route already holds carries teams,
  // score, kickoff, venue and status, which is a real answer. Only reachable
  // when a summary was supplied, so the cron paths (which pass none) keep
  // their strict behaviour and can never be silently emptied by a budget dip.
  if (!plan.fixture && summary) {
    const detail = mapApiFootballMatchDetailFromSummary(
      summary,
      skip("/fixtures/lineups"),
      skip("/fixtures/events"),
      skip("/fixtures/players"),
    );
    return { ...detail, degraded };
  }

  const fixture = await fetchJson(`/fixtures?id=${id}`, token, profile.fixture);
  const lineups = plan.lineups
    ? await fetchSupplementaryJson(`/fixtures/lineups?fixture=${id}`, token, profile.lineups, degraded)
    : skip("/fixtures/lineups");
  const events = plan.events
    ? await fetchSupplementaryJson(`/fixtures/events?fixture=${id}`, token, profile.events, degraded)
    : skip("/fixtures/events");
  const players = plan.players
    ? await fetchSupplementaryJson(`/fixtures/players?fixture=${id}`, token, profile.players, degraded)
    : skip("/fixtures/players");
  const detail = mapApiFootballMatchDetail(fixture, lineups, events, players);
  // Present only when something actually degraded, so a healthy read keeps the
  // exact shape the baked static files carry. It names the endpoint rather
  // than setting a bare flag because the whole reason this was hard to
  // diagnose was not knowing WHICH of the four was failing.
  return degraded.length ? { ...detail, degraded } : detail;
}

// A supplementary payload that came back empty and one that could not be
// fetched are the same thing to the mapper, and deliberately so: both mean
// "nothing to show here". They are not the same thing to an operator, which is
// why the failure is logged with its endpoint and reason and surfaced on the
// response. The fetch is still recorded as spend by fetchJson before it throws.
const EMPTY_API_PAYLOAD = Object.freeze({ response: [] });

async function fetchSupplementaryJson(path, token, cacheTtl, degraded) {
  try {
    return await fetchJson(path, token, cacheTtl);
  } catch (error) {
    const family = endpointFamily(path);
    degraded.push(family);
    console.warn(`match detail: ${family} unavailable, serving empty`, error?.message ?? error);
    return EMPTY_API_PAYLOAD;
  }
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

// The in-isolate response memo and its in-flight map. See src/apiCache.js for
// why this exists at all; the short version is that one cron tick asked for the
// same season-schedule URL eight times and paid for it more often than not.
const responseCache = createResponseCache();
// Coalescing is separate from the memo because a promise is not a cacheable
// value: two passes reaching the same URL microseconds apart must share ONE
// upstream request, and without this the memo would not be populated yet for
// the second and both would go out.
const inflightRequests = new Map();

async function fetchJson(path, token, cacheTtl) {
  const url = `${API}${path}`;
  const now = Date.now();

  const cached = readCached(responseCache, url, now);
  if (cached !== undefined) return cached;
  const inflight = inflightRequests.get(url);
  if (inflight) return inflight;

  const request = fetchUpstream(url, path, token, cacheTtl).finally(() => {
    inflightRequests.delete(url);
  });
  inflightRequests.set(url, request);
  return request;
}

async function fetchUpstream(url, path, token, cacheTtl) {
  const response = await fetch(url, {
    headers: { "x-apisports-key": token },
    cf: { cacheTtl, cacheEverything: true },
  });
  // Recorded here and nowhere else: this is the single chokepoint every
  // upstream call passes through, so anything measured further out would be a
  // second count to keep in step with this one. Deliberately BEFORE the status
  // check, because a call that came back 500 was still a call: dropping the
  // failures would make the budget look healthiest exactly when upstream is
  // sick and the retries are stacking up.
  //
  // Note what the memo above does NOT change about this accounting: a memo hit
  // returns before reaching here, so it is neither counted as spend nor as a
  // cached call. That is correct rather than convenient. cacheHitRate is
  // defined as the share of demand Cloudflare's edge absorbed, and folding our
  // own memo into it would conflate two different caches and hide a
  // regression in the one we do not control.
  recordUpstreamUsage(path, response);
  if (!response.ok) throw new Error(`upstream ${response.status}`);
  const payload = assertApiFootballPayload(await response.json());
  // Stored only on success. A thrown error must never be memoised: a single
  // upstream blip would otherwise be replayed as a failure for the whole
  // window, turning a one-second fault into a six-hour outage.
  writeCached(responseCache, url, payload, cacheTtl, Date.now());
  return payload;
}

// -- API-Football quota analytics ---------------------------------------------
// The maths is in src/apiQuota.js and the buffering in src/apiQuotaStore.js;
// this is only the wiring. See GET /health/quota for the read side.
//
// A flush is never on a user's critical path: recording is an in-memory counter
// bump, and the write is handed to waitUntil at the TOP of a later request, so
// by the time it runs it can only be flushing work that has already finished.

const usageBuffer = createUsageBuffer();
const USAGE_FLUSH_INTERVAL_MS = 30 * 1000;
// A busy isolate should not sit on half a minute of records, so size forces a
// flush too. Well below the buffer's key cap: this counts calls, not keys.
const USAGE_FLUSH_MAX_RECORDS = 200;
const USAGE_RETENTION_DAYS = 14;
let usageFlushedAt = 0;
let usageFlushInFlight = null;

function recordUpstreamUsage(path, response) {
  try {
    bufferUsage(usageBuffer, {
      path,
      cacheStatus: response.headers.get("cf-cache-status"),
      headers: response.headers,
      at: Date.now(),
    });
  } catch {
    // Measurement must never break the thing it is measuring. A lost record
    // undercounts a chart; a throw here would fail a real user's request.
  }
}

// The guard rail's reading of how much allowance is left, from the provider's
// own headers (see src/apiBudget.js for what each level sheds and why). Wrapped
// like recordUpstreamUsage is: if deciding how much to spend somehow throws,
// the answer is "spend normally", never "fail the request".
function currentBudgetLevel() {
  try {
    return budgetLevel(latestQuota(usageBuffer));
  } catch {
    return BUDGET_NORMAL;
  }
}

// No-ops unless there is something to write, somewhere to write it, and the
// buffer is actually due. Concurrent callers share one in-flight flush rather
// than each draining a slice, which keeps the writes to one per interval.
async function flushApiUsage(env, { force = false } = {}) {
  if (!env?.DB) return;
  const size = bufferSize(usageBuffer);
  if (!size) return;
  const due = force || size >= USAGE_FLUSH_MAX_RECORDS || Date.now() - usageFlushedAt >= USAGE_FLUSH_INTERVAL_MS;
  if (!due) return;
  if (usageFlushInFlight) return usageFlushInFlight;

  usageFlushedAt = Date.now();
  usageFlushInFlight = writeApiUsage(env).finally(() => {
    usageFlushInFlight = null;
  });
  return usageFlushInFlight;
}

async function writeApiUsage(env) {
  // Drained, not copied: a write that fails takes its records with it, which
  // undercounts. Retrying a copy would risk counting the same calls twice, and
  // an overcount is the direction that makes the projection cry wolf.
  const { rows, quota } = drainUsage(usageBuffer);
  if (!rows.length && !quota.length) return;
  try {
    const statements = [];
    // Chunked even though a drain is realistically a handful of rows: D1's
    // 100 bound-parameter limit is a cliff, not a slowdown.
    for (const chunk of chunkRows(rows, 4)) {
      for (const row of chunk) {
        statements.push(
          env.DB.prepare(
            `INSERT INTO api_usage_daily (day, endpoint, upstream, calls) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(day, endpoint, upstream) DO UPDATE SET calls = calls + excluded.calls`,
          ).bind(row.day, row.endpoint, row.upstream ? 1 : 0, row.count),
        );
      }
    }
    for (const entry of quota) {
      // MIN on remaining: within a UTC day the provider's counter only falls,
      // so a higher reading arriving late (another isolate flushing out of
      // order) must not make the gauge appear to refill.
      statements.push(
        env.DB.prepare(
          `INSERT INTO api_usage_quota (day, daily_limit, daily_remaining, updated_at)
           VALUES (?1, ?2, ?3, datetime('now'))
           ON CONFLICT(day) DO UPDATE SET
             daily_limit = COALESCE(excluded.daily_limit, api_usage_quota.daily_limit),
             daily_remaining = MIN(COALESCE(api_usage_quota.daily_remaining, excluded.daily_remaining), excluded.daily_remaining),
             updated_at = datetime('now')`,
        ).bind(entry.day, entry.dailyLimit, entry.dailyRemaining),
      );
    }
    if (statements.length) await env.DB.batch(statements);
  } catch (error) {
    console.error("api usage flush failed", error?.message ?? error);
  }
}

// Retention runs on the cron rather than on the flush path: it is a whole-table
// delete and has no business happening behind a user's request.
async function pruneApiUsage(env) {
  if (!env?.DB) return;
  const cutoff = usageDay(Date.now() - USAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  if (!cutoff) return;
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM api_usage_daily WHERE day < ?1`).bind(cutoff),
    env.DB.prepare(`DELETE FROM api_usage_quota WHERE day < ?1`).bind(cutoff),
  ]);
}

// The cron's own analytics pass. Forces a flush (the tick is a minute apart, so
// waiting for the interval would mean the cron's own upstream calls, which are
// the bulk of the spend on a quiet day, sat unrecorded until a visitor arrived)
// and then prunes.
async function runScheduledApiUsage(env) {
  await flushApiUsage(env, { force: true });
  // Expired memo entries are already inert to readCached, so this only
  // reclaims memory. Done on the cron rather than on the read path because an
  // isolate that serves a busy matchday and then idles overnight should not be
  // holding ninety-odd stale payloads until it is recycled.
  pruneCache(responseCache, Date.now());
  await pruneApiUsage(env);
}

// Unauthenticated and read-only, the same call as /health/draft-ready: the body
// is aggregate call counts and the provider's own allowance, with no user data
// and nothing that helps an attacker. Making it require a session would mean
// the one view that says "the budget is about to run out" is unavailable from
// a phone at the moment it matters.
async function handleQuotaHealth(env, cors) {
  if (!env.DB) return json({ error: "usage analytics not configured" }, 501, cors);
  const now = Date.now();
  const day = usageDay(now);
  try {
    // Flushed first so the report includes this isolate's own buffer rather
    // than reading a picture up to half a minute stale.
    await flushApiUsage(env, { force: true });
    const [usage, quota] = await Promise.all([
      env.DB.prepare(`SELECT endpoint, upstream, calls FROM api_usage_daily WHERE day = ?1`).bind(day).all(),
      env.DB.prepare(`SELECT daily_limit, daily_remaining FROM api_usage_quota WHERE day = ?1`).bind(day).first(),
    ]);
    const rows = (usage.results ?? []).map((row) => ({
      endpoint: row.endpoint,
      upstream: row.upstream === 1,
      count: row.calls,
    }));
    const report = buildQuotaReport({
      rows,
      quota: quota ? { dailyLimit: quota.daily_limit, dailyRemaining: quota.daily_remaining } : null,
      now,
    });
    return json(report, 200, { ...cors, "Cache-Control": "no-store" });
  } catch (error) {
    // Almost always "the tables have not been applied to this database yet",
    // which is worth saying rather than returning a 502 that reads like the
    // football feed is down.
    return json({ error: "usage analytics unavailable", detail: String(error?.message ?? error) }, 503, cors);
  }
}

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extra },
  });
}

// Feed the Worker safety copy through a separate provider route. Discovery
// reads the provider directly; asking the Worker would repeat its outage.
// Each live pass reuses discovery for scores. Match detail is fetched once
// per run to keep its request cost stable. Unknown discovery keeps retrying
// within the loop budget; genuine idle results return to a slower cadence.
// Missing credentials leave this optional feeder inactive.

import { COMPETITIONS as COMPETITION_CONFIG } from "../src/competitions.js";
import { mapApiFootballMatches, fixturePollingPlan } from "../src/mapApiFootball.js";
import { appendFile } from "node:fs/promises";
import { assertApiFootballPayload } from "../src/apiFootballPayload.js";
import { parseQuotaHeaders, isLimitRejection } from "../src/apiQuota.js";
import { budgetLevel, BUDGET_NORMAL } from "../src/apiBudget.js";

const WORKER_ORIGIN = process.env.WORKER_ORIGIN ?? "https://goon-squad-data.gs-wc.workers.dev";
const API = "https://v3.football.api-sports.io";
const KEY = process.env.API_FOOTBALL_KEY;
const TOKEN = process.env.DETAIL_INGEST_TOKEN;
const COMPETITIONS = (process.env.API_FOOTBALL_COMPETITIONS ?? "PL:2026,CL:2026")
  .split(",")
  .map((pair) => {
    const [code, season] = pair.split(":").map((part) => part.trim());
    const leagueId = COMPETITION_CONFIG[code]?.apiFootballLeagueId;
    return code && season && leagueId ? { code, season, leagueId } : null;
  })
  .filter(Boolean);

const LINEUP_LEAD_MS = 70 * 60 * 1000;
const FULL_TIME_TAIL_MS = 3 * 60 * 60 * 1000;
// The mapped feed carries no full-time timestamp, so the post-whistle tail is
// anchored on kickoff plus a typical match length. The first version measured
// FULL_TIME_TAIL_MS from kickoff alone, which cut the real tail after the
// whistle to ~70 minutes: on the 2026-27 opening Saturday the three 14:00
// matches fell out of the window before this workflow's first run of the day,
// and were never fed at all. The wide anchor also absorbs GitHub's cron
// drift, which stretches the nominal 5-minute cadence to 15-30 minutes.
const TYPICAL_MATCH_MS = 2 * 60 * 60 * 1000;
const PACING_MS = 400;
// How long one run keeps pushing, and how often. Bounded well inside the
// workflow's own timeout so a run always exits on its own terms.
const LOOP_BUDGET_MS = Number(process.env.FEEDER_LOOP_BUDGET_MS ?? 6 * 60 * 1000);
const LOOP_INTERVAL_MS = Number(process.env.FEEDER_LOOP_INTERVAL_MS ?? 60 * 1000);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let lastProviderRead = 0;
let quota = {};

function worthFeeding(match, now) {
  const kickoff = Date.parse(match.utcDate);
  if (!Number.isFinite(kickoff)) return false;
  if (fixturePollingPlan([match], now).mode === "live") return true;
  if (match.status === "TIMED" || match.status === "SCHEDULED") {
    return kickoff - now <= LINEUP_LEAD_MS && kickoff - now > 0;
  }
  if (match.status === "FINISHED") return now - kickoff <= TYPICAL_MATCH_MS + FULL_TIME_TAIL_MS;
  return false;
}

async function apiGet(path, { detail = false } = {}) {
  if (quota.limitedUntil > Date.now()) throw new Error("Provider cooldown");
  if (detail && budgetLevel(quota, Date.now()) !== BUDGET_NORMAL) throw new Error("Preserving quota for scores");
  await sleep(Math.max(0, lastProviderRead + PACING_MS - Date.now()));
  lastProviderRead = Date.now();
  const response = await fetch(`${API}${path}`, { headers: { "x-apisports-key": KEY }, signal: AbortSignal.timeout(10000) });
  const reading = parseQuotaHeaders(response.headers);
  for (const [key, value] of Object.entries(reading)) {
    if (value != null) quota[key] = value;
  }
  if (reading.minuteRemaining === 0) quota.limitedUntil = Date.now() + 60000;
  if (isLimitRejection(response.status, null)) quota.limitedUntil = Date.now() + 60000;
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  const payload = await response.json();
  if (isLimitRejection(response.status, payload?.errors)) quota.limitedUntil = Date.now() + 60000;
  return assertApiFootballPayload(payload);
}

// The scoreboard copy: the discovery payload, pushed verbatim for the Worker to
// map. Failure is logged and swallowed - detail feeding is the job this script
// was written for and must not be lost to a scoreboard push going wrong.
async function feedLive(code, fixtures) {
  try {
    const response = await fetch(`${WORKER_ORIGIN}/ingest/live/${code}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fixtures }),
      signal: AbortSignal.timeout(10000),
    });
    const result = await response.json().catch(() => ({}));
    console.log(`${code}: live ingest ${response.status} ${JSON.stringify(result)}`);
  } catch (error) {
    console.log(`${code}: live ingest failed (${error.message})`);
  }
}

async function feedMatch(id) {
  const fixture = await apiGet(`/fixtures?id=${id}`, { detail: true });
  const lineups = await apiGet(`/fixtures/lineups?fixture=${id}`, { detail: true });
  const events = await apiGet(`/fixtures/events?fixture=${id}`, { detail: true });
  const players = await apiGet(`/fixtures/players?fixture=${id}`, { detail: true });
  const response = await fetch(`${WORKER_ORIGIN}/ingest/detail/${id}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fixture, lineups, events, players }),
    signal: AbortSignal.timeout(10000),
  });
  const result = await response.json().catch(() => ({}));
  console.log(`match ${id}: ingest ${response.status} ${JSON.stringify(result)}`);
  if (!response.ok) throw new Error(`ingest ${id}: HTTP ${response.status}`);
}

// Discover and push every due competition before detail can delay its neighbours.
async function runPass({ detailed, deadline, states }) {
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  let fed = 0;
  const details = [];
  for (const { code, season, leagueId } of COMPETITIONS) {
    const previous = states.get(code);
    if (previous && now < previous.nextAt) continue;
    let payload;
    let matches;
    try {
      payload = await apiGet(`/fixtures?league=${leagueId}&season=${season}&date=${today}`);
      matches = mapApiFootballMatches(payload);
    } catch (error) {
      console.log(`feeder: could not read ${code} fixtures for ${today} (${error.message}); skipping`);
      states.set(code, { active: true, nextAt: now + LOOP_INTERVAL_MS });
      continue;
    }
    const plan = fixturePollingPlan(matches, now);
    const active = plan.mode === "live" || plan.mode === "kickoff_wait" || (previous?.active && !matches.length);
    const nextAt = active ? now + LOOP_INTERVAL_MS
      : Math.min(...plan.requests.flatMap(request => request.fixtures.map(match => Date.parse(match.utcDate))));
    states.set(code, { active: Boolean(active), nextAt });
    await feedLive(code, payload);
    if (!detailed.has(code) && matches.length) {
      details.push({ code, candidates: matches.filter(match => worthFeeding(match, now)) });
    }
  }
  for (const { code, candidates } of details) {
    if (budgetLevel(quota, Date.now()) !== BUDGET_NORMAL) break;
    detailed.add(code);
    console.log(`${code}: ${candidates.length} match(es) worth feeding`);
    for (const match of candidates) {
      if (Date.now() >= deadline || budgetLevel(quota, Date.now()) !== BUDGET_NORMAL) break;
      try {
        await feedMatch(match.id);
        fed += 1;
      } catch (error) {
        console.log(`match ${match.id}: ${error.message}`);
      }
      await sleep(PACING_MS);
    }
  }
  return { fed, keepChecking: [...states.values()].some(state => state.active || state.nextAt < deadline) };
}

async function main() {
  if (!KEY || !TOKEN) {
    console.log("feeder: API_FOOTBALL_KEY or DETAIL_INGEST_TOKEN not configured; nothing to do");
    return;
  }
  const deadline = Date.now() + LOOP_BUDGET_MS;
  let passes = 0;
  let fed = 0;
  let keepChecking = false;
  const detailed = new Set();
  const states = new Map();
  for (;;) {
    // Detail is fed once per run on purpose. It is the DRAWER's safety copy and
    // moves on the timescale of goals; the scoreboard moves on the timescale of
    // a clock. Feeding detail every pass would multiply a run's upstream cost
    // several times over to refresh something nobody watches tick.
    const result = await runPass({ detailed, deadline, states });
    fed += result.fed;
    passes += 1;
    keepChecking = result.keepChecking;
    if (!keepChecking) {
      console.log("feeder: nothing in play; one pass is enough");
      break;
    }
    if (Date.now() + LOOP_INTERVAL_MS >= deadline) break;
    await sleep(LOOP_INTERVAL_MS);
  }
  console.log(`feeder: done, ${fed} match(es) fed across ${passes} pass(es)`);
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `rearm_delay_seconds=${keepChecking ? 60 : 180}\n`);
  }
}

await main();

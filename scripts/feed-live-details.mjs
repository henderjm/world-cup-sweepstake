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
import { fixtureDates } from "./live-feeder-window.mjs";

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

function requestSignal(deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("Feeder run deadline reached");
  return AbortSignal.timeout(Math.min(10000, remaining));
}

async function apiGet(path, { detail = false, deadline } = {}) {
  if (quota.limitedUntil > Date.now()) throw new Error("Provider cooldown");
  if (detail && budgetLevel(quota, Date.now()) !== BUDGET_NORMAL) throw new Error("Preserving quota for scores");
  await sleep(Math.max(0, Math.min(lastProviderRead + PACING_MS, deadline) - Date.now()));
  lastProviderRead = Date.now();
  const response = await fetch(`${API}${path}`, { headers: { "x-apisports-key": KEY }, signal: requestSignal(deadline) });
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
async function feedLive(code, fixtures, deadline) {
  try {
    const response = await fetch(`${WORKER_ORIGIN}/ingest/live/${code}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fixtures }),
      signal: requestSignal(deadline),
    });
    const result = await response.json();
    console.log(`${code}: live ingest ${response.status} ${JSON.stringify(result)}`);
  } catch (error) {
    console.log(`${code}: live ingest failed (${error.message})`);
  }
}

async function feedMatch(id, deadline, refreshScores) {
  const read = async path => {
    await refreshScores();
    return apiGet(path, { detail: true, deadline });
  };
  const fixture = await read(`/fixtures?id=${id}`);
  const lineups = await read(`/fixtures/lineups?fixture=${id}`);
  const events = await read(`/fixtures/events?fixture=${id}`);
  const players = await read(`/fixtures/players?fixture=${id}`);
  await refreshScores();
  const response = await fetch(`${WORKER_ORIGIN}/ingest/detail/${id}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fixture, lineups, events, players }),
    signal: requestSignal(deadline),
  });
  const result = await response.json();
  console.log(`match ${id}: ingest ${response.status} ${JSON.stringify(result)}`);
  if (!response.ok) throw new Error(`ingest ${id}: HTTP ${response.status}`);
}

// Discover and push every due competition before detail can delay its neighbours.
async function refreshScores({ scheduled, pending, deadline, states }) {
  for (const { code, season, leagueId } of COMPETITIONS) {
    const now = Date.now();
    if (now >= deadline) break;
    const dates = fixtureDates(now);
    const dateKey = dates.join(',');
    const previous = states.get(code);
    if (previous?.dateKey === dateKey && now < previous.nextAt) continue;
    let payload;
    let matches;
    try {
      const response = [];
      for (const date of dates) {
        const day = await apiGet(`/fixtures?league=${leagueId}&season=${season}&date=${date}`, { deadline });
        response.push(...day.response);
      }
      payload = { response, errors: [] };
      matches = mapApiFootballMatches(payload);
    } catch (error) {
      console.log(`feeder: could not read ${code} fixtures for ${dates.join(', ')} (${error.message}); skipping`);
      states.set(code, { active: true, nextAt: now + LOOP_INTERVAL_MS, dateKey });
      continue;
    }
    const plan = fixturePollingPlan(matches, now);
    const active = plan.mode === "live" || plan.mode === "kickoff_wait" || (previous?.active && !matches.length);
    const nextAt = active ? now + LOOP_INTERVAL_MS
      : Math.min(...plan.requests.flatMap(request => request.fixtures.map(match => Date.parse(match.utcDate))));
    states.set(code, { active: Boolean(active), nextAt, dateKey });
    await feedLive(code, payload, deadline);
    if (!scheduled.has(code) && matches.length) {
      scheduled.add(code);
      pending.push(...matches.filter(match => worthFeeding(match, now)));
    }
  }
}

async function main() {
  if (!KEY || !TOKEN) {
    console.log("feeder: API_FOOTBALL_KEY or DETAIL_INGEST_TOKEN not configured; nothing to do");
    return;
  }
  const deadline = Date.now() + LOOP_BUDGET_MS;
  let fed = 0;
  const scheduled = new Set(), pending = [], states = new Map();
  const refresh = () => refreshScores({ scheduled, pending, deadline, states });
  while (Date.now() < deadline) {
    await refresh();
    if (Date.now() >= deadline) break;
    if (pending.length && budgetLevel(quota, Date.now()) === BUDGET_NORMAL) {
      const match = pending.shift();
      try {
        // A slow detail body must not hold up every later score poll in the job.
        await feedMatch(match.id, deadline, refresh);
        fed += 1;
      } catch (error) {
        console.log(`match ${match.id}: ${error.message}`);
      }
      continue;
    }
    const nextAt = Math.min(...[...states.values()].map(state => state.nextAt));
    if (nextAt >= deadline) break;
    await sleep(Math.max(0, nextAt - Date.now()));
  }
  const keepChecking = [...states.values()].some(state => state.active || state.nextAt < deadline);
  console.log(`feeder: done, ${fed} match(es) fed`);
  if (process.env.GITHUB_OUTPUT) {
    const followUpNeeded = [...states.values()].some(state => Number.isFinite(state.nextAt));
    await appendFile(process.env.GITHUB_OUTPUT, `rearm_delay_seconds=${keepChecking ? 60 : 180}\nfollow_up_needed=${followUpNeeded}\n`);
  }
}

await main();

#!/usr/bin/env node
// Sportmonks comparison probe for the V2 provider switch
// (docs/release-plan-matchday-2.md, V2 section). Answers, with evidence:
//   1. Coverage: do Premier League (8) and Champions League (2) fixtures come
//      back on this plan?
//   2. Data: which includes the plan actually serves on one real fixture
//      (events, lineups, statistics, xG, pressure, predictions, sidelined...),
//      and whether player ratings and team xG are present.
//   3. Cost: the rate_limit Sportmonks reports (per entity per hour; includes
//      do not count as extra calls).
//   4. Delay: when API_FOOTBALL_KEY is also set, both providers' live score and
//      minute for the same matches, read in the same second.
//   5. ID map: Sportmonks team names next to the app's canonical names, the
//      join the fixture id map will be built on.
// Writes the SHAPE of each answer to docs/live-score-evidence, never a key.
//
// Usage: SPORTMONKS_API_KEY=... [API_FOOTBALL_KEY=...] node scripts/probe-sportmonks.mjs [fixtureId]

import { writeFile } from "node:fs/promises";
import { normalizeTeamName } from "../src/domain.js";

const BASE = "https://api.sportmonks.com/v3/football";
const LEAGUES = { 8: "PL", 2: "CL" };
const INCLUDES = [
  "participants", "scores", "state", "periods", "events", "lineups.details", "statistics",
  "xGFixture", "pressure", "predictions", "sidelined", "referees", "venue", "formations",
];
const key = process.env.SPORTMONKS_API_KEY;
if (!key) {
  console.error("SPORTMONKS_API_KEY is not set");
  process.exit(1);
}

let calls = 0;
let lastRate = null;

// The token goes in the Authorization header, never the URL, so it cannot
// land in an error message, a log line or the evidence file.
async function call(path, params = {}) {
  calls += 1;
  const url = new URL(`${BASE}${path}`);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  const res = await fetch(url, { headers: { Authorization: key, Accept: "application/json" } });
  let body = {};
  try { body = await res.json(); } catch { /* non-JSON error page */ }
  if (body.rate_limit) lastRate = body.rate_limit;
  return {
    status: res.status,
    message: body.message ?? null,
    data: body.data ?? null,
    subscription: body.subscription ?? null,
    rateLimit: body.rate_limit ?? null,
    headerLimit: res.headers.get("x-ratelimit-limit"),
    headerRemaining: res.headers.get("x-ratelimit-remaining"),
  };
}

const today = new Date().toISOString().slice(0, 10);
const leagueFilter = { filters: `fixtureLeagues:${Object.keys(LEAGUES).join(",")}` };

function side(fixture, location) {
  return fixture.participants?.find(p => p.meta?.location === location) ?? null;
}

function currentScore(fixture) {
  const current = (fixture.scores ?? []).filter(s => s.description === "CURRENT");
  const goals = location => current.find(s => s.score?.participant === location)?.score?.goals ?? null;
  return { home: goals("home"), away: goals("away") };
}

function summarize(fixture) {
  const home = side(fixture, "home");
  const away = side(fixture, "away");
  return {
    id: fixture.id,
    league: LEAGUES[fixture.league_id] ?? fixture.league_id,
    kickoff: fixture.starting_at,
    state: fixture.state?.developer_name ?? fixture.state_id ?? null,
    minute: fixture.periods?.find(p => p.ticking)?.minutes ?? null,
    home: home?.name ?? null,
    away: away?.name ?? null,
    score: currentScore(fixture),
  };
}

function shape(value) {
  if (Array.isArray(value)) return { type: "array", length: value.length, sample: value[0] ?? null };
  if (value && typeof value === "object") return { type: "object", keys: Object.keys(value) };
  return { type: typeof value, value };
}

// 1. Coverage: today's PL and CL fixtures, and what is live right now.
const day = await call(`/fixtures/date/${today}`, { ...leagueFilter, include: "participants;scores;state;periods" });
const inplay = await call("/livescores/inplay", { ...leagueFilter, include: "participants;scores;state;periods" });
const dayFixtures = (day.data ?? []).map(summarize);
const liveFixtures = (inplay.data ?? []).map(summarize);

// 2. Data: every include in one call on one fixture; if the plan refuses the
// combination, retry each include alone so the refusal names the include.
const fixtureId = process.argv[2] ?? liveFixtures[0]?.id ?? dayFixtures.find(f => f.state === "FT")?.id ?? dayFixtures[0]?.id ?? null;
const includes = {};
let detailSummary = null;
if (fixtureId) {
  const all = await call(`/fixtures/${fixtureId}`, { include: INCLUDES.join(";") });
  if (all.status === 200 && all.data) {
    detailSummary = summarize(all.data);
    for (const name of INCLUDES) includes[name] = { served: true, ...shape(all.data[name.split(".")[0]]) };
  } else {
    for (const name of INCLUDES) {
      const one = await call(`/fixtures/${fixtureId}`, { include: name });
      includes[name] = one.status === 200 && one.data
        ? { served: true, ...shape(one.data[name.split(".")[0]]) }
        : { served: false, status: one.status, message: one.message };
    }
  }
}

// Player ratings live in lineups.details (type "Rating"); team xG in xGFixture.
const lineupDetails = includes["lineups.details"]?.served ? (includes["lineups.details"].sample?.details ?? []) : [];
const ratingPresent = lineupDetails.some(d => /rating/i.test(d.type?.name ?? d.type?.developer_name ?? "") || d.type_id === 118);

// 4. Delay: both providers, same second, matched on canonical team names.
let delay = null;
if (process.env.API_FOOTBALL_KEY) {
  const [sm, af] = await Promise.all([
    call("/livescores/inplay", { ...leagueFilter, include: "participants;scores;periods" }),
    fetch("https://v3.football.api-sports.io/fixtures?live=39-2", { headers: { "x-apisports-key": process.env.API_FOOTBALL_KEY } })
      .then(r => r.json()).catch(() => ({ response: [] })),
  ]);
  const afByHome = new Map((af.response ?? []).map(f => [normalizeTeamName(f.teams?.home?.name), f]));
  delay = (sm.data ?? []).map(summarize).map(f => {
    const other = afByHome.get(normalizeTeamName(f.home));
    return {
      match: `${f.home} v ${f.away}`,
      sportmonks: { minute: f.minute, score: f.score },
      apiFootball: other ? { minute: other.fixture?.status?.elapsed ?? null, score: other.goals } : null,
    };
  });
}

// 5. ID map: Sportmonks names against the app's canonical names.
const names = [...new Set(dayFixtures.flatMap(f => [f.home, f.away]).filter(Boolean))];
const nameMap = names.map(name => ({ sportmonks: name, canonical: normalizeTeamName(name), changed: normalizeTeamName(name) !== name }));

const evidence = {
  probedAt: new Date().toISOString(),
  calls,
  subscription: day.subscription,
  rateLimit: lastRate,
  coverage: {
    todayStatus: day.status, todayMessage: day.message,
    leaguesToday: [...new Set(dayFixtures.map(f => f.league))],
    fixturesToday: dayFixtures,
    inplayStatus: inplay.status, live: liveFixtures,
  },
  fixture: detailSummary ?? fixtureId,
  includes,
  ratingPresent,
  xgPresent: Boolean(includes.xGFixture?.served && (includes.xGFixture.length ?? 0) > 0),
  pressurePresent: Boolean(includes.pressure?.served && (includes.pressure.length ?? 0) > 0),
  delay,
  nameMap,
};

const out = `docs/live-score-evidence/${today}-sportmonks-probe.json`;
await writeFile(out, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`wrote ${out}`);
console.log(`calls: ${calls} · rate limit: ${lastRate ? `${lastRate.remaining} left for ${lastRate.requested_entity}, resets in ${lastRate.resets_in_seconds}s` : "not reported"}`);
console.log(`leagues today: ${evidence.coverage.leaguesToday.join(", ") || "none"} · live now: ${liveFixtures.length}`);
console.log(`includes served: ${Object.entries(includes).filter(([, v]) => v.served).map(([k]) => k).join(", ") || "none"}`);
console.log(`refused: ${Object.entries(includes).filter(([, v]) => !v.served).map(([k]) => k).join(", ") || "none"}`);
console.log(`ratings: ${ratingPresent} · xG: ${evidence.xgPresent} · pressure: ${evidence.pressurePresent}`);
if (delay) console.log(`delay rows: ${delay.length} (see the file for minute and score side by side)`);

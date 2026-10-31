#!/usr/bin/env node
// M0 field probe for the "Your Match" release (docs/release-plan-matchday-2.md).
// Spends at most five provider calls: one fixture lookup (skipped when a
// fixture id is passed) and one each to the four endpoints the release would
// add or start reading more of. Writes the SHAPE of each answer (keys, stat
// types, null rates, one sample) to docs/live-score-evidence, never the key.
//
// Usage: API_FOOTBALL_KEY=... node scripts/probe-provider-fields.mjs [fixtureId]

import { writeFile } from "node:fs/promises";

const BASE = "https://v3.football.api-sports.io";
const key = process.env.API_FOOTBALL_KEY;
if (!key) {
  console.error("API_FOOTBALL_KEY is not set");
  process.exit(1);
}

let lastQuota = null;

async function call(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { "x-apisports-key": key } });
  lastQuota = {
    dailyLimit: res.headers.get("x-ratelimit-requests-limit"),
    dailyRemaining: res.headers.get("x-ratelimit-requests-remaining"),
    minuteRemaining: res.headers.get("x-ratelimit-remaining"),
  };
  const body = await res.json();
  const errors = body.errors && Object.keys(body.errors).length ? body.errors : null;
  return { status: res.status, errors, results: body.results ?? null, response: body.response ?? [] };
}

async function pickFixture() {
  const live = await call("/fixtures?live=39-2");
  if (live.response.length) return live.response[0];
  const today = new Date().toISOString().slice(0, 10);
  const day = await call(`/fixtures?league=39&season=2026&date=${today}`);
  return day.response.find((f) => f.fixture?.status?.short === "FT") ?? day.response[0] ?? null;
}

// Every leaf path in an object, so a nested stat block shows up as
// "passes.key" rather than "passes: [object]".
function leafPaths(value, prefix = "", out = new Set()) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) leafPaths(v, prefix ? `${prefix}.${k}` : k, out);
  } else {
    out.add(prefix);
  }
  return out;
}

function get(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
}

function summarizeStatistics(r) {
  return {
    ...pick(r),
    teams: r.response.map((t) => ({
      team: t.team?.name,
      stats: Object.fromEntries((t.statistics ?? []).map((s) => [s.type, s.value])),
    })),
  };
}

function summarizePlayers(r) {
  const entries = r.response.flatMap((t) => (t.players ?? []).map((p) => p.statistics?.[0] ?? {}));
  const paths = [...new Set(entries.flatMap((e) => [...leafPaths(e)]))].sort();
  const nonNull = Object.fromEntries(
    paths.map((p) => [p, entries.filter((e) => get(e, p) != null).length]),
  );
  const top = r.response
    .flatMap((t) => (t.players ?? []).map((p) => ({ player: p.player?.name, team: t.team?.name, rating: p.statistics?.[0]?.games?.rating ?? null })))
    .filter((p) => p.rating != null)
    .sort((a, b) => Number(b.rating) - Number(a.rating))
    .slice(0, 3);
  return { ...pick(r), playerEntries: entries.length, fieldNonNullCounts: nonNull, topRated: top };
}

function summarizeShape(r) {
  const first = r.response[0] ?? null;
  return { ...pick(r), fields: first ? [...leafPaths(first)].sort() : [], sample: first };
}

function pick(r) {
  return { status: r.status, errors: r.errors, results: r.results };
}

const fixtureArg = process.argv[2];
const fixture = fixtureArg ? null : await pickFixture();
const fixtureId = fixtureArg ?? fixture?.fixture?.id;
if (!fixtureId) {
  console.error("No Premier League fixture found live or today; pass a fixture id");
  process.exit(1);
}

const [statistics, players, predictions, injuries] = await Promise.all([
  call(`/fixtures/statistics?fixture=${fixtureId}`),
  call(`/fixtures/players?fixture=${fixtureId}`),
  call(`/predictions?fixture=${fixtureId}`),
  call(`/injuries?fixture=${fixtureId}`),
]);

const report = {
  probedAt: new Date().toISOString(),
  fixtureId: Number(fixtureId),
  fixture: fixture
    ? {
        home: fixture.teams?.home?.name,
        away: fixture.teams?.away?.name,
        status: fixture.fixture?.status?.short,
        elapsed: fixture.fixture?.status?.elapsed,
      }
    : "passed by id",
  quotaAfter: lastQuota,
  statistics: summarizeStatistics(statistics),
  players: summarizePlayers(players),
  predictions: summarizeShape(predictions),
  injuries: summarizeShape(injuries),
};

const out = `docs/live-score-evidence/${report.probedAt.slice(0, 10)}-m0-provider-fields.json`;
await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
console.log(`wrote ${out}`);
console.log(`xG present: ${report.statistics.teams.some((t) => "expected_goals" in t.stats)}`);
console.log(`players with a rating: ${report.players.fieldNonNullCounts["games.rating"] ?? 0}/${report.players.playerEntries}`);
console.log(`daily quota: ${lastQuota?.dailyRemaining}/${lastQuota?.dailyLimit}`);

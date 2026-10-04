// Requires Node 22.13+ with node:sqlite. Uses an in-memory database only.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { scoreFeed } from "../../services/scores/snapshots.mjs";

const db = new DatabaseSync(":memory:");
db.exec(await readFile(new URL("../../worker/schema.sql", import.meta.url), "utf8"));
db.exec("PRAGMA foreign_keys = ON");
const sqlErrors = [], warnings = [], requests = [], kv = [];
let failScoreBatch = false, injectedFailures = 0;
const database = {
  prepare(sql) {
    let values = [];
    const statement = db.prepare(sql.replace(/\?(\d+)/g, ":p$1"));
    const args = () => values.length ? [Object.fromEntries(values.map((value, i) => [`p${i + 1}`, value]))] : [];
    const call = method => { try { return statement[method](...args()); } catch (error) { sqlErrors.push({ sql, message: error.message }); throw error; } };
    return { bind(...next) { assert.ok(next.length <= 100, "D1 binding limit exceeded"); values = next; return this; },
      async first() { return call("get") ?? null; }, async all() { return { results: call("all") }; },
      async run() {
        if (failScoreBatch && sql.includes("INSERT OR REPLACE INTO fantasy_player_match_scores") && values[1] === 101) {
          failScoreBatch = false; injectedFailures++; throw Error("Synthetic score batch interruption");
        }
        const result = call("run"); return { success: true, meta: { changes: result.changes, last_row_id: result.lastInsertRowid } }; } };
  },
  async batch(statements) {
    db.exec("BEGIN");
    try { const results = []; for (const statement of statements) results.push(await statement.run()); db.exec("COMMIT"); return results; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  },
};
let now = Date.parse("2026-10-13T19:30:00Z"), version = 1, mode = "live";
Date.now = () => now;
const { default: worker } = await import("../../worker/worker.js");
const match = () => ({ id: 900001, utcDate: "2026-10-13T19:00:00Z", status: mode.startsWith("final") ? "FINISHED" : "IN_PLAY",
  homeTeam: "Home", awayTeam: "Away", score: { home: 1, away: 0 }, matchday: 1, stage: "REGULAR_SEASON" });
const players = [1, 2].flatMap(team => Array.from({ length: 11 }, (_, n) => ({ id: team * 100 + n, name: `Player ${team}-${n}`,
  pos: n === 0 ? "G" : n < 5 ? "D" : n < 9 ? "M" : "F", team: team === 1 ? "Home" : "Away" })));
for (const player of players) db.prepare("INSERT INTO fantasy_players (id, name, team, position) VALUES (?, ?, ?, ?)").run(player.id, player.name, player.team, { G: "GK", D: "DEF", M: "MID", F: "FWD" }[player.pos]);
db.exec(`INSERT INTO users (id, google_sub, email, name) VALUES (1, 'test-1', 'one@test.invalid', 'One'), (2, 'test-2', 'two@test.invalid', 'Two');
INSERT INTO fantasy_leagues (id, name, commissioner_user_id, invite_code, draft_status) VALUES (1, 'Replay', 1, 'replay', 'complete');
INSERT INTO fantasy_league_members (league_id, user_id, draft_position) VALUES (1, 1, 1), (1, 2, 2);
INSERT INTO fantasy_h2h_fixtures (league_id, gameweek, home_user_id, away_user_id) VALUES (1, 1, 1, 2);`);
for (const player of players) {
  const user = player.id < 200 ? 1 : 2;
  db.prepare("INSERT INTO fantasy_rosters (league_id, user_id, player_id) VALUES (1, ?, ?)").run(user, player.id);
  db.prepare("INSERT INTO fantasy_lineups (league_id, user_id, gameweek, player_id) VALUES (1, ?, 1, ?)").run(user, player.id);
}
for (let i = 0; i < 120; i++) db.prepare("INSERT INTO fantasy_live_match_points (match_id, gameweek, scores) VALUES (?, 1, '[]')").run(800001 + i);
const detail = () => ({ id: 900001, source: "stored-score-service", competition: "PL", season: "2026", ...match(),
  home: { name: "Home", lineup: players.filter(p => p.id < 200), bench: [] }, away: { name: "Away", lineup: players.filter(p => p.id >= 200), bench: [] },
  goals: [{ scorerId: 109, team: "Home", type: "REGULAR", minute: 12 }], cards: [], subs: [],
  playerStats: players.map(p => ({ playerId: p.id, team: p.team, minutes: mode.startsWith("final") ? 90 : 60, position: p.pos, tackles: 0, blocks: 0, interceptions: 0 })),
  degraded: mode.endsWith("partial") ? ["/fixtures/players"] : [], stale: false,
  coverage: Object.fromEntries(["fixture", "lineups", "events", "players"].map(name => [name, { state: mode.endsWith("partial") && name === "players" ? "partial" : "complete", observedAt: now, ageMs: 0 }])),
  snapshot: { version, collectorEpoch: 1, observedAt: now, detailVersion: version, detailCollectorEpoch: 1 } });
globalThis.fetch = async url => {
  requests.push(String(url));
  if (String(url) === "https://cron-stored.invalid/PL/live") return Response.json(scoreFeed({ competition: "PL", season: "2026", version,
    collectorEpoch: 1, publishedAt: now, scheduleObservedAt: now, fixtures: [{ match: match(), observedAt: now }],
    standings: { rows: [], observedAt: null, delayed: true } }, now));
  if (String(url) === "https://cron-stored.invalid/PL/match/900001") return mode === "outage" ? new Response("offline", { status: 503 }) : Response.json(detail());
  throw Error("Unexpected external request: " + url);
};
const env = { DB: database, VAPID_PRIVATE_JWK: "synthetic-unused", VAPID_PUBLIC_KEY: "synthetic-unused", API_FOOTBALL_COMPETITIONS: "PL:2026", SCORE_READ_ORIGIN: "https://cron-stored.invalid",
  ANALYSIS_CACHE: { async get(key) { kv.push(key); return null; }, async put(key) { kv.push(key); } } };
console.warn = message => warnings.push(message);
async function tick(next) {
  mode = next; now += 1000; version++;
  const pending = []; await worker.scheduled({ cron: "* * * * *" }, env, { waitUntil: promise => pending.push(promise) });
  await Promise.all(pending);
}
const row = sql => db.prepare(sql).get();
try {
  await tick("live");
  assert.ok(row("SELECT signature FROM notify_state WHERE match_id = 900001"), "Keyless notifications did not record a baseline");
  const original = row("SELECT scores FROM fantasy_live_match_points WHERE match_id = 900001")?.scores;
  assert.ok(original, "Complete live detail did not produce provisional scores");
  assert.equal(row("SELECT COUNT(*) AS count FROM fantasy_live_match_points").count, 1, "Obsolete rows were not cleaned in bounded batches");
  for (const state of ["live-partial", "outage", "final-partial"]) {
    await tick(state);
    assert.equal(row("SELECT scores FROM fantasy_live_match_points WHERE match_id = 900001")?.scores, original, `${state} erased or changed provisional points`);
    assert.equal(row("SELECT COUNT(*) AS count FROM fantasy_scored_matches").count, 0, `${state} settled incomplete detail`);
    assert.equal(row("SELECT COUNT(*) AS count FROM fantasy_player_match_scores").count, 0);
  }
  failScoreBatch = true;
  await tick("final");
  assert.equal(injectedFailures, 1);
  assert.equal(row("SELECT COUNT(*) AS count FROM fantasy_player_match_scores").count, 0, "Partial batch escaped rollback");
  assert.equal(row("SELECT COUNT(*) AS count FROM fantasy_scored_matches").count, 0);
  assert.equal(row("SELECT scores FROM fantasy_live_match_points WHERE match_id = 900001").scores, original);
  await tick("final");
  assert.equal(row("SELECT COUNT(*) AS count FROM fantasy_scored_matches").count, 1);
  assert.equal(row("SELECT COUNT(*) AS count FROM fantasy_player_match_scores").count, 22);
  assert.equal(row("SELECT COUNT(*) AS count FROM fantasy_gameweek_scores").count, 2);
  const h2h = row("SELECT home_score, away_score FROM fantasy_h2h_fixtures");
  assert.equal(h2h.home_score, 50); // 22 appearance points + 24 clean-sheet points + 4 for the forward's goal.
  assert.equal(h2h.away_score, 22);
  assert.equal(row("SELECT points FROM fantasy_player_match_scores WHERE player_id = 109").points, 6);
  const settled = db.prepare("SELECT player_id, points, breakdown FROM fantasy_player_match_scores ORDER BY player_id").all();
  await tick("final");
  assert.deepEqual(db.prepare("SELECT player_id, points, breakdown FROM fantasy_player_match_scores ORDER BY player_id").all(), settled);
  assert.equal(row("SELECT COUNT(*) AS count FROM fantasy_live_match_points").count, 0);
  db.exec("INSERT INTO prediction_entries (user_id, match_id, competition, home_goals, away_goals) VALUES (1, 900001, 'PL', 1, 0)");
  await tick("final");
  assert.equal(row("SELECT points FROM prediction_entries WHERE user_id = 1").points, 3);
  assert.equal(row("SELECT exact FROM prediction_entries WHERE user_id = 1").exact, 1);
  assert.equal(row("SELECT home_score FROM fantasy_h2h_fixtures").home_score, 51);
  assert.equal(JSON.parse(row("SELECT signature FROM notify_state WHERE match_id = 900001").signature).status, "FINISHED");
  assert.equal(kv.length, 0, "Stored scoring touched legacy detail KV");
  assert.deepEqual(sqlErrors, []);
  assert.ok(warnings.every(message => message.includes("detail degraded")), "Unexpected cron warning");
  assert.ok(requests.every(url => url.startsWith("https://cron-stored.invalid/")));
  console.log(JSON.stringify({ passed: ["live points", "partial and outage retention", "full-time retention until settlement", "atomic score-batch failure and retry", "22 player scores", "50-22 league and H2H rollup", "idempotent settlement", "post-settlement cleanup", "keyless prediction settlement and +1 fantasy bonus", "keyless notification state without subscribers", "provider credentials absent", "no legacy KV/provider calls"],
    storedReads: requests.length, injectedFailures, warnings, sqlErrors }, null, 2));
} finally { db.close(); }

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, test } from "node:test";

import { XP_BLEND_RETRY_MS, blendXpThrough, resetXpBlendBackoff } from "../worker/xpBlend.js";

// The REAL schema.sql, so a query naming a column that does not exist fails
// here instead of in production (the 31 October 2026 outage, see xpBlend.js).
function d1() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../worker/schema.sql", import.meta.url), "utf8"));
  const prepare = (sql) => {
    let args = [];
    const self = {
      bind: (...values) => { args = values; return self; },
      run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } }),
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
      first: async () => sqlite.prepare(sql).get(...args) ?? null,
    };
    return self;
  };
  return { sqlite, prepare, batch: async (statements) => Promise.all(statements.map((statement) => statement.run())) };
}

let env;
beforeEach(() => {
  resetXpBlendBackoff();
  env = { DB: d1() };
  env.DB.sqlite.exec(`
    INSERT INTO fantasy_players (id, name, team, position) VALUES (1, 'Palmer', 'Chelsea', 'MID'), (2, 'Saka', 'Arsenal', 'MID');
    INSERT INTO fantasy_player_xp (player_id, historical_xp, historical_basis, xp, xp_basis) VALUES (1, 5, 'history', 5, 'history'), (2, 4, 'history', 4, 'history');
  `);
  const insert = env.DB.sqlite.prepare("INSERT INTO fantasy_player_match_scores (match_id, player_id, gameweek, points) VALUES (?, ?, ?, ?)");
  insert.run(100, 1, 1, 10);
  insert.run(101, 1, 2, 2);
});

test("the blend runs against the real schema and records its progress", async () => {
  assert.equal(await blendXpThrough(env, 2, 0), "blended");
  const palmer = env.DB.sqlite.prepare("SELECT xp_basis FROM fantasy_player_xp WHERE player_id = 1").get();
  const saka = env.DB.sqlite.prepare("SELECT xp_basis FROM fantasy_player_xp WHERE player_id = 2").get();
  assert.equal(palmer.xp_basis, "blended");
  assert.equal(saka.xp_basis, "history", "no games yet keeps the prior");
  assert.equal(env.DB.sqlite.prepare("SELECT last_completed_gameweek AS g FROM fantasy_xp_state").get().g, 2);
});

test("once blended, a later tick reads one row and stops", async () => {
  await blendXpThrough(env, 2, 0);
  let aggregates = 0;
  const prepare = env.DB.prepare;
  env.DB.prepare = (sql) => { if (/fantasy_player_match_scores/.test(sql)) aggregates += 1; return prepare(sql); };
  assert.equal(await blendXpThrough(env, 2, 60_000), "skipped");
  assert.equal(aggregates, 0);
});

test("a failure is thrown, then backs off for an hour instead of rescanning every minute", async () => {
  env.DB.sqlite.exec("DROP TABLE fantasy_player_xp");
  await assert.rejects(blendXpThrough(env, 2, 0));
  assert.equal(await blendXpThrough(env, 2, 60_000), "backoff");
  await assert.rejects(blendXpThrough(env, 2, XP_BLEND_RETRY_MS + 1));
});

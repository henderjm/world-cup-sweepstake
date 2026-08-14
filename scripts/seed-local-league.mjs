// Seeds the LOCAL D1 (miniflare) with a signed-in account and a fully played
// league, so every fantasy screen can be opened without Google sign-in and
// without touching production.
//
// This exists because the fantasy section is almost entirely gated behind a
// real session and a league with a completed draft: signed out you can only
// reach the sandbox demo, and production must never be used as a staging
// environment (it holds real managers' leagues). Reading `--help` is faster
// than rediscovering the four moving parts each time.
//
// It writes SQL to stdout. Nothing here connects to anything; the caller pipes
// it into `wrangler d1 execute --local`, which is what makes it impossible for
// this script to reach the production database even by accident. There is no
// flag that targets remote, deliberately.
//
// The league is SEVEN managers, an odd number on purpose: that is the case
// that exercises the Average opponent (src/fantasyAverage.js) and it is the
// shape most likely to be wrong. Gameweeks 1-5 are fully scored, so standings,
// matchups and the schedule all have real numbers, and the current gameweek is
// 6 (set FANTASY_GAMEWEEK_OVERRIDE=6 in worker/.dev.vars to match).
//
// Usage:
//   node scripts/seed-local-league.mjs > /tmp/seed.sql
//   npx wrangler d1 execute squad-goals --local --file /tmp/seed.sql
//
// The session token it mints is printed to stderr (so it never lands in the
// SQL file); paste it into localStorage as `gs-session`.

import { readFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";

import { roundRobinSchedule } from "../src/draftLogic.js";
import { SQUAD_SLOTS, SQUAD_SIZE } from "../src/fantasy.js";
import { rankDraftPool } from "../src/fantasyDraftRank.js";

const ADMIN_EMAIL = process.env.SEED_EMAIL ?? "mark.hender@zellor.com";
const ADMIN_NAME = process.env.SEED_NAME ?? "Mark";
const LEAGUE_NAME = process.env.SEED_LEAGUE ?? "Dry Run FC";
const MANAGERS = Number(process.env.SEED_MANAGERS ?? 7);
const SCORED_THROUGH = Number(process.env.SEED_SCORED_THROUGH ?? 5);

const OPPONENT_NAMES = ["Priya", "Sam", "Dee", "Tunde", "Rosa", "Kit", "Noor", "Alex", "Jo"];

// Deterministic per (manager, gameweek) so re-running the seed produces the
// same league. Math.random would make a screenshot impossible to reproduce.
function scoreFor(managerIndex, gameweek) {
  const noise = Math.sin(managerIndex * 12.9898 + gameweek * 78.233) * 43758.5453;
  return Math.round((35 + (noise - Math.floor(noise)) * 45) * 10) / 10;
}

const sql = (value) => (value == null ? "NULL" : `'${String(value).replace(/'/g, "''")}'`);

// The committed data/PL/players.json is a stale football-data.org-era seed with
// no xP at all (the real pool is baked in CI and restored from the Actions
// cache, never committed - see CLAUDE.md). Drafting off it would produce
// alphabetical squads that look nothing like a real draft, so SEED_POOL points
// at a real pool: `curl -o /tmp/pool.json https://kickoffdraft.com/data/PL/players.json`.
const poolPath = process.env.SEED_POOL
  ? new URL(`file://${process.env.SEED_POOL}`)
  : new URL("../data/PL/players.json", import.meta.url);
const players = JSON.parse(await readFile(poolPath, "utf8")).players;
if (!players.some((player) => player.xp != null)) {
  process.stderr.write(
    "WARNING: this pool carries no xP, so the seeded draft will be alphabetical.\n" +
      "         Pass SEED_POOL=/path/to/a/real/players.json (see the comment above).\n",
  );
}
// Draft off the same board the real room shows, so the seeded squads look like
// squads somebody would actually have drafted rather than an alphabetical slice.
const board = rankDraftPool(players, MANAGERS);

const lines = [];
lines.push("PRAGMA defer_foreign_keys = true;");
lines.push("BEGIN TRANSACTION;");

// -- Accounts ---------------------------------------------------------------
// google_sub is "local:<n>", outside Google's decimal-digit namespace, so
// isRealGoogleSub (src/fantasyBots.js) rejects it and none of these accounts
// can ever be authenticated through the real sign-in route.
const userIds = [];
for (let i = 0; i < MANAGERS; i += 1) {
  const id = 9000 + i;
  userIds.push(id);
  const name = i === 0 ? ADMIN_NAME : OPPONENT_NAMES[(i - 1) % OPPONENT_NAMES.length];
  const email = i === 0 ? ADMIN_EMAIL : `${name.toLowerCase()}@example.test`;
  lines.push(
    `INSERT OR REPLACE INTO users (id, google_sub, email, name, is_bot) VALUES (${id}, ${sql(`local:${id}`)}, ${sql(email)}, ${sql(name)}, 0);`,
  );
}
const adminId = userIds[0];

const token = randomBytes(24).toString("base64url");
const tokenHash = createHash("sha256").update(token).digest("hex");
lines.push(`DELETE FROM sessions WHERE user_id = ${adminId};`);
lines.push(
  `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (${sql(tokenHash)}, ${adminId}, datetime('now', '+30 days'));`,
);

// -- League -----------------------------------------------------------------
const leagueId = 9001;
lines.push(`DELETE FROM fantasy_leagues WHERE id = ${leagueId};`);
lines.push(
  `INSERT INTO fantasy_leagues (id, name, commissioner_user_id, invite_code, draft_status) VALUES (${leagueId}, ${sql(LEAGUE_NAME)}, ${adminId}, ${sql("DRYRUN")}, ${sql("complete")});`,
);
userIds.forEach((userId, index) => {
  lines.push(
    `INSERT OR REPLACE INTO fantasy_league_members (league_id, user_id, draft_position) VALUES (${leagueId}, ${userId}, ${index + 1});`,
  );
});

// -- The draft --------------------------------------------------------------
// A real snake draft driven by the real board: each manager takes the best
// available player whose bucket is not full, which is exactly what autoPick
// now does, so the seeded squads match what the draft room would have produced.
const taken = new Set();
const rosters = new Map(userIds.map((id) => [id, []]));
let overallPick = 0;
for (let round = 1; round <= SQUAD_SIZE; round += 1) {
  const order = round % 2 === 0 ? [...userIds].reverse() : userIds;
  for (const userId of order) {
    const roster = rosters.get(userId);
    const counts = {};
    for (const player of roster) counts[player.position] = (counts[player.position] ?? 0) + 1;
    const pick = board.find(
      (player) => !taken.has(player.id) && (counts[player.position] ?? 0) < SQUAD_SLOTS[player.position],
    );
    if (!pick) throw new Error(`no legal pick for ${userId} in round ${round}`);
    taken.add(pick.id);
    roster.push(pick);
    overallPick += 1;
    lines.push(
      `INSERT OR REPLACE INTO fantasy_players (id, name, team, position) VALUES (${pick.id}, ${sql(pick.name)}, ${sql(pick.team)}, ${sql(pick.position)});`,
    );
    lines.push(
      `INSERT INTO fantasy_draft_picks (league_id, round, pick_in_round, overall_pick, user_id, player_id, via) VALUES (${leagueId}, ${round}, ${(overallPick - 1) % MANAGERS + 1}, ${overallPick}, ${userId}, ${pick.id}, ${sql("manual")});`,
    );
    lines.push(
      `INSERT OR REPLACE INTO fantasy_rosters (league_id, user_id, player_id, acquired_via) VALUES (${leagueId}, ${userId}, ${pick.id}, ${sql("draft")});`,
    );
  }
}

// -- Schedule and scores ----------------------------------------------------
// roundRobinSchedule drops the unpaired manager's pairing for an odd league,
// which is precisely the gap the Average opponent fills at read time. Nothing
// is written for Average here, on purpose: it is derived, never stored.
const fixtures = roundRobinSchedule(userIds, 38);
const scoreOf = new Map();
for (let gameweek = 1; gameweek <= SCORED_THROUGH; gameweek += 1) {
  userIds.forEach((userId, index) => {
    const points = scoreFor(index, gameweek);
    scoreOf.set(`${gameweek}:${userId}`, points);
    lines.push(
      `INSERT OR REPLACE INTO fantasy_gameweek_scores (league_id, user_id, gameweek, points) VALUES (${leagueId}, ${userId}, ${gameweek}, ${points});`,
    );
  });
}
for (const fixture of fixtures) {
  const settled = fixture.gameweek <= SCORED_THROUGH;
  const home = settled ? scoreOf.get(`${fixture.gameweek}:${fixture.homeUserId}`) : null;
  const away = settled ? scoreOf.get(`${fixture.gameweek}:${fixture.awayUserId}`) : null;
  lines.push(
    `INSERT OR REPLACE INTO fantasy_h2h_fixtures (league_id, gameweek, home_user_id, away_user_id, home_score, away_score) VALUES (${leagueId}, ${fixture.gameweek}, ${fixture.homeUserId}, ${fixture.awayUserId}, ${home ?? "NULL"}, ${away ?? "NULL"});`,
  );
}

lines.push("COMMIT;");
process.stdout.write(`${lines.join("\n")}\n`);

process.stderr.write(
  [
    "",
    "Seeded a local league. In the browser devtools console on http://localhost:8731 run:",
    "",
    `  localStorage.setItem('gs-data-api', 'http://127.0.0.1:8787');`,
    `  localStorage.setItem('gs-session', '${token}');`,
    "  location.reload();",
    "",
    `League "${LEAGUE_NAME}" (id ${leagueId}), ${MANAGERS} managers, gameweeks 1-${SCORED_THROUGH} scored.`,
    `Signed in as ${ADMIN_NAME} <${ADMIN_EMAIL}> (user id ${adminId}).`,
    `Set FANTASY_GAMEWEEK_OVERRIDE=${SCORED_THROUGH + 1} in worker/.dev.vars.`,
    "",
  ].join("\n"),
);

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildModel } from "../src/data.js";
import {
  SPORTMONKS_ID_OFFSET, appMatchId, mapSportmonksDetail, mapSportmonksFeed, mapSportmonksMatch, sportmonksIdOf, sportmonksInstant,
} from "../src/sportmonksFeed.js";

// Bologna 2-1 Monza, Serie A, 31 October 2026, and that season's table,
// trimmed from the live API.
const fixture = JSON.parse(readFileSync(new URL("./fixtures/sportmonks-serie-a-ft.json", import.meta.url)));
const standings = JSON.parse(readFileSync(new URL("./fixtures/sportmonks-serie-a-standings.json", import.meta.url)));

test("ids are offset so they can never collide with an API-Football fixture", () => {
  assert.equal(appMatchId(19713526), SPORTMONKS_ID_OFFSET + 19713526);
  assert.equal(sportmonksIdOf(appMatchId(19713526)), 19713526);
  assert.equal(sportmonksIdOf(1557450), null);
});

test("a finished fixture maps to the app's match summary", () => {
  const match = mapSportmonksMatch(fixture);
  assert.equal(match.status, "FINISHED");
  assert.equal(match.homeTeam, "Bologna");
  assert.equal(match.awayTeam, "Monza");
  assert.deepEqual(match.score, { home: 2, away: 1 });
  assert.equal(match.matchday, 10);
  assert.equal(match.utcDate, sportmonksInstant(fixture.starting_at));
  assert.match(match.utcDate, /Z$/);
  assert.equal(match.winner, "HOME_TEAM");
});

test("a match that has not kicked off has no score, never 0-0", () => {
  const match = mapSportmonksMatch({ ...fixture, state: { developer_name: "NS" } });
  assert.equal(match.status, "TIMED");
  assert.deepEqual(match.score, { home: null, away: null });
});

test("live states carry the ticking minute and half-time keeps the HT label code", () => {
  const live = mapSportmonksMatch({ ...fixture, state: { developer_name: "INPLAY_2ND_HALF" }, periods: [{ ticking: true, minutes: 67 }] });
  assert.equal(live.status, "IN_PLAY");
  assert.equal(live.minute, 67);
  const ht = mapSportmonksMatch({ ...fixture, state: { developer_name: "HT" } });
  assert.deepEqual([ht.status, ht.providerStatus], ["PAUSED", "HT"]);
  assert.equal(mapSportmonksMatch({ ...fixture, state: { developer_name: "AWAITING_UPDATES" } }).status, "PAUSED");
});

test("the table maps into the raw shape buildModel already reads", () => {
  const feed = mapSportmonksFeed({ competition: "SA", season: "2026", fixtures: [fixture], standings, lastUpdated: "2026-11-01T12:00:00Z" });
  const model = buildModel(feed);
  const rows = model.tables[0].rows;
  assert.equal(rows.length, 20);
  assert.equal(rows[0].team, "Lazio");
  assert.equal(rows[0].points, 25);
  assert.equal(rows[0].played, 9);
  assert.equal(rows[0].goalDifference, 15);
});

test("detail: goals with a running score, penalties typed, a missed penalty is not a goal", () => {
  const detail = mapSportmonksDetail(fixture);
  assert.deepEqual(detail.goals.map(goal => [goal.minute, goal.team, goal.type, goal.home, goal.away]), [
    [6, "Monza", "PENALTY", 0, 1], [33, "Bologna", "NORMAL", 1, 1], [59, "Bologna", "PENALTY", 2, 1],
  ]);
  assert.equal(detail.goals[1].assist, "Juan Miranda");
  assert.equal(detail.cards.length, 7);
  assert.ok(detail.subs.every(sub => sub.in && sub.out));
});

test("detail: XI on the formation grid, bench apart, ratings where given", () => {
  const detail = mapSportmonksDetail(fixture);
  assert.equal(detail.home.lineup.length, 11);
  assert.ok(detail.home.lineup.every(player => /^\d+:\d+$/.test(player.grid)));
  assert.ok(detail.home.bench.length > 0);
  assert.ok(detail.playerStats.some(player => Number.isFinite(player.rating)));
  assert.equal(detail.referee, "A. Zanotti");
});

test("a VAR-rescinded goal is not counted", () => {
  const goal = fixture.events.find(event => event.type_id === 14);
  const detail = mapSportmonksDetail({ ...fixture, events: fixture.events.map(event => (event === goal ? { ...event, rescinded: true } : event)) });
  assert.equal(detail.goals.length, 2);
});

test("Serie A and La Liga fixtures cannot be predicted until the cron can score them", async () => {
  const { canPredict } = await import("../src/predictions.js");
  const future = { status: "TIMED", utcDate: "2099-01-01T15:00:00Z" };
  assert.equal(canPredict({ ...future, id: 1557450 }), true);
  assert.equal(canPredict({ ...future, id: appMatchId(19713526) }), false);
});

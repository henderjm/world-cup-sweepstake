import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { findSportmonksFixture, mapMatchCentre } from "../src/sportmonks.js";

// Chelsea 2-0 Manchester United, 31 October 2026, trimmed from the live API.
const fixture = JSON.parse(readFileSync(new URL("./fixtures/sportmonks-fixture-ft.json", import.meta.url)));

test("team statistics and xG land on the right side", () => {
  const centre = mapMatchCentre(fixture);
  assert.equal(centre.home, "Chelsea");
  assert.deepEqual(
    [centre.teamStats.home.shots, centre.teamStats.away.shots, centre.teamStats.home.possession, centre.teamStats.home.woodwork],
    [18, 12, 59, 1],
  );
  assert.equal(centre.teamStats.away.xg, 1.1105);
});

test("a statistic Sportmonks did not send is absent, never zero", () => {
  const centre = mapMatchCentre({ ...fixture, xgfixture: [], statistics: fixture.statistics.filter(row => row.type_id !== 64) });
  assert.equal("xg" in centre.teamStats.home, false);
  assert.equal("woodwork" in centre.teamStats.away, false);
});

test("pressure folds both sides into one row per minute", () => {
  const { pressure } = mapMatchCentre(fixture);
  assert.deepEqual(pressure.slice(0, 2), [{ minute: 1, home: 0, away: 0 }, { minute: 2, home: 0, away: 5.74 }]);
  assert.ok(pressure.every((row, i) => i === 0 || row.minute > pressure[i - 1].minute));
});

test("a fixture joins on kickoff date and both canonical club names", () => {
  const match = { utcDate: "2026-10-31T12:30:00Z", homeTeam: "Chelsea", awayTeam: "Man United" };
  assert.equal(findSportmonksFixture([fixture], match)?.id, fixture.id);
  assert.equal(findSportmonksFixture([fixture], { ...match, utcDate: "2026-11-01T12:30:00Z" }), null);
  assert.equal(findSportmonksFixture([fixture], { ...match, homeTeam: "Man United", awayTeam: "Chelsea" }), null);
  assert.equal(findSportmonksFixture([fixture, fixture], match), null, "ambiguous joins are refused");
});

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mapTopscorers, sportmonksLeagueFor } from "../src/sportmonksTopscorers.js";
import { resetSportmonksClient } from "../worker/sportmonksClient.js";
import { leagueStats } from "../worker/sportmonksLeagueStats.js";

const row = (player_id, position, total, name = `P${player_id}`) => ({
  player_id, position, total, type_id: 208,
  player: { display_name: name, image_path: `https://cdn/${player_id}.png` },
  participant: { name: "Manchester City", image_path: "https://cdn/mci.png" },
});

test("league ids cover every competition the app shows", () => {
  assert.equal(sportmonksLeagueFor("PL"), 8);
  assert.equal(sportmonksLeagueFor("CL"), 2);
  assert.equal(sportmonksLeagueFor("SA"), 384);
  assert.equal(sportmonksLeagueFor("PD"), 564);
  assert.equal(sportmonksLeagueFor("XX"), null);
});

test("rows sort by Sportmonks position, cap, and drop rows with no figure or name", () => {
  const rows = mapTopscorers([row(2, 2, 9), row(1, 1, 12, "Erling Haaland"), { player_id: 3, position: 3 }, row(4, 4, 7, "")], 5);
  assert.deepEqual(rows.map(r => r.playerId), [1, 2]);
  assert.equal(rows[0].name, "Erling Haaland");
  assert.equal(rows[0].total, 12);
  assert.ok(rows[0].team, "club name is normalised, not dropped");
  assert.equal(mapTopscorers([row(1, 1, 1), row(2, 2, 1)], 1).length, 1);
  assert.deepEqual(mapTopscorers(null), []);
});

let calls;
function stub({ failType = null } = {}) {
  calls = [];
  globalThis.fetch = async (url) => {
    const path = String(url).replace("https://api.sportmonks.com/v3/football", "");
    calls.push(path);
    if (path.startsWith("/leagues/8")) return new Response(JSON.stringify({ data: { currentseason: { id: 28083 } }, rate_limit: { remaining: 2000 } }));
    const type = Number(path.match(/seasonTopscorerTypes:(\d+)/)?.[1]);
    if (type === failType) return new Response("{}", { status: 500 });
    return new Response(JSON.stringify({ data: type === 84 ? [] : [row(1, 1, 10), row(2, 2, 8)], rate_limit: { remaining: 2000 } }));
  };
}

beforeEach(() => resetSportmonksClient());

test("leaderboards come from the current season, and an empty or failed one is left out", async () => {
  stub({ failType: 209 });
  const stats = await leagueStats({ SPORTMONKS_API_KEY: "k" }, "PL");
  assert.equal(stats.available, true);
  assert.equal(stats.seasonId, 28083);
  assert.deepEqual(stats.categories.map(c => c.key), ["goals"]);
  assert.ok(calls.every(path => !path.includes("/topscorers/") || path.includes("/seasons/28083")));
});

test("a competition the app does not cover spends nothing", async () => {
  stub();
  assert.deepEqual(await leagueStats({ SPORTMONKS_API_KEY: "k" }, "XX"), { available: false });
  assert.equal(calls.length, 0);
});

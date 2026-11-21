import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { resetSportmonksClient } from "../worker/sportmonksClient.js";
import { playerSeason } from "../worker/sportmonksPlayers.js";

const env = { SPORTMONKS_API_KEY: "test-key" };
let calls;
function stub() {
  calls = [];
  globalThis.fetch = async (url) => {
    const path = String(url).replace("https://api.sportmonks.com/v3/football", "");
    calls.push(path);
    const season = { 8: 28083, 2: 28000, 384: 27895, 564: 27965 }[path.match(/^\/leagues\/(\d+)/)?.[1]];
    const data = season ? { currentseason: { id: season } } : {
      display_name: "Cole Palmer", image_path: "https://cdn/p.png", position: { name: "Midfielder" },
      statistics: [
        { details: [{ type_id: 119, value: { total: 120 } }, { type_id: 52, value: { total: 1 } }] },
        { details: [{ type_id: 119, value: { total: 790 } }, { type_id: 52, value: { total: 3 } }, { type_id: 118, value: { average: 7.38 } }] },
      ],
    };
    return new Response(JSON.stringify({ data, rate_limit: { remaining: 2400, resets_in_seconds: 900 } }));
  };
}

beforeEach(() => resetSportmonksClient());

test("a covered season returns the player's figures for the club he played most for", async () => {
  stub();
  const season = await playerSeason(env, 28912747, 28083);
  assert.equal(season.available, true);
  assert.equal(season.name, "Cole Palmer");
  assert.deepEqual(season.stats, { 119: 790, 52: 3, 118: 7.38 });
});

test("a season the app does not cover spends no player call", async () => {
  stub();
  assert.deepEqual(await playerSeason(env, 28912747, 1), { available: false });
  assert.ok(!calls.some(path => path.startsWith("/players/")));
});

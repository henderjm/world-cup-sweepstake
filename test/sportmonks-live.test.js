import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resetSportmonksClient } from "../worker/sportmonksClient.js";
import { findSportmonksMatch, getSportmonksLive, sportmonksMatchDetail } from "../worker/sportmonksLive.js";
import { appMatchId } from "../src/sportmonksFeed.js";

const finished = JSON.parse(readFileSync(new URL("./fixtures/sportmonks-serie-a-ft.json", import.meta.url)));
const standings = JSON.parse(readFileSync(new URL("./fixtures/sportmonks-serie-a-standings.json", import.meta.url)));
const env = { SPORTMONKS_API_KEY: "test-key" };
const NOW = Date.parse("2026-11-01T15:00:00Z");

let calls;
function stub({ upcoming = null, live = [], season = [], seasonFails = false } = {}) {
  calls = [];
  globalThis.fetch = async (url, init) => {
    const path = String(url).replace("https://api.sportmonks.com/v3/football", "");
    calls.push(path);
    assert.equal(init.headers.Authorization, "test-key");
    let data = null;
    let pagination = { has_more: false };
    if (path.startsWith("/leagues/")) data = { id: 384, currentseason: { id: 27895, name: "2026/2027" } };
    else if (path.startsWith("/fixtures/between/")) data = [finished, ...(upcoming ? [upcoming] : [])];
    else if (path.startsWith("/livescores/inplay")) data = live;
    else if (path.startsWith("/fixtures?filters=fixtureSeasons:")) {
      if (seasonFails) return new Response("{}", { status: 500 });
      data = season;
    }
    else if (path.startsWith("/standings/")) data = standings;
    else if (path.startsWith("/fixtures/")) data = finished;
    return new Response(JSON.stringify({ data, pagination, rate_limit: { remaining: 2400, resets_in_seconds: 900, requested_entity: "Fixture" } }));
  };
}

beforeEach(() => resetSportmonksClient());

test("a quiet day builds the feed without reading the in-play list", async () => {
  stub();
  const feed = await getSportmonksLive(env, "SA", NOW);
  assert.equal(feed.competition, "SA");
  assert.equal(feed.season, "2026");
  assert.equal(feed.matches[0].homeTeam, "Bologna");
  assert.equal(feed.standings[0].table.length, 20);
  assert.ok(!calls.some(path => path.startsWith("/livescores/")));
});

test("a match on now is refreshed from the in-play list", async () => {
  const kickoff = "2026-11-01 14:00:00";
  const upcoming = { ...finished, id: 999, starting_at: kickoff, state: { developer_name: "NS" } };
  const inPlay = { ...upcoming, state: { developer_name: "INPLAY_2ND_HALF" }, periods: [{ ticking: true, minutes: 58 }] };
  stub({ upcoming, live: [inPlay] });
  const feed = await getSportmonksLive(env, "SA", NOW);
  const match = feed.matches.find(entry => entry.id === appMatchId(999));
  assert.deepEqual([match.status, match.minute], ["IN_PLAY", 58]);
  assert.ok(calls.some(path => path.startsWith("/livescores/inplay")));
});

test("repeat reads inside the window cost nothing", async () => {
  stub();
  await getSportmonksLive(env, "SA", NOW);
  const first = calls.length;
  await getSportmonksLive(env, "SA", NOW + 60_000);
  assert.equal(calls.length, first);
});

test("an offset id finds its match and its detail", async () => {
  stub();
  const match = await findSportmonksMatch(env, appMatchId(finished.id), NOW);
  assert.equal(match.competition, "SA");
  const detail = await sportmonksMatchDetail(env, match, NOW);
  assert.equal(detail.goals.length, 3);
  assert.equal(await findSportmonksMatch(env, 1557450, NOW), null, "an API-Football id is never looked up here");
});

test("the whole season is in the feed, with the window's newer copy winning", async () => {
  const later = { ...finished, id: 4242, starting_at: "2027-05-23 18:45:00", state: { developer_name: "NS" } };
  const staleCopy = { ...finished, state: { developer_name: "NS" } };
  stub({ season: [staleCopy, later] });
  const feed = await getSportmonksLive(env, "SA", NOW);
  assert.ok(feed.matches.some(entry => entry.id === appMatchId(4242)), "a fixture months out comes from the season list");
  const known = feed.matches.filter(entry => entry.id === appMatchId(finished.id));
  assert.equal(known.length, 1, "one row per fixture");
  assert.equal(known[0].status, "FINISHED", "the window's copy beats the season's");
});

test("a failed season read falls back to the window", async () => {
  stub({ seasonFails: true });
  const feed = await getSportmonksLive(env, "SA", NOW);
  assert.equal(feed.matches[0].homeTeam, "Bologna");
});

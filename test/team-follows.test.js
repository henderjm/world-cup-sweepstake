import assert from "node:assert/strict";
import test from "node:test";
import { createLocalFollows, followedMatches, uniqueFollows } from "../src/teamFollows.js";
import { readScoreRoute, scoreRouteHash } from "../src/scoreDates.js";
import { renderScoresHome, renderScoreFollowButton } from "../src/views.js";

const memoryStorage = () => {
  let saved = null;
  return { getItem: () => saved, setItem: (_key, value) => { saved = value; } };
};

test("device follows persist and remove using the existing exact competition/team keys", () => {
  const storage = memoryStorage();
  const follows = createLocalFollows(() => storage);
  follows.set("PL", "Man United", true);
  follows.set("CL", "Man United", true);
  follows.set("PL", "Man United", true);
  const reloaded = createLocalFollows(() => storage);
  assert.deepEqual(reloaded.all(), [{ competition: "CL", team: "Man United" }, { competition: "PL", team: "Man United" }]);
  reloaded.set("PL", "Man United", false);
  assert.deepEqual(reloaded.all(), [{ competition: "CL", team: "Man United" }]);
});

test("blocked storage retains choices for the visit and reports that they are not persistent", () => {
  const follows = createLocalFollows(() => { throw Error("blocked"); });
  follows.set("PL", "Arsenal", true);
  assert.equal(follows.all().length, 1);
  assert.equal(follows.persistent, false);
  follows.reload();
  assert.equal(follows.all().length, 1);
});

test("malformed saved data and duplicate or unsupported follows cannot break the app", () => {
  const follows = createLocalFollows(() => ({ getItem: () => "{broken", setItem() {} }));
  assert.deepEqual(follows.all(), []);
  assert.deepEqual(uniqueFollows([null, { competition: "toString", team: "Bad" }, { competition: "PL", team: {} },
    { competition: "PL", team: " Arsenal " }, { competition: "PL", team: "Arsenal" }, { competition: "PL", team: "Arsenal" }]),
  [{ competition: "PL", team: "Arsenal" }]);
});

test("the local follow limit preserves existing choices and allows unfollowing at the limit", () => {
  const follows = createLocalFollows(memoryStorage);
  for (let i = 0; i < 50; i++) follows.set("PL", `Team ${i}`, true);
  assert.throws(() => follows.set("PL", "Extra", true), /50 teams/);
  assert.equal(follows.all().length, 50);
  follows.set("PL", "Team 0", false);
  assert.equal(follows.all().length, 49);
});

test("Following includes home and away fixtures once, keeping competition identity", () => {
  const feed = { competition: { code: "PL" }, matches: [
    { id: 1, homeTeam: "Arsenal", awayTeam: "Everton" }, { id: 2, homeTeam: "Everton", awayTeam: "Arsenal" },
    { id: 3, homeTeam: "Chelsea", awayTeam: "Spurs" },
  ] };
  const follows = [{ competition: "PL", team: "Arsenal" }, { competition: "PL", team: "Everton" }];
  assert.deepEqual(followedMatches(feed, follows).map(match => match.id), [1, 2]);
  assert.deepEqual(followedMatches({ ...feed, competition: { code: "CL" } }, follows), []);
});

test("Following survives date, competition and tab routes", () => {
  const route = readScoreRoute(scoreRouteHash("2026-09-10", true, "CL", "live", true));
  assert.equal(route.followingOnly, true);
  assert.equal(route.competition, "CL");
  assert.equal(route.date, "2026-09-10");
});

test("empty Following view explains how to choose teams and escapes team labels", () => {
  const html = renderScoresHome([], { follows: [], followingOnly: true });
  assert.match(html, /Choose teams to see their matches/);
  assert.match(html, /aria-pressed="true"/);
  const button = renderScoreFollowButton("PL", '<img src=x onerror="bad()">', []);
  assert.doesNotMatch(button, /<img src=x/);
  assert.match(button, /&lt;img/);
});

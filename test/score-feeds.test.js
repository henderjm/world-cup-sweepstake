import assert from "node:assert/strict";
import test from "node:test";
import { createScoreFeeds, combinedScoreModel } from "../src/scoreFeeds.js";
import { renderScoresHome } from "../src/views.js";
import { readScoreRoute, scoreRouteHash } from "../src/scoreDates.js";

const feed = (code, score = 1, lastUpdated = "2026-09-10T19:10:00Z") => ({
  competition: { code, shortName: code }, hasData: true, lastUpdated,
  matches: [{ id: code === "PL" ? 1 : 2, homeTeam: "Home", awayTeam: "Away", utcDate: "2026-09-10T19:00Z", status: "IN_PLAY", score: { home: score, away: 0 } }],
});

test("a held PL request cannot block CL and repeated refreshes share one request", async () => {
  let release;
  let calls = 0;
  const scores = createScoreFeeds(code => { calls++; return code === "PL" ? new Promise(resolve => { release = resolve; }) : feed(code); });
  const held = scores.refresh("PL");
  assert.equal(scores.refresh("PL"), held);
  await scores.refresh("CL");
  assert.equal(scores.get("CL").matches.length, 1);
  assert.equal(scores.get("PL").loading, true);
  assert.equal(calls, 2);
  release(feed("PL"));
  await held;
});

test("failed, empty and older snapshots retain the last scores and original age; newer corrections apply", async () => {
  let next = feed("CL");
  const scores = createScoreFeeds(() => next);
  const good = await scores.refresh("CL");
  for (next of [{ error: "offline" }, { hasData: false }, feed("CL", 0, "2026-09-10T19:00Z")]) {
    const kept = await scores.refresh("CL");
    assert.deepEqual(kept.matches, good.matches);
    assert.equal(kept.fetchedAt, good.fetchedAt);
    assert.equal(kept.stale, true);
  }
  next = feed("CL", 0, "2026-09-10T19:11Z");
  const corrected = await scores.refresh("CL");
  assert.equal(corrected.matches[0].score.home, 0);
  assert.ok(!corrected.stale);
});

test("unexpected failures are scoped to the competition and can recover", async () => {
  let fail = true;
  const scores = createScoreFeeds(code => { if (code === "PL" && fail) throw Error("bad payload"); return feed(code); });
  await Promise.all([scores.refresh("PL"), scores.refresh("CL")]);
  assert.ok(scores.get("PL").error);
  assert.ok(scores.get("CL").hasData);
  fail = false;
  await scores.refresh("PL");
  assert.ok(!scores.get("PL").error);
});

test("combined drawer matches carry their own competition without combining league tables", () => {
  const model = combinedScoreModel([feed("PL"), feed("CL")]);
  assert.deepEqual(model.matches.map(match => match.competitionCode), ["PL", "CL"]);
  assert.equal(model.tables, undefined);
});

test("overview puts matches before quiet leagues and retains per-league loading and errors", () => {
  const html = renderScoresHome([{ ...feed("PL"), matches: [] }, feed("CL")], { date: "2026-09-10" });
  assert.ok(html.indexOf('data-score-league="CL"') < html.indexOf('data-score-league="PL"'));
  assert.equal((html.match(/data-score-date/g) ?? []).length, 1);
  const finishedPL = { ...feed("PL"), matches: feed("PL").matches.map(match => ({ ...match, status: "FINISHED" })) };
  const mixed = renderScoresHome([finishedPL, feed("CL")], { date: "2026-09-10" });
  assert.ok(mixed.indexOf('data-score-league="CL"') < mixed.indexOf('data-score-league="PL"'), "Live CL should appear before finished PL matches");
  const loading = renderScoresHome([{ ...feed("PL"), loading: true }, { ...feed("CL"), error: "offline" }]);
  assert.match(loading, /Loading matches/);
  assert.match(loading, /data-score-feed-retry="CL"/);
});

test("league-scoped dates survive reload routes and unknown competition codes fall back to all", () => {
  assert.deepEqual(readScoreRoute(scoreRouteHash("2026-09-10", true, "CL")), { tab: "live", date: "2026-09-10", liveOnly: true, competition: "CL" });
  for (const code of ["unsupported", "toString", "__proto__"]) assert.equal(readScoreRoute(`live?competition=${code}`).competition, null);
  assert.equal(readScoreRoute(scoreRouteHash(null, false, "CL", "tables")).tab, "tables");
});

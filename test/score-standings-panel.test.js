import assert from "node:assert/strict";
import test from "node:test";
import { renderScoresTable, renderMiniTable } from "../src/views.js";

const feed = (code, matches = []) => ({ competition: { code, shortName: code === "CL" ? "Champions League" : "Premier League" },
  hasData: true, matches, tables: [{ rows: [{ position: 1, team: `${code} Home`, played: 1, points: 3 }] }] });
const fixture = (date, status = "FINISHED") => ({ utcDate: `${date}T19:00Z`, homeTeam: "CL Home", awayTeam: "CL Away", status });

test("overview selects the competition with matches on the chosen date and honours an explicit choice", () => {
  const feeds = [feed("PL"), feed("CL", [fixture("2026-09-10")])];
  assert.match(renderScoresTable(feeds, { date: "2026-09-10" }), /data-standings-competition="CL"/);
  assert.match(renderScoresTable(feeds, { date: "2026-09-10", tableCompetition: "PL" }), /data-standings-competition="PL"/);
  assert.match(renderScoresTable(feeds, { date: "2026-09-11" }), /data-standings-competition="PL"/);
});

test("default table selection respects Following and live filters", () => {
  const feeds = [feed("PL", [fixture("2026-09-10", "IN_PLAY")]), feed("CL", [fixture("2026-09-10")])];
  const options = { date: "2026-09-10", followingOnly: true, follows: [{ competition: "CL", team: "CL Home" }] };
  assert.match(renderScoresTable(feeds, options), /data-standings-competition="CL"/);
  assert.match(renderScoresTable(feeds, { date: "2026-09-10", liveOnly: true }), /data-standings-competition="PL"/);
});

test("standings expose labelled columns, an explicit league, played counts and a correctly scoped full-table action", () => {
  const html = renderScoresTable([feed("PL"), feed("CL")], { tableCompetition: "CL" });
  assert.match(html, /<select data-standings-selector>/);
  assert.match(html, /<table class="mini-table" aria-label="Champions League standings">/);
  assert.match(html, /scope="col" aria-label="Played"/);
  assert.match(html, /class="minirow__played">1</);
  assert.match(html, /data-score-table="CL"/);
});

test("loading, missing tables and failed feeds have distinct states; delayed tables retain known rows", () => {
  assert.match(renderMiniTable({ ...feed("CL"), loading: true }), /Loading standings/);
  assert.match(renderMiniTable({ ...feed("CL"), tables: [] }), /No standings published yet/);
  const failed = renderMiniTable({ ...feed("CL"), error: "offline", tables: [] });
  assert.match(failed, /Standings unavailable/);
  assert.match(failed, /data-score-feed-retry="CL"/);
  const delayed = renderMiniTable({ ...feed("CL"), stale: true, tablesLive: true });
  assert.match(delayed, /Standings updates delayed/);
  assert.match(delayed, /CL Home/);
  assert.match(delayed, /As it stands, including live matches/);
  assert.match(delayed, /data-feed-age="CL"/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { renderSignedIn } from "../src/views.js";
import { competitionFor } from "../src/competitions.js";

const feed = (code, teams) => ({
  competition: competitionFor(code), loading: false,
  matches: [{ homeTeam: teams[0], awayTeam: teams[1] }], tables: [],
});

test("You offers clubs from every competition, each chip carrying its competition", () => {
  const account = { user: { name: "Mark", email: "m@example.com", prefs: {} }, follows: [{ competition: "SA", team: "Inter" }] };
  const isFollowed = (comp, team) => account.follows.some(f => f.competition === comp && f.team === team);
  const html = renderSignedIn([feed("PL", ["Arsenal", "Chelsea"]), feed("SA", ["Inter", "Milan"])], account, isFollowed);
  assert.match(html, /data-follow-team="Arsenal" data-follow-competition="PL"/);
  assert.match(html, /data-follow-team="Milan" data-follow-competition="SA"/);
  assert.match(html, /data-follow-team="Inter" data-follow-competition="SA" aria-pressed="true"/);
  assert.match(html, /Name me on The Wire/);
});

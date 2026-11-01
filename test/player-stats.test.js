import { test } from "node:test";
import assert from "node:assert/strict";
import { compactDetails, matchHeadline, matchStatGroups, seasonStatRows } from "../src/playerStats.js";

test("season objects compact to one number per type", () => {
  assert.deepEqual(compactDetails([
    { type_id: 52, value: { total: 3, goals: 2, penalties: 1 } },
    { type_id: 118, value: { average: 7.38, highest: 9.06 } },
    { type_id: 40, data: { value: true } },
  ]), { 52: 3, 118: 7.38 });
});

test("match rows show only what was sent, with made/attempted pairs", () => {
  const groups = matchStatGroups({ 52: 1, 5304: 0.3204, 42: 6, 86: 3, 116: 64, 80: 72 });
  assert.deepEqual(groups.map(group => group.title), ["Attack", "Passing"]);
  assert.deepEqual(groups[0].rows, [
    { label: "Goals", value: "1" }, { label: "xG", value: "0.32" }, { label: "Shots on target", value: "3/6 (50%)" },
  ]);
  assert.deepEqual(groups[1].rows, [{ label: "Passes", value: "64/72 (89%)" }]);
  assert.deepEqual(matchStatGroups({}), []);
});

test("goalkeeping rows only for a keeper", () => {
  assert.equal(matchStatGroups({ 57: 3 }).length, 0);
  assert.equal(matchStatGroups({ 57: 3 }, { keeper: true })[0].title, "Goalkeeping");
  assert.ok(!seasonStatRows({ 194: 2 }).length);
  assert.deepEqual(seasonStatRows({ 194: 2 }, { keeper: true }), [{ label: "Clean sheets", value: "2" }]);
});

test("the headline is rating and minutes, null when not sent", () => {
  assert.deepEqual(matchHeadline({ 118: 8.05, 119: 90 }), { rating: 8.05, minutes: 90 });
  assert.deepEqual(matchHeadline({}), { rating: null, minutes: null });
});

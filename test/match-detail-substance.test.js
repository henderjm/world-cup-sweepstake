import test from "node:test";
import assert from "node:assert/strict";

import {
  DETAIL_SECTION_COUNT,
  detailHasSubstance,
  detailSubstanceScore,
  fillDetailSections,
} from "../src/matchDetailSubstance.js";

const player = (name) => ({ id: 1, name, pos: "G", num: 1, grid: "1:1" });

function fullDetail() {
  return {
    id: 42,
    status: "FINISHED",
    score: { home: 3, away: 0, htHome: 2, htAway: 0, penHome: null, penAway: null },
    home: { name: "Brentford", crest: "b.png", formation: "4-3-3", coach: "Coach A", lineup: [player("A")], bench: [player("B")] },
    away: { name: "Tottenham", crest: "t.png", formation: "4-2-3-1", coach: "Coach B", lineup: [player("C")], bench: [player("D")] },
    goals: [{ minute: 10 }],
    cards: [{ minute: 30 }],
    subs: [{ minute: 60 }],
    referee: "M Oliver",
    attendance: 17000,
    playerStats: [{ id: 9, name: "A" }],
  };
}

// The players-only shape is upstream's per-endpoint soft throttle: real player
// stats, empty lineups and events, nothing flagged degraded.
function playersOnlyDetail() {
  const detail = fullDetail();
  return {
    ...detail,
    score: { ...detail.score, htHome: null, htAway: null },
    home: { name: "Brentford", crest: "b.png", formation: null, coach: null, lineup: [], bench: [] },
    away: { name: "Tottenham", crest: "t.png", formation: null, coach: null, lineup: [], bench: [] },
    goals: [],
    cards: [],
    subs: [],
    referee: null,
    attendance: null,
    playerStats: [{ id: 99, name: "fresher stats" }],
  };
}

test("substance score counts the three sections independently", () => {
  assert.equal(detailSubstanceScore(null), 0);
  assert.equal(detailSubstanceScore({}), 0);
  assert.equal(detailSubstanceScore(fullDetail()), DETAIL_SECTION_COUNT);
  assert.equal(detailSubstanceScore(playersOnlyDetail()), 1);
  assert.equal(detailSubstanceScore({ home: { lineup: [player("A")] } }), 1);
  assert.equal(detailSubstanceScore({ away: { lineup: [player("A")] } }), 1);
  // one timeline: goals, cards and subs are a single section however they mix
  assert.equal(detailSubstanceScore({ goals: [{}], cards: [{}], subs: [{}] }), 1);
  assert.equal(detailSubstanceScore({ subs: [{}] }), 1);
});

test("detailHasSubstance matches the score, so the Worker guard and the browser agree", () => {
  assert.equal(detailHasSubstance(null), false);
  assert.equal(detailHasSubstance({ goals: [], cards: [], subs: [], playerStats: [] }), false);
  assert.equal(detailHasSubstance({ cards: [{}] }), true);
  assert.equal(detailHasSubstance(playersOnlyDetail()), true);
});

test("a players-only Worker read fills its missing sections from the bake", () => {
  const primary = playersOnlyDetail();
  const merged = fillDetailSections(primary, fullDetail());
  assert.equal(detailSubstanceScore(merged), DETAIL_SECTION_COUNT);
  // filled sections come from the fallback, whole
  assert.equal(merged.home.lineup.length, 1);
  assert.equal(merged.home.formation, "4-3-3");
  assert.equal(merged.away.coach, "Coach B");
  assert.equal(merged.goals.length, 1);
  assert.equal(merged.subs.length, 1);
  // the primary keeps every section it actually had
  assert.equal(merged.playerStats[0].name, "fresher stats");
  // immutable-once-known scalars fill too
  assert.equal(merged.referee, "M Oliver");
  assert.equal(merged.attendance, 17000);
  assert.equal(merged.score.htHome, 2);
  // identity fields stay the primary's
  assert.equal(merged.home.name, "Brentford");
  assert.equal(merged.home.crest, "b.png");
});

test("a non-empty primary section is never replaced, even by a longer fallback", () => {
  const primary = { ...fullDetail(), goals: [{ minute: 10 }], cards: [], subs: [] };
  const fallback = { ...fullDetail(), goals: [{ minute: 10 }, { minute: 80 }] };
  const merged = fillDetailSections(primary, fallback);
  assert.equal(merged.goals.length, 1); // the primary is the fresher read
});

test("fillDetailSections tolerates a missing side on either input", () => {
  const primary = fillDetailSections({ id: 1, playerStats: [{}] }, fullDetail());
  assert.equal(primary.home.lineup.length, 1);
  const noop = fillDetailSections(fullDetail(), { id: 1 });
  assert.equal(noop.home.lineup.length, 1);
});

test("a null input falls through to the other", () => {
  const full = fullDetail();
  assert.equal(fillDetailSections(null, full), full);
  assert.equal(fillDetailSections(full, null), full);
  assert.equal(fillDetailSections(null, null), null);
});

test("neither input is mutated", () => {
  const primary = playersOnlyDetail();
  const fallback = fullDetail();
  const primarySnapshot = JSON.stringify(primary);
  const fallbackSnapshot = JSON.stringify(fallback);
  fillDetailSections(primary, fallback);
  assert.equal(JSON.stringify(primary), primarySnapshot);
  assert.equal(JSON.stringify(fallback), fallbackSnapshot);
});

for (const missing of ['home', 'away']) {
  test(`a missing ${missing} lineup recovers independently without replacing the other team's fresh selection`, () => {
    const primary = fullDetail();
    const fallback = fullDetail();
    const available = missing === 'home' ? 'away' : 'home';
    primary[missing] = { name: primary[missing].name, crest: 'current.png', lineup: [], bench: [] };
    primary[available] = { ...primary[available], lineup: [player('Fresh starter')], bench: [player('Fresh bench')], coach: 'Fresh coach', formation: '3-5-2' };
    fallback[missing].name = 'Older provider spelling';
    const before = JSON.stringify({ primary, fallback });
    const merged = fillDetailSections(primary, fallback);
    assert.equal(merged[available], primary[available]);
    assert.deepEqual(merged[missing].lineup, fallback[missing].lineup);
    assert.deepEqual(merged[missing].bench, fallback[missing].bench);
    assert.equal(merged[missing].formation, fallback[missing].formation);
    assert.equal(merged[missing].coach, fallback[missing].coach);
    assert.equal(merged[missing].name, primary[missing].name);
    assert.equal(merged[missing].crest, 'current.png');
    assert.equal(JSON.stringify({ primary, fallback }), before);
  });
}

test('recovering an absent side also recovers its team identity', () => {
  const fallback = fullDetail();
  const merged = fillDetailSections({ home: fallback.home }, fallback);
  assert.equal(merged.away.name, 'Tottenham');
  assert.equal(merged.away.crest, 't.png');
  assert.deepEqual(merged.away.lineup, fallback.away.lineup);
});

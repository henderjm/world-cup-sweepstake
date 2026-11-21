import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_LOOKBACK_MS,
  MAX_LOOKBACK_MS,
  RESULT_GRACE_MS,
  briefingPref,
  briefingSince,
  clubResults,
  d1TimeToIso,
  fantasyPreview,
  fantasyResult,
  hasNews,
  headlines,
  managerForm,
  previewBriefing,
  settledSince,
  shouldLand,
  topAndFlop,
} from "../src/briefing.js";

const NOW = Date.parse("2026-11-22T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const match = (id, home, away, status, kickoff, score = [null, null]) => ({
  id, homeTeam: home, awayTeam: away, status, utcDate: iso(kickoff), score: { home: score[0], away: score[1] },
});

test("briefingSince: never briefed looks back the default window", () => {
  assert.equal(briefingSince(null, NOW), NOW - DEFAULT_LOOKBACK_MS);
  assert.equal(briefingSince("garbage", NOW), NOW - DEFAULT_LOOKBACK_MS);
});

test("briefingSince: a future stamp is not trusted, an ancient one is clamped", () => {
  assert.equal(briefingSince(iso(NOW + HOUR), NOW), NOW - DEFAULT_LOOKBACK_MS);
  assert.equal(briefingSince("2020-01-01T00:00:00Z", NOW), NOW - MAX_LOOKBACK_MS);
  assert.equal(briefingSince(iso(NOW - 3 * HOUR), NOW), NOW - 3 * HOUR);
});

test("d1TimeToIso reads D1's zoneless datetime as UTC", () => {
  assert.equal(d1TimeToIso("2026-11-21 18:30:00"), "2026-11-21T18:30:00Z");
  assert.equal(d1TimeToIso(null), null);
});

test("clubResults: only followed, finished matches inside the window, newest first", () => {
  const since = NOW - 24 * HOUR;
  const feeds = [{
    competition: "PL",
    matches: [
      match(1, "Arsenal", "Spurs", "FINISHED", NOW - 20 * HOUR, [2, 1]),
      match(2, "Chelsea", "Arsenal", "FINISHED", NOW - 5 * HOUR, [0, 0]),
      match(3, "Arsenal", "Everton", "FINISHED", NOW - 48 * HOUR, [1, 0]), // before the window
      match(4, "Liverpool", "Man City", "FINISHED", NOW - 6 * HOUR, [0, 3]), // not followed
      match(5, "Arsenal", "Fulham", "IN_PLAY", NOW - HOUR, [1, 0]), // not finished
    ],
  }];
  const rows = clubResults({ feeds, follows: [{ competition: "PL", team: "Arsenal" }], since });
  assert.deepEqual(rows.map((row) => row.matchId), [2, 1]);
});

test("clubResults: a match that kicked off just before the last visit still counts", () => {
  const since = NOW - 10 * HOUR;
  const feeds = [{ competition: "PL", matches: [match(1, "Arsenal", "Spurs", "FINISHED", since - RESULT_GRACE_MS + 1, [2, 1])] }];
  assert.equal(clubResults({ feeds, follows: [{ competition: "PL", team: "Arsenal" }], since }).length, 1);
});

test("headlines: followed first, then most goals, and counts live matches", () => {
  const since = NOW - 24 * HOUR;
  const feeds = [
    { competition: "PL", matches: [
      match(1, "Liverpool", "Man City", "FINISHED", NOW - 6 * HOUR, [0, 3]),
      match(2, "Arsenal", "Spurs", "FINISHED", NOW - 7 * HOUR, [0, 0]),
      match(3, "Wolves", "Fulham", "IN_PLAY", NOW - HOUR, [0, 0]),
    ] },
    { competition: "SA", matches: [match(4, "Napoli", "Roma", "FINISHED", NOW - 8 * HOUR, [4, 3])] },
  ];
  const result = headlines({ feeds, follows: [{ competition: "PL", team: "Arsenal" }], since });
  assert.equal(result.live, 1);
  assert.deepEqual(result.results.map((row) => row.matchId), [2, 4, 1]);
  assert.equal(result.results[0].followed, true);
});

const members = [
  { userId: 1, name: "Me" },
  { userId: 2, name: "Dan" },
  { userId: 3, name: "Sam" },
  { userId: 4, name: "Bot Ada", isBot: true },
];
const fixtures = [
  { gameweek: 1, homeUserId: 1, awayUserId: 2, homeScore: 40, awayScore: 50 },
  { gameweek: 1, homeUserId: 3, awayUserId: 4, homeScore: 60, awayScore: 30 },
  { gameweek: 2, homeUserId: 1, awayUserId: 3, homeScore: 70, awayScore: 20 },
  { gameweek: 2, homeUserId: 2, awayUserId: 4, homeScore: 45, awayScore: 44 },
  { gameweek: 3, homeUserId: 4, awayUserId: 1, homeScore: null, awayScore: null },
  { gameweek: 3, homeUserId: 2, awayUserId: 3, homeScore: null, awayScore: null },
];

test("fantasyResult: result, score, opponent and rank movement", () => {
  const result = fantasyResult({ fixtures, members, userId: 1, gameweek: 2 });
  assert.equal(result.result, "W");
  assert.deepEqual(result.score, { mine: 70, theirs: 20 });
  assert.equal(result.opponent.name, "Sam");
  assert.equal(result.rank.before, 3);
  assert.equal(result.rank.after, 2);
});

test("fantasyResult: an unsettled gameweek has no result", () => {
  assert.equal(fantasyResult({ fixtures, members, userId: 1, gameweek: 3 }), null);
});

test("topAndFlop: highest and lowest starter, no flop when only one scored", () => {
  const players = [
    { playerId: 1, name: "Haaland", points: 14 },
    { playerId: 2, name: "Rice", points: 2, isCaptain: true },
    { playerId: 3, name: "Saka", points: 6 },
  ];
  const { top, flop } = topAndFlop(players);
  assert.equal(top.name, "Haaland");
  assert.equal(flop.name, "Rice");
  assert.equal(flop.isCaptain, true);
  assert.deepEqual(topAndFlop([{ playerId: 1, name: "A", points: 3 }]).flop, null);
  assert.deepEqual(topAndFlop([]), { top: null, flop: null });
});

test("managerForm: newest settled results first, unsettled skipped", () => {
  assert.deepEqual(managerForm(fixtures, 2, 3), ["W", "W"]);
  assert.deepEqual(managerForm(fixtures, 4, 4), ["L", "L"]);
});

test("fantasyPreview: opponent with form, blank starters and double clubs", () => {
  const preview = fantasyPreview({
    fixtures,
    members,
    userId: 1,
    gameweek: 3,
    deadline: "2026-11-22T13:30:00.000Z",
    starters: [
      { playerId: 10, name: "Mitoma", team: "Brighton" },
      { playerId: 11, name: "Palmer", team: "Chelsea" },
    ],
    roster: [
      { playerId: 10, name: "Mitoma", team: "Brighton" },
      { playerId: 11, name: "Palmer", team: "Chelsea" },
      { playerId: 12, name: "James", team: "Chelsea" },
    ],
    clubCounts: new Map([["Chelsea", 2], ["Brighton", 0]]),
  });
  assert.equal(preview.opponent.name, "Bot Ada");
  assert.equal(preview.opponent.isBot, true);
  assert.deepEqual(preview.opponent.form, ["L", "L"]);
  assert.deepEqual(preview.blankStarters.map((player) => player.name), ["Mitoma"]);
  assert.deepEqual(preview.doubleTeams, ["Chelsea"]);
});

test("fantasyPreview: an unreadable feed reports no blanks rather than every starter as blank", () => {
  const preview = fantasyPreview({ fixtures, members, userId: 1, gameweek: 3, starters: [{ playerId: 1, name: "A", team: "X" }] });
  assert.deepEqual(preview.blankStarters, []);
  assert.deepEqual(preview.doubleTeams, []);
});

test("hasNews: a followed club's result or a newly settled fantasy result lands you on Home", () => {
  assert.equal(hasNews({ clubs: [{ matchId: 1 }], fantasy: [] }), true);
  assert.equal(hasNews({ clubs: [], fantasy: [{ last: { isNew: true } }] }), true);
});

test("hasNews: an already-seen fantasy result, headlines or live games alone do not", () => {
  assert.equal(hasNews({ clubs: [], fantasy: [{ last: { isNew: false } }, { last: null }], headlines: { live: 3, results: [{ matchId: 9 }] } }), false);
  assert.equal(hasNews(null), false);
});

test("settledSince: a gameweek ending after the last visit is new, one ending well before is not", () => {
  const since = NOW - 24 * HOUR;
  assert.equal(settledSince(NOW - 2 * HOUR, since), true);
  assert.equal(settledSince(since - RESULT_GRACE_MS + 1, since), true);
  assert.equal(settledSince(NOW - 72 * HOUR, since), false);
  assert.equal(settledSince(null, since), false);
});

test("shouldLand: news lands you unless landing is switched off; a missing pref reads as on", () => {
  const news = { clubs: [{ matchId: 1 }], fantasy: [] };
  assert.equal(shouldLand(news, {}), true);
  assert.equal(shouldLand(news, { homeLanding: false }), false);
  assert.equal(shouldLand({ clubs: [], fantasy: [] }, {}), false);
  assert.equal(briefingPref(undefined, "clubs"), true);
  assert.equal(briefingPref({ homeClubs: false }, "clubs"), false);
});

test("previewBriefing: real results from the polled feeds, sample fantasy, never lands", () => {
  const matches = [
    { ...match(1, "Arsenal", "Spurs", "FINISHED", NOW - 20 * HOUR, [2, 1]), competitionCode: "PL" },
    { ...match(2, "Napoli", "Roma", "FINISHED", NOW - 30 * HOUR, [4, 3]), competitionCode: "SA" },
    { ...match(3, "Wolves", "Fulham", "IN_PLAY", NOW - HOUR, [0, 0]), competitionCode: "PL" },
  ];
  const preview = previewBriefing({ matches, follows: [{ competition: "PL", team: "Arsenal" }], now: NOW });
  assert.equal(preview.sample, true);
  assert.deepEqual(preview.clubs.map((row) => row.matchId), [1]);
  assert.equal(preview.headlines.live, 1);
  assert.deepEqual(preview.headlines.results.map((row) => row.matchId), [1, 2]);
  assert.equal(preview.fantasy.length, 1);
});

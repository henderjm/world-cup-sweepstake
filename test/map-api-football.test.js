import assert from "node:assert/strict";
import test from "node:test";

import { COMPETITIONS } from "../src/competitions.js";
import {
  mapApiFootballMatchDetail,
  mapApiFootballMatches,
  mapApiFootballStandings,
  matchesInTrackingWindow,
} from "../src/mapApiFootball.js";

test("maps an API-Football fixture into the app match contract", () => {
  const [match] = mapApiFootballMatches({
    response: [
      {
        fixture: {
          id: 123,
          date: "2026-08-15T14:00:00+00:00",
          status: { short: "1H", elapsed: 37 },
          venue: { name: "Emirates Stadium", city: "London" },
        },
        league: { round: "Regular Season - 1" },
        teams: {
          home: { name: "Arsenal", logo: "home.png" },
          away: { name: "Liverpool", logo: "away.png" },
        },
        goals: { home: 1, away: 0 },
        score: { penalty: { home: null, away: null } },
      },
    ],
  });

  assert.deepEqual(match, {
    id: 123,
    utcDate: "2026-08-15T14:00:00+00:00",
    status: "IN_PLAY",
    minute: 37,
    stage: "REGULAR_SEASON",
    group: null,
    matchday: 1,
    venue: "Emirates Stadium",
    city: "London",
    mapUrl: "https://www.google.com/maps/search/?api=1&query=Emirates%20Stadium%2C%20London",
    homeTeam: "Arsenal",
    awayTeam: "Liverpool",
    homeCrest: "home.png",
    awayCrest: "away.png",
    homeTla: null,
    awayTla: null,
    score: { home: 1, away: 0 },
    penalties: null,
    winner: "HOME_TEAM",
  });
});

test("translates every documented API-Football status into the app vocabulary", () => {
  const expected = {
    TBD: "TIMED",
    NS: "TIMED",
    "1H": "IN_PLAY",
    "2H": "IN_PLAY",
    LIVE: "IN_PLAY",
    HT: "PAUSED",
    ET: "EXTRA_TIME",
    BT: "BREAK",
    P: "PENALTY_SHOOTOUT",
    FT: "FINISHED",
    AET: "FINISHED",
    PEN: "FINISHED",
    SUSP: "PAUSED",
    INT: "PAUSED",
    PST: "POSTPONED",
    CANC: "CANCELLED",
    ABD: "CANCELLED",
    AWD: "AWARDED",
    WO: "AWARDED",
  };
  const response = Object.keys(expected).map((short, index) => ({
    fixture: { id: index, status: { short } },
    teams: { home: { name: "Home" }, away: { name: "Away" } },
    goals: { home: null, away: null },
  }));

  assert.deepEqual(
    mapApiFootballMatches({ response }).map((match) => match.status),
    Object.values(expected),
  );
});

test("maps API-Football standings into the app standings contract", () => {
  const zones = [{ from: 1, to: 1, tone: "safe", label: "Champions" }];
  const rows = mapApiFootballStandings(
    {
      response: [
        {
          league: {
            standings: [
              [
                {
                  rank: 1,
                  team: { name: "Arsenal", logo: "arsenal.png" },
                  points: 9,
                  goalsDiff: 6,
                  group: "Premier League",
                  all: { played: 3, win: 3, draw: 0, lose: 0, goals: { for: 8, against: 2 } },
                },
              ],
            ],
          },
        },
      ],
    },
    zones,
  );

  assert.deepEqual(rows.get("Arsenal"), {
    team: "Arsenal",
    group: "Premier League",
    position: 1,
    points: 9,
    played: 3,
    won: 3,
    drawn: 0,
    lost: 0,
    goalsFor: 8,
    goalsAgainst: 2,
    goalDifference: 6,
    crest: "arsenal.png",
    tla: null,
    zone: zones[0],
  });
});

test("merges API-Football fixture, lineup, event and player-stat responses", () => {
  const detail = mapApiFootballMatchDetail(
    {
      response: [
        {
          fixture: {
            id: 123,
            date: "2026-08-15T14:00:00+00:00",
            referee: "Referee Name",
            status: { short: "FT", elapsed: 90 },
            venue: { name: "Emirates Stadium", city: "London" },
          },
          league: { round: "Regular Season - 1" },
          teams: { home: { id: 1, name: "Arsenal", logo: "a.png" }, away: { id: 2, name: "Liverpool", logo: "l.png" } },
          goals: { home: 1, away: 0 },
          score: { halftime: { home: 0, away: 0 }, penalty: { home: null, away: null } },
        },
      ],
    },
    {
      response: [
        { team: { id: 1, name: "Arsenal", logo: "a.png" }, formation: "4-3-3", coach: { name: "Coach A" }, startXI: [{ player: { id: 10, name: "Player A", number: 7, pos: "F" } }], substitutes: [] },
        { team: { id: 2, name: "Liverpool", logo: "l.png" }, formation: "4-2-3-1", coach: { name: "Coach B" }, startXI: [{ player: { id: 20, name: "Player B", number: 1, pos: "G" } }], substitutes: [] },
      ],
    },
    {
      response: [
        { time: { elapsed: 20 }, team: { id: 1, name: "Arsenal" }, player: { id: 10, name: "Player A" }, assist: { id: 11, name: "Helper" }, type: "Goal", detail: "Normal Goal" },
        { time: { elapsed: 40 }, team: { id: 2, name: "Liverpool" }, player: { id: 20, name: "Player B" }, type: "Card", detail: "Yellow Card" },
        { time: { elapsed: 70 }, team: { id: 2, name: "Liverpool" }, player: { id: 20, name: "Player B" }, type: "Card", detail: "Yellow Card" },
        { time: { elapsed: 70 }, team: { id: 2, name: "Liverpool" }, player: { id: 20, name: "Player B" }, type: "Card", detail: "Red Card" },
      ],
    },
    {
      response: [
        { team: { id: 1 }, players: [{ player: { id: 10, name: "Player A" }, statistics: [{ games: { minutes: 90, position: "F" }, tackles: { total: 2, blocks: 0, interceptions: 1 } }] }] },
      ],
    },
  );

  assert.equal(detail.status, "FINISHED");
  assert.equal(detail.home.formation, "4-3-3");
  assert.deepEqual(detail.goals[0], { minute: 20, injuryTime: null, type: "REGULAR", team: "Arsenal", scorerId: 10, scorer: "Player A", assistId: 11, assist: "Helper", home: 1, away: 0 });
  assert.deepEqual(detail.cards.map((card) => card.card), ["YELLOW", "YELLOW_RED"]);
  assert.deepEqual(detail.playerStats[0], { playerId: 10, player: "Player A", team: "Arsenal", minutes: 90, position: "F", tackles: 2, blocks: 0, interceptions: 1 });
});

test("competition config resolves internal codes to API-Football league ids", () => {
  assert.equal(COMPETITIONS.PL.apiFootballLeagueId, 39);
  assert.equal(COMPETITIONS.CL.apiFootballLeagueId, 2);
});

test("translates API-Football cup rounds and group labels", () => {
  const response = [
    "Group A - 2",
    "League Stage - 4",
    "1st Qualifying Round",
    "2nd Qualifying Round",
    "3rd Qualifying Round",
    "Play-offs",
    "Knockout Round Play-offs",
    "Round of 16",
    "Quarter-finals",
    "Semi-finals",
    "Final",
  ].map(
    (round, id) => ({
      fixture: { id, status: { short: "NS" } },
      league: { round },
      teams: { home: { name: "Home" }, away: { name: "Away" } },
      goals: { home: null, away: null },
    }),
  );
  const matches = mapApiFootballMatches({ response });
  assert.deepEqual(
    matches.map(({ stage, group, matchday }) => ({ stage, group, matchday })),
    [
      { stage: "GROUP_STAGE", group: "GROUP_A", matchday: 2 },
      { stage: "LEAGUE_STAGE", group: null, matchday: 4 },
      { stage: "FIRST_QUALIFYING_ROUND", group: null, matchday: null },
      { stage: "SECOND_QUALIFYING_ROUND", group: null, matchday: null },
      { stage: "THIRD_QUALIFYING_ROUND", group: null, matchday: null },
      { stage: "PLAYOFFS", group: null, matchday: null },
      { stage: "PLAYOFF_ROUND", group: null, matchday: null },
      { stage: "ROUND_OF_16", group: null, matchday: null },
      { stage: "QUARTER_FINALS", group: null, matchday: null },
      { stage: "SEMI_FINALS", group: null, matchday: null },
      { stage: "FINAL", group: null, matchday: null },
    ],
  );
});

test("keeps API-Football match goals separate from shootout penalties", () => {
  const [match] = mapApiFootballMatches({
    response: [
      {
        fixture: { id: 1208413, status: { short: "PEN", elapsed: 120 } },
        league: { round: "1st Qualifying Round" },
        teams: {
          home: { name: "Ballkani", winner: false },
          away: { name: "UE Santa Coloma", winner: true },
        },
        goals: { home: 1, away: 2 },
        score: { penalty: { home: 5, away: 6 } },
      },
    ],
  });
  assert.deepEqual(match.score, { home: 1, away: 2 });
  assert.deepEqual(match.penalties, { home: 5, away: 6 });
  assert.equal(match.winner, "AWAY_TEAM");
});

test("normalizes API-Football club names to the existing app join keys", () => {
  const [match] = mapApiFootballMatches({
    response: [
      {
        fixture: { status: { short: "NS" } },
        teams: { home: { name: "Manchester United" }, away: { name: "Nottingham Forest" } },
        goals: { home: null, away: null },
      },
    ],
  });
  assert.equal(match.homeTeam, "Man United");
  assert.equal(match.awayTeam, "Nottingham");
});

test("opens upstream polling only around tracked fixture kickoffs", () => {
  const now = Date.parse("2026-08-15T14:00:00Z");
  const matches = [
    { id: 1, utcDate: "2026-08-15T13:00:00Z" },
    { id: 2, utcDate: "2026-08-15T20:30:01Z" },
    { id: 3, utcDate: "2026-08-15T07:59:59Z" },
  ];
  assert.deepEqual(matchesInTrackingWindow(matches, now).map((match) => match.id), [1]);
});

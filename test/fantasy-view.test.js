import assert from "node:assert/strict";
import test from "node:test";

import {
  renderFantasyComplete,
  renderFantasyDraftRoom,
  renderFantasyLeagueHeader,
  renderFantasyLeagueList,
  renderFantasyLobby,
  renderFantasyMyTeamPanel,
  renderFantasyPlayerRows,
  renderFantasySessionExpired,
} from "../src/fantasyView.js";

test("renderFantasyLeagueList escapes a league name containing HTML", () => {
  const html = renderFantasyLeagueList(
    [{ id: 1, name: "<script>alert(1)</script>", draftStatus: "pending", memberCount: 3, isCommissioner: true }],
    {},
  );
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /data-fantasy-league="1"/);
  assert.match(html, /You're commissioner/);
});

test("renderFantasyLeagueList surfaces a create-form error message, escaped", () => {
  const html = renderFantasyLeagueList([{ id: 1, name: "Test League", draftStatus: "drafting", memberCount: 4 }], {
    createError: `bad "name" <here>`,
  });
  assert.match(html, /bad &quot;name&quot; &lt;here&gt;/);
});

function pooledPlayer(id, position, name = `Player ${id}`, team = "Test FC") {
  return { id, name, team, position };
}

test("renderFantasyPlayerRows shows a Draft button only for a legal pick on my turn", () => {
  const players = [pooledPlayer(1, "MID"), pooledPlayer(2, "MID")];
  const html = renderFantasyPlayerRows(players, { position: "All", search: "" }, {
    isMyTurn: true,
    myRoster: [],
    draftedIds: new Set(),
  });
  assert.match(html, /data-fantasy-draft-player="1"/);
  assert.match(html, /data-fantasy-draft-player="2"/);
});

test("renderFantasyPlayerRows hides the Draft button when it is not my turn", () => {
  const players = [pooledPlayer(1, "MID")];
  const html = renderFantasyPlayerRows(players, { position: "All", search: "" }, {
    isMyTurn: false,
    myRoster: [],
    draftedIds: new Set(),
  });
  assert.doesNotMatch(html, /data-fantasy-draft-player/);
});

test("renderFantasyPlayerRows marks an already-drafted player instead of offering a Draft button", () => {
  const players = [pooledPlayer(1, "MID")];
  const html = renderFantasyPlayerRows(players, { position: "All", search: "" }, {
    isMyTurn: true,
    myRoster: [],
    draftedIds: new Set([1]),
  });
  assert.doesNotMatch(html, /data-fantasy-draft-player/);
  assert.match(html, /Drafted/);
});

test("renderFantasyPlayerRows filters by position and search text", () => {
  const players = [pooledPlayer(1, "GK", "Alisson", "Liverpool"), pooledPlayer(2, "FWD", "Haaland", "Man City")];
  const gkOnly = renderFantasyPlayerRows(players, { position: "GK", search: "" }, {
    isMyTurn: true,
    myRoster: [],
    draftedIds: new Set(),
  });
  assert.match(gkOnly, /Alisson/);
  assert.doesNotMatch(gkOnly, /Haaland/);

  const searched = renderFantasyPlayerRows(players, { position: "All", search: "haaland" }, {
    isMyTurn: true,
    myRoster: [],
    draftedIds: new Set(),
  });
  assert.match(searched, /Haaland/);
  assert.doesNotMatch(searched, /Alisson/);
});

test("renderFantasyPlayerRows filters by club", () => {
  const players = [pooledPlayer(1, "GK", "Alisson", "Liverpool"), pooledPlayer(2, "FWD", "Haaland", "Man City")];
  const liverpoolOnly = renderFantasyPlayerRows(players, { position: "All", club: "Liverpool", search: "" }, {
    isMyTurn: true,
    myRoster: [],
    draftedIds: new Set(),
  });
  assert.match(liverpoolOnly, /Alisson/);
  assert.doesNotMatch(liverpoolOnly, /Haaland/);
});

test("renderFantasyPlayerRows badges only the suggested player", () => {
  const context = { isMyTurn: true, myRoster: [], draftedIds: new Set(), suggestedId: 2 };
  const suggestedRow = renderFantasyPlayerRows([pooledPlayer(2, "MID")], { position: "All", search: "" }, context);
  const otherRow = renderFantasyPlayerRows([pooledPlayer(1, "MID")], { position: "All", search: "" }, context);
  assert.match(suggestedRow, /Suggested/);
  assert.doesNotMatch(otherRow, /Suggested/);
});

test("renderFantasyPlayerRows escapes player name and team", () => {
  const players = [pooledPlayer(1, "MID", `<b>Bad</b>`, `<i>Club</i>`)];
  const html = renderFantasyPlayerRows(players, { position: "All", search: "" }, {
    isMyTurn: true,
    myRoster: [],
    draftedIds: new Set(),
  });
  assert.doesNotMatch(html, /<b>Bad<\/b>/);
  assert.match(html, /&lt;b&gt;Bad&lt;\/b&gt;/);
});

test("renderFantasySessionExpired points at the You section rather than offering a Retry", () => {
  const html = renderFantasySessionExpired();
  assert.match(html, /session expired/i);
  assert.match(html, /data-section-nav="you"/);
  assert.doesNotMatch(html, /data-fantasy-retry/);
});

const members = [
  { userId: 1, name: "Alice" },
  { userId: 2, name: "Bob" },
];
const league = { id: 1, name: "Test League" };

function draftRoomFixture(overrides = {}) {
  return {
    status: "drafting",
    memberIds: [1, 2],
    overallPick: 2,
    totalPicks: 30,
    onClockUserId: 2,
    round: 1,
    pickInRound: 2,
    picks: [],
    rosters: { 1: [], 2: [] },
    remainingMs: 42000,
    ...overrides,
  };
}

test("renderFantasyDraftRoom shows a dismissable notice for draft.lastError", () => {
  const html = renderFantasyDraftRoom({
    league,
    members,
    draft: draftRoomFixture({ lastError: "player already drafted" }),
    playerPool: [],
    filter: { position: "All", search: "" },
    myUserId: 2,
  });
  assert.match(html, /player already drafted/);
  assert.match(html, /data-fantasy-dismiss-error/);
});

test("renderFantasyDraftRoom shows no error notice when draft.lastError is unset", () => {
  const html = renderFantasyDraftRoom({
    league,
    members,
    draft: draftRoomFixture(),
    playerPool: [],
    filter: { position: "All", search: "" },
    myUserId: 2,
  });
  assert.doesNotMatch(html, /data-fantasy-dismiss-error/);
});

test("renderFantasyDraftRoom shows a neutral clock label and no Draft buttons during the pick-to-clock gap", () => {
  const html = renderFantasyDraftRoom({
    league,
    members,
    draft: draftRoomFixture({ onClockUserId: null }),
    playerPool: [pooledPlayer(1, "MID")],
    filter: { position: "All", search: "" },
    myUserId: 2,
  });
  assert.match(html, /Next pick/);
  assert.doesNotMatch(html, /data-fantasy-draft-player/);
});

// -- renderFantasyLobby: pre-draft scouting -------------------------------------

function lobbyLeague(overrides = {}) {
  return { id: 1, name: "Test League", commissionerUserId: 1, isCommissioner: true, inviteCode: "AB12CD34", ...overrides };
}
const lobbyMembers = [{ userId: 1, name: "Alice", draftPosition: null }];

test("renderFantasyLobby shows scouting rows with no Draft buttons and no players marked drafted", () => {
  const pool = { source: "test", lastUpdated: "2026-07-01T00:00:00Z", complete: true, players: [pooledPlayer(1, "GK"), pooledPlayer(2, "FWD")] };
  const html = renderFantasyLobby(lobbyLeague(), lobbyMembers, { playerPool: pool, filter: { position: "All", search: "" } });
  assert.match(html, /Player pool/);
  assert.match(html, /Player 1/);
  assert.match(html, /Player 2/);
  assert.doesNotMatch(html, /data-fantasy-draft-player/);
  assert.doesNotMatch(html, /Drafted/);
});

test("renderFantasyLobby shows the loading note before the pool has arrived", () => {
  const html = renderFantasyLobby(lobbyLeague(), lobbyMembers, { playerPool: null, filter: { position: "All", search: "" } });
  assert.match(html, /Loading player pool/);
});

test("renderFantasyLobby shows the accumulating hint and the updated date for an incomplete pool", () => {
  const pool = { source: "test", lastUpdated: "2026-07-01T12:00:00Z", complete: false, players: [pooledPlayer(1, "MID")] };
  const html = renderFantasyLobby(lobbyLeague(), lobbyMembers, { playerPool: pool, filter: { position: "All", search: "" } });
  assert.match(html, /Squads updated/);
  assert.match(html, /still accumulating from match lineups/);
});

test("renderFantasyLobby shows a quiet not-available note when the pool file is absent", () => {
  const pool = { players: [], complete: false, lastUpdated: null, unavailable: true };
  const html = renderFantasyLobby(lobbyLeague(), lobbyMembers, { playerPool: pool, filter: { position: "All", search: "" } });
  assert.match(html, /Player pool not available yet/);
  assert.doesNotMatch(html, /data-fantasy-search/);
});

test("renderFantasyLobby also treats a genuinely empty (non-unavailable) pool as not-available rather than an empty list", () => {
  const pool = { players: [], complete: true, lastUpdated: "2026-07-01T00:00:00Z" };
  const html = renderFantasyLobby(lobbyLeague(), lobbyMembers, { playerPool: pool, filter: { position: "All", search: "" } });
  assert.match(html, /Player pool not available yet/);
});

// -- League header + sub-tabs ----------------------------------------------------

test("renderFantasyLeagueHeader shows the purple eyebrow, the active sub-tab's title, and the chip row", () => {
  const html = renderFantasyLeagueHeader({ name: "Goon Squad League" }, members, "draftroom");
  assert.match(html, /Goon Squad League · H2H/);
  assert.match(html, /Draft room/);
  assert.match(html, /2 managers/);
  assert.match(html, /Snake draft/);
});

test("renderFantasyLeagueHeader marks the active sub-tab and leaves Matchup/Standings disabled", () => {
  const html = renderFantasyLeagueHeader({ name: "Test League" }, members, "myteam");
  const myTeamButton = html.match(/<button class="fantasy-subtab[^"]*" type="button" data-fantasy-subtab="myteam">/)[0];
  assert.match(myTeamButton, /is-active/);
  const matchupButton = html.match(/<button class="fantasy-subtab[^>]*>Matchup/)[0];
  assert.match(matchupButton, /disabled/);
  assert.match(html, /Soon/);
});

test("renderFantasyLeagueHeader escapes the league name", () => {
  const html = renderFantasyLeagueHeader({ name: `<script>alert(1)</script>` }, members, "draftroom");
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
});

// -- My team panel and the R.PP squad rows ---------------------------------------

function pick(overallPick, round, pickInRound, userId, player) {
  return { overallPick, round, pickInRound, userId, player };
}

test("renderFantasyMyTeamPanel nudges toward the Draft room before the caller has any picks", () => {
  const html = renderFantasyMyTeamPanel([], 1);
  assert.match(html, /haven't drafted anyone yet/);
  assert.match(html, /Draft room/);
});

test("renderFantasyMyTeamPanel shows R\\.PP pick numbers and a bucket meter once the caller has picks", () => {
  const picks = [
    pick(1, 1, 1, 1, pooledPlayer(10, "FWD", "Erling Haaland", "Man City")),
    pick(16, 2, 8, 1, pooledPlayer(11, "MID", "Bukayo Saka", "Arsenal")),
    pick(20, 2, 4, 2, pooledPlayer(12, "GK", "Someone Else", "Chelsea")), // another manager's pick
  ];
  const html = renderFantasyMyTeamPanel(picks, 1);
  assert.match(html, /1\.01/);
  assert.match(html, /2\.08/);
  assert.match(html, /Erling Haaland/);
  assert.match(html, /Bukayo Saka/);
  assert.doesNotMatch(html, /Someone Else/);
  assert.match(html, /GK <strong>0\/2<\/strong>/);
  assert.match(html, /FWD <strong>1\/3<\/strong>/);
});

// -- Draft complete ----------------------------------------------------------------

test("renderFantasyComplete groups picks by manager with R.PP numbers and escapes manager names", () => {
  const completeMembers = [
    { userId: 1, name: "Alice" },
    { userId: 2, name: `<b>Bob</b>` },
  ];
  const picks = [
    pick(1, 1, 1, 1, pooledPlayer(1, "GK", "Alisson", "Liverpool")),
    pick(2, 1, 2, 2, pooledPlayer(2, "FWD", "Haaland", "Man City")),
  ];
  const html = renderFantasyComplete(completeMembers, picks);
  assert.match(html, /Alice/);
  assert.doesNotMatch(html, /<b>Bob<\/b>/);
  assert.match(html, /&lt;b&gt;Bob&lt;\/b&gt;/);
  assert.match(html, /1\.01/);
  assert.match(html, /1\.02/);
  assert.match(html, /Alisson/);
  assert.match(html, /Haaland/);
});

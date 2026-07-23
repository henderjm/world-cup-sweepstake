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
  renderFantasyRosterPanel,
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

test("renderFantasyPlayerRows badges only the suggested player with a PICK chip and a tinted row", () => {
  const context = { isMyTurn: true, myRoster: [], draftedIds: new Set(), suggestedId: 2 };
  const suggestedRow = renderFantasyPlayerRows([pooledPlayer(2, "MID")], { position: "All", search: "" }, context);
  const otherRow = renderFantasyPlayerRows([pooledPlayer(1, "MID")], { position: "All", search: "" }, context);
  assert.match(suggestedRow, /class="chip fantasy-chip--suggested">Pick</);
  assert.match(suggestedRow, /is-suggested/);
  assert.doesNotMatch(otherRow, /fantasy-chip--suggested/);
  assert.doesNotMatch(otherRow, /is-suggested/);
});

test("renderFantasyPlayerRows renders a dim placeholder bullet for missing AVG/FORM/xP/ADP rather than a fake number", () => {
  const html = renderFantasyPlayerRows([pooledPlayer(1, "MID")], { position: "All", search: "" }, {
    isMyTurn: false,
    myRoster: [],
    draftedIds: new Set(),
  });
  // No avg/form/xp/adp fields on this synthetic player: every stat cell is the
  // dim placeholder, never a fabricated number.
  const placeholderCount = (html.match(/fantasy-stat--empty/g) ?? []).length;
  assert.equal(placeholderCount, 4);
});

test("renderFantasyPlayerRows renders real AVG/xP/ADP numbers and a sparkline when the pool file has them", () => {
  const withStats = { id: 1, name: "Player 1", team: "Test FC", position: "MID", avg: 5.9, xp: 7.8, adp: 19, form: [4, 7, 3, 9, 6] };
  const html = renderFantasyPlayerRows([withStats], { position: "All", search: "" }, {
    isMyTurn: false,
    myRoster: [],
    draftedIds: new Set(),
  });
  assert.match(html, />5\.9</);
  assert.match(html, />7\.8</);
  assert.match(html, />19</);
  assert.match(html, /fantasy-sparkline__bar/);
  assert.doesNotMatch(html, /fantasy-stat--empty/);
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

test("renderFantasyDraftRoom puts the Round/Pick headline and the manager chip strip in the same row", () => {
  const html = renderFantasyDraftRoom({
    league,
    members,
    draft: draftRoomFixture(),
    playerPool: [],
    filter: { position: "All", search: "" },
    myUserId: 2,
  });
  const statusCard = html.match(/<section class="card fantasy-draftstatus">[\s\S]*?<\/section>/)[0];
  assert.match(statusCard, /Round 1 · Pick 2/);
  assert.match(statusCard, /fantasy-orderstrip/);
  assert.match(statusCard, /Alice/);
  assert.match(statusCard, /Bob/);
  // The countdown itself no longer lives in the status card.
  assert.doesNotMatch(statusCard, /data-fantasy-clock/);
});

test("renderFantasyDraftRoom's On the clock card names the manager and shows the countdown, separate from the status card", () => {
  const html = renderFantasyDraftRoom({
    league,
    members,
    draft: draftRoomFixture({ onClockUserId: 1, remainingMs: 27000 }),
    playerPool: [],
    filter: { position: "All", search: "" },
    myUserId: 2,
  });
  const onClockCard = html.match(/<section class="card fantasy-onclock[\s\S]*?<\/section>/)?.[0] ?? "";
  assert.match(onClockCard, /On the clock/);
  assert.match(onClockCard, /Alice/); // userId 1
  assert.match(onClockCard, /data-fantasy-clock[^>]*>0:27/);
  assert.match(onClockCard, /Alice is picking/);
});

test("On the clock card says 'You're on the clock.' when it is the caller's turn", () => {
  const html = renderFantasyDraftRoom({
    league,
    members,
    draft: draftRoomFixture({ onClockUserId: 2 }),
    playerPool: [],
    filter: { position: "All", search: "" },
    myUserId: 2,
  });
  const onClockCard = html.match(/<section class="card fantasy-onclock[\s\S]*?<\/section>/)[0];
  assert.match(onClockCard, /You're on the clock\./);
  assert.match(onClockCard, /is-mine/);
});

test("On the clock card tells a waiting manager which upcoming pick in this round is theirs", () => {
  // 3 members, round 1 order [10, 20, 30]; user 30 (myUserId) is 2 picks after
  // user 10 who is currently on the clock.
  const html = renderFantasyDraftRoom({
    league,
    members: [
      { userId: 10, name: "First" },
      { userId: 20, name: "Second" },
      { userId: 30, name: "Third" },
    ],
    draft: draftRoomFixture({ memberIds: [10, 20, 30], onClockUserId: 10, round: 1, overallPick: 1 }),
    playerPool: [],
    filter: { position: "All", search: "" },
    myUserId: 30,
  });
  const onClockCard = html.match(/<section class="card fantasy-onclock[\s\S]*?<\/section>/)[0];
  assert.match(onClockCard, /First is picking\. You pick 2nd in this round\./);
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

// -- renderFantasyRosterPanel (My team pitch view, draftStatus: complete) ----------

// GK1, DEF4, MID4, FWD2 starting XI (11) with one bench player per position (4).
function rosterFixture() {
  return [
    pooledPlayer(1, "GK", "Keeper One"),
    pooledPlayer(2, "DEF", "Defender One"),
    pooledPlayer(3, "DEF", "Defender Two"),
    pooledPlayer(4, "DEF", "Defender Three"),
    pooledPlayer(5, "DEF", "Defender Four"),
    pooledPlayer(6, "MID", "Midfielder One"),
    pooledPlayer(7, "MID", "Midfielder Two"),
    pooledPlayer(8, "MID", "Midfielder Three"),
    pooledPlayer(9, "MID", "Midfielder Four"),
    pooledPlayer(10, "FWD", "Forward One"),
    pooledPlayer(11, "FWD", "Forward Two"),
    pooledPlayer(12, "GK", "Bench Keeper"),
    pooledPlayer(13, "DEF", "Bench Defender"),
    pooledPlayer(14, "MID", "Bench Midfielder"),
    pooledPlayer(15, "FWD", "Bench Forward"),
  ];
}

const ROSTER_STARTERS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const ROSTER_BENCH = [12, 13, 14, 15];

function baseLineup(overrides = {}) {
  return {
    gameweek: 5,
    source: "set",
    starters: ROSTER_STARTERS.map((playerId) => ({ playerId, isCaptain: playerId === 10 })),
    bench: ROSTER_BENCH,
    ...overrides,
  };
}

// Pulls out one player tile's own class list so a dimmed/pending assertion
// can't accidentally match a class living on some other tile in the page.
function tileClasses(html, playerId) {
  const match = html.match(new RegExp(`<div class="([^"]*)" data-fantasy-player-id="${playerId}"`));
  return match ? match[1] : null;
}

test("renderFantasyRosterPanel lays out all 11 starters and 4 bench players with the right slots and captain badge", () => {
  const html = renderFantasyRosterPanel({
    currentGameweek: 5,
    roster: rosterFixture(),
    lineup: baseLineup(),
    playerPool: [],
    picks: [],
    editState: null,
    drawerPlayerId: null,
    lineupError: "",
  });

  for (const id of ROSTER_STARTERS) {
    assert.match(html, new RegExp(`data-fantasy-player-id="${id}" data-fantasy-slot="starter"`));
  }
  for (const id of ROSTER_BENCH) {
    assert.match(html, new RegExp(`data-fantasy-player-id="${id}" data-fantasy-slot="bench"`));
  }
  assert.match(html, /Gameweek 5/);
  // Exactly one captain badge, on player 10.
  assert.equal((html.match(/fantasy-pitch__capbadge/g) ?? []).length, 1);
  assert.ok(tileClasses(html, 10), "the captain's own tile renders");
  assert.doesNotMatch(html, /data-fantasy-make-captain/); // no affordance without an edit in progress
});

test("renderFantasyRosterPanel shows a real xP value for a player the pool has stats for, a placeholder otherwise", () => {
  const html = renderFantasyRosterPanel({
    currentGameweek: 5,
    roster: rosterFixture(),
    lineup: baseLineup(),
    playerPool: [{ id: 10, name: "Forward One", team: "Test FC", position: "FWD", xp: 8.4 }],
    picks: [],
    editState: null,
    drawerPlayerId: null,
    lineupError: "",
  });
  assert.match(html, /xP 8\.4/);
  assert.match(html, /xP •/); // every other starter still lacks stats
  assert.match(html, /Expected points from last-5 form, minutes and fixture difficulty\./);
});

test("renderFantasyRosterPanel shows the Squad xP placeholder line when no starter has real stats", () => {
  const html = renderFantasyRosterPanel({
    currentGameweek: 5,
    roster: rosterFixture(),
    lineup: baseLineup(),
    playerPool: [],
    picks: [],
    editState: null,
    drawerPlayerId: null,
    lineupError: "",
  });
  assert.match(html, /xP arrives with player stats\./);
  assert.doesNotMatch(html, /Expected points from last-5 form/);
});

test("renderFantasyRosterPanel surfaces the inherited and default source notes, and neither for a freshly set lineup", () => {
  const inherited = renderFantasyRosterPanel({
    currentGameweek: 5,
    roster: rosterFixture(),
    lineup: baseLineup({ source: "inherited" }),
    playerPool: [],
    picks: [],
    editState: null,
    drawerPlayerId: null,
    lineupError: "",
  });
  assert.match(inherited, /Carried over from an earlier gameweek\./);

  const defaulted = renderFantasyRosterPanel({
    currentGameweek: 5,
    roster: rosterFixture(),
    lineup: baseLineup({ source: "default" }),
    playerPool: [],
    picks: [],
    editState: null,
    drawerPlayerId: null,
    lineupError: "",
  });
  assert.match(defaulted, /Auto-picked XI: set your own\./);

  const set = renderFantasyRosterPanel({
    currentGameweek: 5,
    roster: rosterFixture(),
    lineup: baseLineup({ source: "set" }),
    playerPool: [],
    picks: [],
    editState: null,
    drawerPlayerId: null,
    lineupError: "",
  });
  assert.doesNotMatch(set, /Carried over/);
  assert.doesNotMatch(set, /Auto-picked/);
});

test("renderFantasyRosterPanel dims illegal swap targets and marks the pending tile while editing", () => {
  // Bench player 13 (DEF) is pending; the sole GK starter (1) is the only
  // illegal target (benching it would drop GK below its minimum of 1), so it
  // alone should render dimmed. A same-group bench tile (14) is never dimmed.
  const editState = { starters: ROSTER_STARTERS, captainId: 10, bench: ROSTER_BENCH, pendingId: 13, saving: false, error: "" };
  const html = renderFantasyRosterPanel({
    currentGameweek: 5,
    roster: rosterFixture(),
    lineup: baseLineup(),
    playerPool: [],
    picks: [],
    editState,
    drawerPlayerId: null,
    lineupError: "",
  });

  assert.match(tileClasses(html, 1), /is-dimmed/);
  assert.doesNotMatch(tileClasses(html, 6), /is-dimmed/);
  assert.match(tileClasses(html, 13), /is-pending/);
  assert.doesNotMatch(tileClasses(html, 14), /is-pending|is-dimmed/);
});

test("renderFantasyRosterPanel shows Save/Cancel and a captain affordance on the pending starter while editing", () => {
  const editState = { starters: ROSTER_STARTERS, captainId: 10, bench: ROSTER_BENCH, pendingId: 2, saving: false, error: "" };
  const html = renderFantasyRosterPanel({
    currentGameweek: 5,
    roster: rosterFixture(),
    lineup: baseLineup(),
    playerPool: [],
    picks: [],
    editState,
    drawerPlayerId: null,
    lineupError: "",
  });
  assert.match(html, /data-fantasy-lineup-save/);
  assert.match(html, /data-fantasy-lineup-cancel/);
  assert.match(html, /data-fantasy-make-captain="2"/);
  assert.doesNotMatch(html, /data-fantasy-lineup-edit>/);
});

test("renderFantasyRosterPanel surfaces an edit error in the shared form-error style", () => {
  const editState = { starters: ROSTER_STARTERS, captainId: 10, bench: ROSTER_BENCH, pendingId: null, saving: false, error: "DEF count 2 outside 3-5" };
  const html = renderFantasyRosterPanel({
    currentGameweek: 5,
    roster: rosterFixture(),
    lineup: baseLineup(),
    playerPool: [],
    picks: [],
    editState,
    drawerPlayerId: null,
    lineupError: "",
  });
  assert.match(html, /fantasy-form__error/);
  assert.match(html, /DEF count 2 outside 3-5/);
});

test("renderFantasyRosterPanel's player drawer shows the draft pick and real stats when they exist", () => {
  const picks = [
    { round: 1, pickInRound: 1, overallPick: 1, userId: 1, player: { id: 10, name: "Forward One", team: "Test FC", position: "FWD" } },
  ];
  const html = renderFantasyRosterPanel({
    currentGameweek: 5,
    roster: rosterFixture(),
    lineup: baseLineup(),
    playerPool: [{ id: 10, name: "Forward One", team: "Test FC", position: "FWD", xp: 8.4 }],
    picks,
    editState: null,
    drawerPlayerId: 10,
    lineupError: "",
  });
  assert.match(html, /Pick 1\.01/);
  assert.match(html, /Forward One/);
  assert.doesNotMatch(html, /data-fantasy-player-drawer hidden/);
});

test("renderFantasyRosterPanel's player drawer shows a calm note when a player has no stats yet", () => {
  const html = renderFantasyRosterPanel({
    currentGameweek: 5,
    roster: rosterFixture(),
    lineup: baseLineup(),
    playerPool: [],
    picks: [],
    editState: null,
    drawerPlayerId: 2,
    lineupError: "",
  });
  assert.match(html, /More stats coming with live player data\./);
});

test("renderFantasyRosterPanel's player drawer is hidden when no player id is given", () => {
  const html = renderFantasyRosterPanel({
    currentGameweek: 5,
    roster: rosterFixture(),
    lineup: baseLineup(),
    playerPool: [],
    picks: [],
    editState: null,
    drawerPlayerId: null,
    lineupError: "",
  });
  assert.match(html, /data-fantasy-player-drawer hidden/);
});

test("renderFantasyRosterPanel shows a loading note before the lineup has loaded, or the error state on failure", () => {
  const loading = renderFantasyRosterPanel({
    currentGameweek: 5,
    roster: rosterFixture(),
    lineup: null,
    playerPool: [],
    picks: [],
    editState: null,
    drawerPlayerId: null,
    lineupError: "",
  });
  assert.match(loading, /Loading your lineup/);

  const failed = renderFantasyRosterPanel({
    currentGameweek: 5,
    roster: rosterFixture(),
    lineup: null,
    playerPool: [],
    picks: [],
    editState: null,
    drawerPlayerId: null,
    lineupError: "Couldn't load your lineup.",
  });
  assert.match(failed, /fantasy-form__error/);
  assert.match(failed, /Couldn't load your lineup\./);
  assert.match(failed, /data-fantasy-lineup-retry/);
});

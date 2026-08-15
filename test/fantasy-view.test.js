import assert from "node:assert/strict";
import { abbrFor } from "../src/badges.js";
import test from "node:test";

import {
  renderFantasyClaimFlow,
  renderFantasyComplete,
  renderFantasyDraftRoom,
  renderFantasyFreeAgentRows,
  renderFantasyInvitePreview,
  renderFantasyLeagueHeader,
  renderFantasyLeagueList,
  renderFantasyLobby,
  renderFantasyMatchupPanel,
  renderFantasyMyTeamPanel,
  renderFantasyPlayerPool,
  renderFantasyPlayerRows,
  renderFantasyRosterPanel,
  renderFantasySessionExpired,
  renderFantasyStandingsPanel,
  renderFantasySettingsPanel,
  renderTeamNameRow,
  renderGameweekTracker,
  renderFantasyWaiversPanel,
  renderChampionCard,
  renderFantasyWireRows,
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

test("renderFantasyPlayerRows marks an already-drafted player instead of offering a Draft button, with hideTaken off", () => {
  const players = [pooledPlayer(1, "MID")];
  const html = renderFantasyPlayerRows(players, { position: "All", search: "", hideTaken: false }, {
    isMyTurn: true,
    myRoster: [],
    draftedIds: new Set([1]),
  });
  assert.doesNotMatch(html, /data-fantasy-draft-player/);
  assert.match(html, /Drafted/);
});

// -- Hide-taken filter (defaults to on) ------------------------------------------

test("renderFantasyPlayerRows hides an already-drafted player by default (hideTaken defaults to on)", () => {
  const players = [pooledPlayer(1, "MID"), pooledPlayer(2, "MID")];
  const html = renderFantasyPlayerRows(players, { position: "All", search: "" }, {
    isMyTurn: true,
    myRoster: [],
    draftedIds: new Set([1]),
  });
  assert.doesNotMatch(html, /Player 1/);
  assert.match(html, /Player 2/);
});

test("renderFantasyPlayerRows shows every drafted player when hideTaken is explicitly false", () => {
  const players = [pooledPlayer(1, "MID"), pooledPlayer(2, "MID")];
  const html = renderFantasyPlayerRows(players, { position: "All", search: "", hideTaken: false }, {
    isMyTurn: true,
    myRoster: [],
    draftedIds: new Set([1]),
  });
  assert.match(html, /Player 1/);
  assert.match(html, /Player 2/);
});

test("renderFantasyPlayerRows says no players match once hideTaken filters everything out", () => {
  const players = [pooledPlayer(1, "MID")];
  const html = renderFantasyPlayerRows(players, { position: "All", search: "" }, {
    isMyTurn: true,
    myRoster: [],
    draftedIds: new Set([1]),
  });
  assert.match(html, /No players match/);
});

// -- Draft board: rank/round column and the sort control ------------------------
//
// Ranking itself (value over replacement, projected round) is fantasyDraftRank.js's
// job and is exhaustively tested there; these tests only check that
// renderFantasyPlayerRows/renderFantasyPlayerPool actually wire it up - real
// leagueSize in, a rank/round rendered per row, and the chosen sort applied.

test("renderFantasyPlayerRows shows a real rank and projected round once the pool carries xp", () => {
  const players = [
    { ...pooledPlayer(1, "FWD"), xp: 8 },
    { ...pooledPlayer(2, "FWD"), xp: 2 },
  ];
  const html = renderFantasyPlayerRows(players, { position: "All", search: "" }, {
    isMyTurn: false,
    myRoster: [],
    draftedIds: new Set(),
    leagueSize: 8,
  });
  assert.match(html, /fantasy-player-row__rank"><strong>#1<\/strong><span class="note--dim">R1<\/span>/);
  assert.doesNotMatch(html, /fantasy-player-row__rank fantasy-stat fantasy-stat--empty/);
});

test("renderFantasyPlayerRows degrades gracefully when every player is missing xp: dim rank placeholders, never a broken or empty board", () => {
  const players = [pooledPlayer(1, "FWD"), pooledPlayer(2, "MID")];
  const html = renderFantasyPlayerRows(players, { position: "All", search: "" }, {
    isMyTurn: false,
    myRoster: [],
    draftedIds: new Set(),
    leagueSize: 8,
  });
  assert.match(html, /Player 1/);
  assert.match(html, /Player 2/);
  assert.equal((html.match(/fantasy-player-row__rank fantasy-stat fantasy-stat--empty/g) ?? []).length, 2);
});

test("renderFantasyPlayerRows sorts by name when every player is unranked, so an all-null pool is still usable", () => {
  const players = [pooledPlayer(2, "MID", "Zed"), pooledPlayer(1, "MID", "Amy")];
  const html = renderFantasyPlayerRows(players, { position: "All", search: "", sort: "rank" }, {
    isMyTurn: false,
    myRoster: [],
    draftedIds: new Set(),
    leagueSize: 4,
  });
  assert.ok(html.indexOf("Amy") < html.indexOf("Zed"), "the default rank sort must fall back to alphabetical, not pool order");
});

test("renderFantasyPlayerRows honours the xp sort key, independent of rank", () => {
  const players = [
    { ...pooledPlayer(1, "MID", "Low xP"), xp: 2 },
    { ...pooledPlayer(2, "MID", "High xP"), xp: 9 },
  ];
  const html = renderFantasyPlayerRows(players, { position: "All", search: "", sort: "xp" }, {
    isMyTurn: false,
    myRoster: [],
    draftedIds: new Set(),
    leagueSize: 4,
  });
  assert.ok(html.indexOf("High xP") < html.indexOf("Low xP"));
});

test("renderFantasyPlayerPool renders the Rank column header and a sort pill per POOL_SORTS entry, marking the active one", () => {
  const players = [{ ...pooledPlayer(1, "MID"), xp: 4 }];
  const html = renderFantasyPlayerPool(
    players,
    { position: "All", search: "", sort: "xp" },
    { isMyTurn: false, myRoster: [], draftedIds: new Set(), leagueSize: 6 },
  );
  assert.match(html, /<span>Rank<\/span>/);
  assert.match(html, /<span>xP<\/span>/);
  assert.match(html, /data-fantasy-pool-sort="rank"[^>]*>Rank</);
  assert.match(html, /data-fantasy-pool-sort="xp"[^>]*>xP</);
  assert.match(html, /data-fantasy-pool-sort="name"[^>]*>Name</);
  assert.match(html, /seg is-active" type="button" data-fantasy-pool-sort="xp"/);
  // Every sort pill carries its plain-English explanation as a tooltip; "Board"
  // is the one that is meaningless without it, so it is also renamed to match
  // the My board sub-tab it refers to.
  assert.match(html, /data-fantasy-pool-sort="board"[^>]*>My board</);
  assert.match(html, /data-fantasy-pool-sort="rank"[^>]*title="[^"]+"/);
});

test("the My board sort is disabled, with a reason, until the manager has actually built one", () => {
  const players = [{ ...pooledPlayer(1, "MID"), xp: 4 }];
  const base = { isMyTurn: false, myRoster: [], draftedIds: new Set(), leagueSize: 6 };
  const filter = { position: "All", search: "", sort: "rank" };

  const noBoard = renderFantasyPlayerPool(players, filter, base);
  assert.match(noBoard, /data-fantasy-pool-sort="board" disabled title="Star players in the My board tab[^"]*"/);

  const withBoard = renderFantasyPlayerPool(players, filter, { ...base, board: { order: [1] } });
  assert.doesNotMatch(withBoard, /data-fantasy-pool-sort="board" disabled/);
});

test("renderFantasyPlayerPool falls back to the default sort for an unrecognised filter.sort rather than throwing", () => {
  const players = [pooledPlayer(1, "MID")];
  const html = renderFantasyPlayerPool(
    players,
    { position: "All", search: "", sort: "nonsense" },
    { isMyTurn: false, myRoster: [], draftedIds: new Set(), leagueSize: 6 },
  );
  assert.match(html, /seg is-active" type="button" data-fantasy-pool-sort="rank"/);
});

// -- Pick queue star toggle -------------------------------------------------------

test("renderFantasyPlayerRows marks a queued player's star as active and an unqueued one as not", () => {
  const players = [pooledPlayer(1, "MID"), pooledPlayer(2, "MID")];
  const context = { isMyTurn: true, myRoster: [], draftedIds: new Set(), queuedIds: new Set([1]) };
  const html = renderFantasyPlayerRows(players, { position: "All", search: "", hideTaken: false }, context);
  assert.match(html, /data-fantasy-queue-toggle="1" aria-pressed="true"/);
  assert.match(html, /data-fantasy-queue-toggle="2" aria-pressed="false"/);
});

test("renderFantasyPlayerRows omits the queue star for an already-drafted player", () => {
  const players = [pooledPlayer(1, "MID")];
  const context = { isMyTurn: true, myRoster: [], draftedIds: new Set([1]), queuedIds: new Set([1]) };
  const html = renderFantasyPlayerRows(players, { position: "All", search: "", hideTaken: false }, context);
  assert.doesNotMatch(html, /data-fantasy-queue-toggle/);
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

test("renderFantasyPlayerRows renders no Tier/Apps cells at all when the pool carries no prior-season enrichment (a failed bake, not per-player nulls)", () => {
  const html = renderFantasyPlayerRows([pooledPlayer(1, "MID")], { position: "All", search: "" }, {
    isMyTurn: false,
    myRoster: [],
    draftedIds: new Set(),
  });
  // No `tier` field anywhere in this pool: the whole columns are dropped
  // rather than shown full of placeholder dots pretending to hold data.
  assert.doesNotMatch(html, /fantasy-tier-chip/);
  assert.doesNotMatch(html, /fantasy-player-row__tier/);
  assert.doesNotMatch(html, /fantasy-player-row__stat/);
  // Rank and xP (fantasyDraftRank.js) are both unconditional, unlike Tier/Apps -
  // this fixture carries no xp, so each legitimately renders the same empty-
  // placeholder class once. Scoped to "exactly these two" rather than "absent
  // anywhere in the row".
  const emptyPlaceholders = html.match(/fantasy-stat--empty/g) ?? [];
  assert.equal(emptyPlaceholders.length, 2, "only the Rank and xP cells should use fantasy-stat--empty here");
  assert.match(html, /fantasy-player-row__rank fantasy-stat fantasy-stat--empty/);
  assert.match(html, /fantasy-player-row__xp"><span class="fantasy-stat fantasy-stat--empty"/);
});

test("renderFantasyPlayerRows shows the xP figure the sort control offers, so nobody sorts by an invisible number", () => {
  const withXp = { id: 1, name: "Player 1", team: "Test FC", position: "MID", xp: 4.25 };
  const html = renderFantasyPlayerRows([withXp], { position: "All", search: "" }, {
    isMyTurn: false,
    myRoster: [],
    draftedIds: new Set(),
    leagueSize: 8,
  });
  assert.match(html, /fantasy-player-row__xp"><span class="fantasy-stat">4\.3</);
});

test("the Starred filter narrows the pool to queued players, and says so when nothing is starred yet", () => {
  const players = [
    { ...pooledPlayer(1, "MID"), xp: 5 },
    { ...pooledPlayer(2, "FWD"), xp: 4 },
  ];
  const context = { isMyTurn: false, myRoster: [], draftedIds: new Set(), leagueSize: 8, queuedIds: new Set([2]) };

  const starred = renderFantasyPlayerRows(players, { position: "All", search: "", starredOnly: true }, context);
  assert.match(starred, /Player 2/);
  assert.doesNotMatch(starred, /Player 1/);

  const all = renderFantasyPlayerRows(players, { position: "All", search: "", starredOnly: false }, context);
  assert.match(all, /Player 1/);
  assert.match(all, /Player 2/);

  // An empty shortlist must explain itself rather than reading as "no players
  // match", which sounds like the other filters are at fault.
  const none = renderFantasyPlayerRows(players, { position: "All", search: "", starredOnly: true }, { ...context, queuedIds: new Set() });
  assert.match(none, /You have not starred anyone yet/);
});

test("renderFantasyPlayerRows shows a Starter tier chip and the real appearances count when the pool has prior-season enrichment", () => {
  const withStats = { id: 1, name: "Player 1", team: "Test FC", position: "MID", tier: "starter", appearances: 37, minutes: 3330 };
  const html = renderFantasyPlayerRows([withStats], { position: "All", search: "" }, {
    isMyTurn: false,
    myRoster: [],
    draftedIds: new Set(),
  });
  assert.match(html, /fantasy-tier-chip--starter">Starter</);
  assert.match(html, />37</);
  // The appearances stat cell itself must show the real number, not the
  // empty-placeholder dot - scoped to that cell specifically (not "anywhere
  // in the row") because this fixture carries no xp, so the unconditional
  // Rank column legitimately renders its own empty placeholder alongside it.
  assert.doesNotMatch(html, /fantasy-player-row__stat"><span class="fantasy-stat fantasy-stat--empty"/);
});

test("renderFantasyPlayerRows reads a player with no prior-season record as New, never zero or a blank cell", () => {
  const noRecord = { id: 1, name: "Academy Kid", team: "Test FC", position: "MID", tier: "unknown", appearances: null, minutes: null };
  const html = renderFantasyPlayerRows([noRecord], { position: "All", search: "" }, {
    isMyTurn: false,
    myRoster: [],
    draftedIds: new Set(),
  });
  assert.match(html, /fantasy-tier-chip--unknown">New</);
  // Appearances genuinely unknown: a dim placeholder, not a fabricated "0".
  assert.match(html, /fantasy-stat--empty/);
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

test("renderFantasyDraftRoom's pool shows a Tier/Apps header and a season note when the pool has prior-season enrichment", () => {
  const html = renderFantasyDraftRoom({
    league,
    members,
    draft: draftRoomFixture(),
    playerPool: [{ id: 1, name: "Player 1", team: "Test FC", position: "MID", tier: "starter", appearances: 20, minutes: 1500 }],
    filter: { position: "All", search: "" },
    myUserId: 2,
    priorSeasonStats: { available: true, season: "2025", playersWithoutRecord: 3 },
  });
  assert.match(html, /<span>Tier<\/span><span>Apps<\/span>/);
  assert.match(html, /last season \(2025\/26\)/);
});

test("renderFantasyDraftRoom's pool hides the Tier/Apps header entirely when the pool has no prior-season enrichment", () => {
  const html = renderFantasyDraftRoom({
    league,
    members,
    draft: draftRoomFixture(),
    playerPool: [pooledPlayer(1, "MID")],
    filter: { position: "All", search: "" },
    myUserId: 2,
  });
  assert.doesNotMatch(html, /<span>Tier<\/span>/);
  assert.doesNotMatch(html, /<span>Apps<\/span>/);
  assert.doesNotMatch(html, /last season/);
  assert.match(html, /fantasy-pool__table--degraded/);
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

// -- renderFantasyLobby: draft scheduling ----------------------------------------

test("renderFantasyLobby points a commissioner at Settings when nothing is scheduled, with no picker of its own", () => {
  // The picker lives on the Settings tab only (see renderFantasySettingsPanel's
  // tests); the lobby shows the fact and the way there, never a second copy of
  // the form.
  const html = renderFantasyLobby(lobbyLeague({ isCommissioner: true }), lobbyMembers, {
    playerPool: null,
    filter: { position: "All", search: "" },
  });
  assert.match(html, /No draft time set/);
  assert.match(html, /data-fantasy-subtab="settings"/);
  assert.doesNotMatch(html, /data-fantasy-schedule-input/);
  assert.doesNotMatch(html, /data-fantasy-schedule-save/);
});

test("renderFantasyLobby tells a non-commissioner nothing is scheduled yet, with no picker", () => {
  const html = renderFantasyLobby(lobbyLeague({ isCommissioner: false }), lobbyMembers, {
    playerPool: null,
    filter: { position: "All", search: "" },
  });
  assert.match(html, /hasn't scheduled the draft yet/);
  assert.doesNotMatch(html, /data-fantasy-schedule-input/);
});

test("renderFantasyLobby shows the commissioner the scheduled time and countdown, with changes routed to Settings", () => {
  const scheduledAt = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
  const html = renderFantasyLobby(lobbyLeague({ isCommissioner: true }), lobbyMembers, {
    playerPool: null,
    filter: { position: "All", search: "" },
    schedule: { scheduledAt },
  });
  assert.match(html, /Draft scheduled/);
  assert.match(html, new RegExp(`data-scheduled-at="${scheduledAt}"`));
  assert.match(html, /Change or clear it in/);
  assert.doesNotMatch(html, /data-fantasy-schedule-save/);
  assert.doesNotMatch(html, /data-fantasy-schedule-clear/);
});

test("renderFantasyLobby shows a non-commissioner the scheduled time read-only, plus the auto-pick warning, no controls", () => {
  const scheduledAt = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
  const html = renderFantasyLobby(lobbyLeague({ isCommissioner: false }), lobbyMembers, {
    playerPool: null,
    filter: { position: "All", search: "" },
    schedule: { scheduledAt },
  });
  assert.match(html, /Draft scheduled/);
  assert.match(html, /auto-picked from the players still available/);
  assert.doesNotMatch(html, /data-fantasy-schedule-save/);
  assert.doesNotMatch(html, /data-fantasy-schedule-clear/);
});

test("renderFantasyLobby marks a schedule within the hour as soon", () => {
  const scheduledAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const html = renderFantasyLobby(lobbyLeague({ isCommissioner: true }), lobbyMembers, {
    playerPool: null,
    filter: { position: "All", search: "" },
    schedule: { scheduledAt },
  });
  assert.match(html, /class="card fantasy-schedule is-soon"/);
});

test("the settings tab surfaces a schedule error message, escaped", () => {
  const html = renderFantasySettingsPanel(
    { name: "L", draftStatus: "pending", isCommissioner: true },
    [{ userId: 1, name: "Me" }],
    { seats: { total: 10, humans: 1, bots: 0, open: 9 }, schedule: null, scheduleError: `bad "date" <here>` },
  );
  assert.match(html, /bad &quot;date&quot; &lt;here&gt;/);
});

test("the settings tab disables schedule controls while a save/clear is in flight", () => {
  const scheduledAt = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
  const html = renderFantasySettingsPanel(
    { name: "L", draftStatus: "pending", isCommissioner: true },
    [{ userId: 1, name: "Me" }],
    { seats: { total: 10, humans: 1, bots: 0, open: 9 }, schedule: { scheduledAt }, scheduleBusy: true },
  );
  assert.match(html, /data-fantasy-schedule-save disabled/);
  assert.match(html, /data-fantasy-schedule-clear disabled/);
});

// -- League header + sub-tabs ----------------------------------------------------

test("renderFantasyLeagueHeader shows the purple eyebrow, the active sub-tab's title, and the chip row", () => {
  const html = renderFantasyLeagueHeader({ name: "Goon Squad League" }, members, "draftroom");
  assert.match(html, /Goon Squad League · H2H/);
  assert.match(html, /Draft room/);
  assert.match(html, /2 managers/);
  assert.match(html, /Snake draft/);
});

test("renderFantasyLeagueHeader marks the active sub-tab and leaves the season tabs live once the draft is complete", () => {
  const html = renderFantasyLeagueHeader({ name: "Test League", draftStatus: "complete" }, members, "myteam");
  const myTeamButton = html.match(/<button class="fantasy-subtab[^"]*" type="button" data-fantasy-subtab="myteam"[^>]*>/)[0];
  assert.match(myTeamButton, /is-active/);
  const matchupButton = html.match(/<button class="fantasy-subtab[^"]*" type="button" data-fantasy-subtab="matchup"[^>]*>/)[0];
  assert.doesNotMatch(matchupButton, /disabled/);
  const standingsButton = html.match(/<button class="fantasy-subtab[^"]*" type="button" data-fantasy-subtab="standings"[^>]*>/)[0];
  assert.doesNotMatch(standingsButton, /disabled/);
  assert.doesNotMatch(html, /Soon/);
});

// The gate that keeps every step in sequence: a league that has not drafted
// has no matchups, no standings and no waiver wire, so those tabs are inert
// until the draft completes rather than leading to a request that can only 400.
test("renderFantasyLeagueHeader disables Matchup, Standings and Waivers until the draft is complete", () => {
  for (const draftStatus of ["pending", "drafting"]) {
    const html = renderFantasyLeagueHeader({ name: "Test League", draftStatus }, members, "draftroom");
    for (const tab of ["matchup", "standings", "waivers"]) {
      const button = html.match(new RegExp(`<button class="fantasy-subtab[^"]*" type="button" data-fantasy-subtab="${tab}"[^>]*>`))[0];
      assert.match(button, /disabled/, `${tab} should be disabled while ${draftStatus}`);
    }
    const boardButton = html.match(/<button class="fantasy-subtab[^"]*" type="button" data-fantasy-subtab="board"[^>]*>/)[0];
    assert.doesNotMatch(boardButton, /disabled/, `board should stay live while ${draftStatus}`);
  }
});

test("renderFantasyLeagueHeader puts Feed first in the sub-tab bar and never disables it", () => {
  const html = renderFantasyLeagueHeader({ name: "Test League", draftStatus: "pending" }, members, "draftroom");
  const order = [...html.matchAll(/data-fantasy-subtab="([a-z]+)"/g)].map((match) => match[1]);
  // Feed leads the bar deliberately: league chat behind a corner tab is the
  // version managers abandon for WhatsApp.
  assert.equal(order[0], "feed");
  const feedButton = html.match(/<button class="fantasy-subtab[^"]*" type="button" data-fantasy-subtab="feed"[^>]*>/)[0];
  assert.doesNotMatch(feedButton, /disabled/);
});

test("renderFantasyLeagueHeader shows Feed as the active tab's title", () => {
  const html = renderFantasyLeagueHeader({ name: "Test League" }, members, "feed");
  assert.match(html, /<h1 class="hero__title">Feed<\/h1>/);
});

test("renderFantasyLeagueHeader shows Matchup as the active tab's title", () => {
  const html = renderFantasyLeagueHeader({ name: "Test League" }, members, "matchup");
  assert.match(html, /<h1 class="hero__title">Matchup<\/h1>/);
});

test("renderFantasyLeagueHeader shows Standings as the active tab's title", () => {
  const html = renderFantasyLeagueHeader({ name: "Test League" }, members, "standings");
  assert.match(html, /<h1 class="hero__title">Standings<\/h1>/);
});

test("renderFantasyLeagueHeader escapes the league name", () => {
  const html = renderFantasyLeagueHeader({ name: `<script>alert(1)</script>` }, members, "draftroom");
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
});

test("renderFantasyLeagueHeader disables the Waivers sub-tab until the draft is complete", () => {
  const drafting = renderFantasyLeagueHeader({ name: "Test League", draftStatus: "drafting" }, members, "draftroom");
  const waiversButton = drafting.match(/<button class="fantasy-subtab[^"]*" type="button" data-fantasy-subtab="waivers"[^>]*>/)[0];
  assert.match(waiversButton, /disabled/);

  const complete = renderFantasyLeagueHeader({ name: "Test League", draftStatus: "complete" }, members, "waivers");
  const enabledButton = complete.match(/<button class="fantasy-subtab[^"]*" type="button" data-fantasy-subtab="waivers"[^>]*>/)[0];
  assert.doesNotMatch(enabledButton, /disabled/);
  assert.match(enabledButton, /is-active/);
});

test("renderFantasyLeagueHeader shows Waivers as the active tab's title", () => {
  const html = renderFantasyLeagueHeader({ name: "Test League", draftStatus: "complete" }, members, "waivers");
  assert.match(html, /<h1 class="hero__title">Waivers<\/h1>/);
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

// The order the Bench card actually renders its rows in, by player id.
function benchOrder(html) {
  return [...html.matchAll(/data-fantasy-player-id="(\d+)" data-fantasy-slot="bench"/g)].map((m) => Number(m[1]));
}

test("renderFantasyRosterPanel reads the bench keeper-first, whatever order the roster is in (#51)", () => {
  const html = renderFantasyRosterPanel({
    currentGameweek: 5,
    roster: rosterFixture(),
    // /lineup derives the bench as "roster minus starters", so it arrives in
    // the order the squad was drafted in: here a forward, then a defender,
    // then the keeper.
    lineup: baseLineup({ bench: [15, 13, 12, 14] }),
    playerPool: [],
    picks: [],
    editState: null,
    drawerPlayerId: null,
    lineupError: "",
  });

  assert.deepEqual(benchOrder(html), [12, 13, 14, 15]);
});

test("renderFantasyRosterPanel keeps the bench in position order mid-swap, without disturbing the swap state", () => {
  const html = renderFantasyRosterPanel({
    currentGameweek: 5,
    roster: rosterFixture(),
    lineup: baseLineup(),
    playerPool: [],
    picks: [],
    // A pending swap holds its own working copy of the bench; the rows are
    // still read keeper-first, and the pending tile is still the one selected.
    editState: { starters: ROSTER_STARTERS, captainId: 10, bench: [14, 15, 12, 13], pendingId: 12, saving: false, error: "" },
    drawerPlayerId: null,
    lineupError: "",
  });

  assert.deepEqual(benchOrder(html), [12, 13, 14, 15]);
  assert.match(tileClasses(html, 12) ?? "", /is-pending/);
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

test("renderFantasyRosterPanel marks an estimated xP with the is-estimate class and a projection tooltip, never like a measured figure", () => {
  const html = renderFantasyRosterPanel({
    currentGameweek: 5,
    roster: rosterFixture(),
    lineup: baseLineup(),
    playerPool: [{ id: 10, name: "Forward One", team: "Test FC", position: "FWD", xp: 6.1, xpBasis: "estimate" }],
    picks: [],
    editState: null,
    drawerPlayerId: null,
    lineupError: "",
  });
  assert.match(html, /xP 6\.1/);
  assert.match(html, /fantasy-pitch__xp is-estimate/);
  assert.match(html, /a projection, not this player&#39;s own record/);
});

test("renderFantasyRosterPanel gives a measured (history) xP its season-sourced tooltip, with no estimate class", () => {
  const html = renderFantasyRosterPanel({
    currentGameweek: 5,
    roster: rosterFixture(),
    lineup: baseLineup(),
    playerPool: [{ id: 10, name: "Forward One", team: "Test FC", position: "FWD", xp: 8.4, xpBasis: "history" }],
    picks: [],
    editState: null,
    drawerPlayerId: null,
    lineupError: "",
    xpStats: { available: true, seasons: ["2025", "2024", "2023"], requestCount: 87, basisCounts: { history: 400, estimate: 50, none: 6 } },
  });
  assert.match(html, /From actual history: 2025\/26, 2024\/25, 2023\/24\./);
  assert.doesNotMatch(html, /fantasy-pitch__xp is-estimate/);
});

test("renderFantasyRosterPanel's bench row and Squad xP rail also carry the estimate marker for an estimated starter/bench player", () => {
  const html = renderFantasyRosterPanel({
    currentGameweek: 5,
    roster: rosterFixture(),
    lineup: baseLineup(),
    playerPool: [
      { id: 10, name: "Forward One", team: "Test FC", position: "FWD", xp: 6.1, xpBasis: "estimate" }, // starter
      { id: 12, name: "Bench Keeper", team: "Test FC", position: "GK", xp: 3.2, xpBasis: "estimate" }, // bench
    ],
    picks: [],
    editState: null,
    drawerPlayerId: null,
    lineupError: "",
  });
  assert.match(html, /fantasy-bench-row__xp is-estimate/);
  assert.match(html, /fantasy-squadxp__value is-estimate/);
});

test("renderFantasyRosterPanel's player drawer marks an estimated xP the same way", () => {
  const html = renderFantasyRosterPanel({
    currentGameweek: 5,
    roster: rosterFixture(),
    lineup: baseLineup(),
    playerPool: [{ id: 10, name: "Forward One", team: "Test FC", position: "FWD", xp: 6.1, xpBasis: "estimate" }],
    picks: [],
    editState: null,
    drawerPlayerId: 10,
    lineupError: "",
  });
  assert.match(html, /fantasy-stat is-estimate/);
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

test("renderFantasyRosterPanel's player drawer shows Tier/Apps/Minutes and the season note when the pool has prior-season enrichment", () => {
  const html = renderFantasyRosterPanel({
    currentGameweek: 5,
    roster: rosterFixture(),
    lineup: baseLineup(),
    playerPool: [{ id: 10, name: "Forward One", team: "Test FC", position: "FWD", tier: "starter", appearances: 37, minutes: 3330 }],
    picks: [],
    editState: null,
    drawerPlayerId: 10,
    lineupError: "",
    priorSeasonStats: { available: true, season: "2025", playersWithoutRecord: 3 },
  });
  assert.match(html, /fantasy-tier-chip--starter">Starter</);
  assert.match(html, />37</);
  assert.match(html, />3330</);
  assert.match(html, /last season \(2025\/26\)/);
});

test("renderFantasyRosterPanel's player drawer reads a no-record player as New rather than zero or blank", () => {
  const html = renderFantasyRosterPanel({
    currentGameweek: 5,
    roster: rosterFixture(),
    lineup: baseLineup(),
    playerPool: [{ id: 10, name: "Forward One", team: "Test FC", position: "FWD", tier: "unknown", appearances: null, minutes: null }],
    picks: [],
    editState: null,
    drawerPlayerId: 10,
    lineupError: "",
    priorSeasonStats: { available: true, season: "2025", playersWithoutRecord: 3 },
  });
  assert.match(html, /fantasy-tier-chip--unknown">New</);
  assert.match(html, /fantasy-stat--empty/);
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
  assert.match(failed, /Couldn&#39;t load your lineup\./);
  assert.match(failed, /data-fantasy-lineup-retry/);
});

// -- Matchup panel (Phase 4.3) -----------------------------------------------------

test("renderFantasyMatchupPanel shows a loading note before the matchup has loaded, or the error state with retry on failure", () => {
  const loading = renderFantasyMatchupPanel(null, {});
  assert.match(loading, /Loading your matchup/);

  const failed = renderFantasyMatchupPanel(null, { error: "Couldn't load your matchup." });
  assert.match(failed, /fantasy-form__error/);
  assert.match(failed, /Couldn&#39;t load your matchup\./);
  assert.match(failed, /data-fantasy-matchup-retry/);
});

test("renderFantasyMatchupPanel explains a bye plainly when opponent is null", () => {
  const html = renderFantasyMatchupPanel(
    { gameweek: 7, status: "scheduled", me: { userId: 1, name: "Alex", score: 0 }, opponent: null },
    { leagueSize: 3 },
  );
  assert.match(html, /You play Average/);
  // Names WHY, not just that it happened: an odd-sized league leaves somebody
  // unpaired every week and the manager it happens to has to be told that.
  assert.match(html, /\(3\)/); // names the league size
  assert.match(html, /median/);
  assert.doesNotMatch(html, /fantasy-matchup__vs/);
});

test("renderFantasyMatchupPanel shows a pending score (not a bare 0-0) while the matchup is scheduled", () => {
  const html = renderFantasyMatchupPanel({
    gameweek: 7,
    status: "scheduled",
    me: { userId: 1, name: "Alex", score: 0 },
    opponent: { userId: 2, name: "Sam", score: 0 },
  });
  assert.match(html, /has not been played yet/);
  assert.doesNotMatch(html, /fantasy-matchup__bar-me/);
  assert.match(html, /fantasy-stat--empty/);
});

test("a live matchup shows each side's progress, lit for the side with players on a pitch", () => {
  const html = renderFantasyMatchupPanel({
    gameweek: 7,
    status: "live",
    me: { userId: 1, name: "Alex", score: 41, progress: { total: 11, done: 6, inPlay: 3, toCome: 2, blank: 0 } },
    opponent: { userId: 2, name: "Sam", score: 38, progress: { total: 11, done: 11, inPlay: 0, toCome: 0, blank: 0 } },
  });
  assert.match(html, /6 done · 3 in play · 2 to come/);
  assert.match(html, /11 done/);
  // My three players are on a pitch; Sam is finished. Only my line is lit.
  const lit = (html.match(/fantasy-matchup__progress is-live/g) ?? []).length;
  assert.equal(lit, 1, "exactly the side with players on a pitch is lit");
});

test("progress stays quiet before kickoff and when an older worker sends none", () => {
  const preKickoff = renderFantasyMatchupPanel({
    gameweek: 7,
    status: "scheduled",
    me: { userId: 1, name: "Alex", score: 0, progress: { total: 11, done: 0, inPlay: 0, toCome: 11, blank: 0 } },
    opponent: { userId: 2, name: "Sam", score: 0, progress: { total: 11, done: 0, inPlay: 0, toCome: 11, blank: 0 } },
  });
  assert.doesNotMatch(preKickoff, /fantasy-matchup__progress/, "11 to come before kickoff is noise, not information");

  const older = renderFantasyMatchupPanel({
    gameweek: 7,
    status: "live",
    me: { userId: 1, name: "Alex", score: 41 },
    opponent: { userId: 2, name: "Sam", score: 38 },
  });
  assert.doesNotMatch(older, /fantasy-matchup__progress/, "a payload without progress renders exactly as before");
});

test("the Average bye card carries your own progress while the gameweek runs", () => {
  const html = renderFantasyMatchupPanel(
    {
      gameweek: 7,
      status: "live",
      me: { userId: 1, name: "Alex", score: 41, progress: { total: 11, done: 6, inPlay: 3, toCome: 2, blank: 0 } },
      opponent: null,
    },
    { leagueSize: 9 },
  );
  assert.match(html, /You play Average/);
  assert.match(html, /6 done · 3 in play · 2 to come/);
});

test("a pre-season matchup reads as upcoming and names the season start, with no countdown", () => {
  // The owner's first complaint: pre-season, an unplayed fixture rendered as a
  // 0-0 scoreline with in-season deadline language wrapped around it.
  const seasonStart = Date.parse("2026-08-21T19:00:00Z");
  const html = renderFantasyMatchupPanel(
    {
      gameweek: 1,
      status: "scheduled",
      me: { userId: 1, name: "Mark", score: 0 },
      opponent: { userId: 2, name: "Rory", score: 0 },
      kickoff: seasonStart,
      deadline: seasonStart - 2 * 60 * 60 * 1000,
      locked: false,
      preseason: true,
      seasonStart,
    },
    { now: Date.parse("2026-07-28T21:00:00Z") },
  );

  assert.match(html, /Season starts/);
  assert.match(html, /fantasy-deadline--preseason/);
  assert.match(html, /fantasy-stat--empty/, "no scoreline before a ball is kicked");
  assert.doesNotMatch(html, /fantasy-deadline__countdown/, "a countdown three weeks out is the reported bug");
  assert.doesNotMatch(html, /waiver run/i);
});

test("an in-season matchup carries a live deadline countdown", () => {
  const kickoff = Date.parse("2026-10-24T14:00:00Z");
  const deadline = kickoff - 2 * 60 * 60 * 1000;
  const html = renderFantasyMatchupPanel(
    {
      gameweek: 9,
      status: "scheduled",
      me: { userId: 1, name: "Mark", score: 0 },
      opponent: { userId: 2, name: "Rory", score: 0 },
      kickoff,
      deadline,
      locked: false,
      preseason: false,
    },
    { now: deadline - 3 * 60 * 60 * 1000 },
  );
  assert.match(html, /fantasy-deadline__countdown/);
  assert.match(html, /3h 0m/);
  // The raw instant rides on the banner so app.js can re-tick it in place
  // without a full re-render.
  assert.match(html, new RegExp(`data-fantasy-deadline="${deadline}"`));
});

test("a locked matchup says the squad is locked and stops counting down", () => {
  const kickoff = Date.parse("2026-10-24T14:00:00Z");
  const deadline = kickoff - 2 * 60 * 60 * 1000;
  const html = renderFantasyMatchupPanel(
    {
      gameweek: 9,
      status: "scheduled",
      me: { userId: 1, name: "Mark", score: 0 },
      opponent: { userId: 2, name: "Rory", score: 0 },
      kickoff,
      deadline,
      locked: true,
      preseason: false,
    },
    { now: deadline + 60 * 1000 },
  );
  assert.match(html, /fantasy-deadline--locked/);
  assert.match(html, /squad locked/i);
  assert.doesNotMatch(html, /fantasy-deadline__countdown/);
});

test("renderFantasyMatchupPanel highlights the leading side once the matchup has started", () => {
  const html = renderFantasyMatchupPanel({
    gameweek: 7,
    status: "live",
    me: { userId: 1, name: "Alex", score: 42 },
    opponent: { userId: 2, name: "Sam", score: 37 },
  });
  const [meSide] = html.match(/<div class="fantasy-matchup__side [^"]*">[\s\S]*?Alex[\s\S]*?<\/div>/) ?? [];
  assert.ok(meSide);
  assert.match(meSide, /is-ahead/);
  assert.match(html, /42/);
  assert.match(html, /37/);
  assert.match(html, /fantasy-matchup__bar-me/);
});

test("renderFantasyMatchupPanel escapes manager names", () => {
  const html = renderFantasyMatchupPanel({
    gameweek: 7,
    status: "final",
    me: { userId: 1, name: `<script>alert(1)</script>`, score: 10 },
    opponent: { userId: 2, name: "Sam", score: 5 },
  });
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
});

// -- Standings panel (Phase 4.3) ---------------------------------------------------

test("renderFantasyStandingsPanel shows a loading note before standings have loaded, or the error state with retry on failure", () => {
  const loading = renderFantasyStandingsPanel(null, {});
  assert.match(loading, /Loading standings/);

  const failed = renderFantasyStandingsPanel(null, { error: "Couldn't load the standings." });
  assert.match(failed, /fantasy-form__error/);
  assert.match(failed, /Couldn&#39;t load the standings\./);
  assert.match(failed, /data-fantasy-standings-retry/);
});

test("renderFantasyStandingsPanel shows a generic (non gameweek-1-specific) empty state when throughGameweek is 0", () => {
  const html = renderFantasyStandingsPanel({ throughGameweek: 0, standings: [] }, {});
  assert.match(html, /Standings appear once your league's first gameweek finishes/);
  assert.doesNotMatch(html, /gameweek 1/i);
});

test("renderFantasyStandingsPanel renders every column and highlights the caller's own row", () => {
  const standings = {
    throughGameweek: 6,
    standings: [
      { userId: 12, name: "Alex", played: 6, wins: 4, draws: 1, losses: 1, pointsFor: 320, pointsAgainst: 260, recordPoints: 13 },
      { userId: 19, name: "Sam", played: 6, wins: 3, draws: 1, losses: 2, pointsFor: 300, pointsAgainst: 280, recordPoints: 10 },
    ],
  };
  const html = renderFantasyStandingsPanel(standings, { myUserId: 19 });
  assert.match(html, /Alex/);
  assert.match(html, /Sam/);
  assert.match(html, />13</);
  assert.match(html, />10</);
  assert.match(html, /Through gameweek 6/);
  const samRow = html.match(/<div class="fantasy-standings-row[^"]*">[\s\S]*?Sam[\s\S]*?<\/div>/)[0];
  assert.match(samRow, /is-me/);
  const alexRow = html.match(/<div class="fantasy-standings-row[^"]*">[\s\S]*?Alex[\s\S]*?<\/div>/)[0];
  assert.doesNotMatch(alexRow, /is-me/);
});

test("renderFantasyStandingsPanel escapes manager names", () => {
  const standings = {
    throughGameweek: 2,
    standings: [{ userId: 1, name: `<script>alert(1)</script>`, played: 2, wins: 2, draws: 0, losses: 0, pointsFor: 80, pointsAgainst: 40, recordPoints: 6 }],
  };
  const html = renderFantasyStandingsPanel(standings, {});
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
});

// -- Waivers panel (Phase 4.4) -----------------------------------------------

function waiverPlayer(id, position, name = `Player ${id}`, team = "Test FC") {
  return { id, name, team, position };
}

function waiversFixture(overrides = {}) {
  return {
    mode: "faab",
    faabBudget: 100,
    myBudgetRemaining: 80,
    myPriority: 3,
    currentGameweek: 7,
    priorities: [
      { userId: 1, name: "Alice", priority: 1, budgetRemaining: 100 },
      { userId: 2, name: "Bob", priority: 2, budgetRemaining: 90 },
      { userId: 3, name: "Me", priority: 3, budgetRemaining: 80 },
    ],
    freeAgents: [waiverPlayer(10, "MID", "Free Mid")],
    wire: [{ player: waiverPlayer(11, "DEF", "Wire Def"), clearsAfterGameweek: 8 }],
    myClaims: [],
    lastRun: null,
    ...overrides,
  };
}

test("renderFantasyWaiversPanel shows a loading note before waivers have loaded, or the error state with retry on failure", () => {
  const loading = renderFantasyWaiversPanel(null, {});
  assert.match(loading, /Loading waivers/);

  const failed = renderFantasyWaiversPanel(null, { error: "Couldn't load waivers." });
  assert.match(failed, /fantasy-form__error/);
  assert.match(failed, /Couldn&#39;t load waivers\./);
  assert.match(failed, /data-fantasy-waivers-retry/);
});

test("renderFantasyWaiversPanel shows a no-free-agents note for an empty free-agent list", () => {
  const html = renderFantasyWaiversPanel(waiversFixture({ freeAgents: [] }), { myUserId: 3, roster: [] });
  assert.match(html, /No free agents match/);
});

test("renderFantasyWaiversPanel lists wire players with a Claim action and their clear gameweek", () => {
  const html = renderFantasyWaiversPanel(waiversFixture(), { myUserId: 3, roster: [] });
  assert.match(html, /Wire Def/);
  assert.match(html, /data-fantasy-wire-claim="11"/);
  assert.match(html, /Clears after GW 8/);
});

test("renderFantasyWaiversPanel's status header explains faab mode and shows the caller's budget", () => {
  const html = renderFantasyWaiversPanel(waiversFixture({ mode: "faab" }), { myUserId: 3, roster: [] });
  assert.match(html, /Blind bidding/);
  assert.doesNotMatch(html, /FAAB/); // issue #35: no unexplained acronyms in the UI
  assert.match(html, /highest bid wins/i);
  assert.match(html, /80/); // myBudgetRemaining
  assert.match(html, /league budget 100/);
  assert.doesNotMatch(html, /Your priority:/);
});

test("renderFantasyWaiversPanel's status header explains rolling mode and shows the caller's priority ordinal instead of a budget", () => {
  const html = renderFantasyWaiversPanel(waiversFixture({ mode: "rolling", myPriority: 3 }), { myUserId: 3, roster: [] });
  assert.match(html, /Rolling list/);
  assert.match(html, /back of the queue/i);
  assert.match(html, /Your priority:.*3rd of 3/s);
  assert.doesNotMatch(html, /credits left/);
});

test("renderFantasyWaiversPanel points the commissioner at Settings instead of carrying its own settings form", () => {
  // The mode/budget form lives on the Settings tab only; a second copy here is
  // exactly the duplicated-settings smell this replaced.
  const commissionerView = renderFantasyWaiversPanel(waiversFixture(), { myUserId: 3, roster: [], isCommissioner: true });
  assert.match(commissionerView, /data-fantasy-subtab="settings"/);
  assert.doesNotMatch(commissionerView, /data-fantasy-settings-save/);

  const memberView = renderFantasyWaiversPanel(waiversFixture(), { myUserId: 3, roster: [], isCommissioner: false });
  assert.doesNotMatch(memberView, /data-fantasy-subtab="settings"/);
  assert.doesNotMatch(memberView, /data-fantasy-settings-save/);
});

test("the settings tab disables the waiver form and explains why when the caller has a pending claim", () => {
  const withPending = waiversFixture({ myClaims: [{ claimId: 1, addPlayerId: 11, dropPlayerId: 20, bid: 10, priority: 1, status: "pending", reason: null, gameweek: 7 }] });
  const html = renderFantasySettingsPanel(
    { name: "L", draftStatus: "complete", isCommissioner: true },
    [{ userId: 1, name: "Me" }],
    { seats: { total: 10, humans: 1, bots: 0, open: 9 }, schedule: null, waivers: withPending },
  );
  assert.match(html, /data-fantasy-settings-save[^>]*disabled/);
  assert.match(html, /can't change until it resolves/);
});

test("renderFantasyWaiversPanel's my-claims section shows a pending claim with a Cancel action and a resolved one with its rejection reason", () => {
  const html = renderFantasyWaiversPanel(
    waiversFixture({
      myClaims: [
        { claimId: 1, addPlayerId: 11, dropPlayerId: 20, bid: 15, priority: 1, status: "pending", reason: null, gameweek: 7 },
        { claimId: 2, addPlayerId: 12, dropPlayerId: 21, bid: 5, priority: 1, status: "rejected", reason: "Outbid", gameweek: 6 },
      ],
      roster: [
        { id: 20, name: "My Def", team: "Test FC", position: "DEF" },
        { id: 21, name: "My Fwd", team: "Test FC", position: "FWD" },
      ],
    }),
    { myUserId: 3, roster: [{ id: 20, name: "My Def", team: "Test FC", position: "DEF" }, { id: 21, name: "My Fwd", team: "Test FC", position: "FWD" }] },
  );
  assert.match(html, /data-fantasy-waiver-cancel-claim="1"/);
  assert.match(html, /Outbid/);
  assert.doesNotMatch(html, /data-fantasy-waiver-cancel-claim="2"/);
});

test("renderFantasyWaiversPanel's last-run section shows a calm note when no run has resolved yet, or a compact summary otherwise", () => {
  const noRun = renderFantasyWaiversPanel(waiversFixture({ lastRun: null }), { myUserId: 3, roster: [] });
  assert.match(noRun, /No waiver run has resolved yet/);

  const withRun = renderFantasyWaiversPanel(
    waiversFixture({
      lastRun: {
        gameweek: 6,
        processedAt: "2026-07-20T00:00:00Z",
        results: [{ claimId: 5, userId: 1, status: "rejected", reason: "Outbid", addPlayerId: 11, dropPlayerId: 20, bid: 10 }],
      },
      wire: [{ player: waiverPlayer(11, "DEF", "Wire Def"), clearsAfterGameweek: 8 }],
    }),
    { myUserId: 3, roster: [], members: [{ userId: 1, name: "Alice" }] },
  );
  assert.match(withRun, /Last run · Gameweek 6/);
  assert.match(withRun, /Alice/);
  assert.match(withRun, /Wire Def/);
  assert.match(withRun, /Outbid/);
});

test("renderFantasyWaiversPanel escapes manager and player names throughout", () => {
  const html = renderFantasyWaiversPanel(
    waiversFixture({
      priorities: [{ userId: 1, name: `<script>alert(1)</script>`, priority: 1, budgetRemaining: 100 }],
      freeAgents: [waiverPlayer(10, "MID", `<b>Bad</b>`)],
    }),
    { myUserId: 3, roster: [] },
  );
  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /<b>Bad<\/b>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;b&gt;Bad&lt;\/b&gt;/);
});

// -- Free agent / wire row filtering ------------------------------------------

test("renderFantasyFreeAgentRows filters by position, club and search text like the draft pool", () => {
  const players = [waiverPlayer(1, "GK", "Alisson", "Liverpool"), waiverPlayer(2, "FWD", "Haaland", "Man City")];
  const gkOnly = renderFantasyFreeAgentRows(players, { position: "GK", search: "" });
  assert.match(gkOnly, /Alisson/);
  assert.doesNotMatch(gkOnly, /Haaland/);
});

test("renderFantasyFreeAgentRows shows an Add action per row", () => {
  const html = renderFantasyFreeAgentRows([waiverPlayer(1, "MID")], { position: "All", search: "" });
  assert.match(html, /data-fantasy-fa-add="1"/);
  assert.match(html, />Add</);
});

test("renderFantasyFreeAgentRows shows a Locked chip instead of Add for a locked player id", () => {
  const players = [waiverPlayer(1, "MID", "Locked Mid"), waiverPlayer(2, "MID", "Open Mid")];
  const html = renderFantasyFreeAgentRows(players, { position: "All", search: "" }, new Set([1]));
  assert.match(html, /fantasy-chip--locked/);
  assert.match(html, />Locked</);
  assert.doesNotMatch(html, /data-fantasy-fa-add="1"/);
  assert.match(html, /data-fantasy-fa-add="2"/); // player 2 is not locked, still gets an Add button
});

test("renderFantasyFreeAgentRows shows an Add action, not Locked, when no lockedIds are given", () => {
  const html = renderFantasyFreeAgentRows([waiverPlayer(1, "MID")], { position: "All", search: "" });
  assert.doesNotMatch(html, /fantasy-chip--locked/);
  assert.match(html, /data-fantasy-fa-add="1"/);
});

// -- Free-agent decision stats ------------------------------------------------
//
// The panel used to carry a crest, a name, a club, a position pill and a
// button, and nothing a transfer decision could be made from.

const FA_CONTEXT = {
  statsById: new Map([
    [1, { id: 1, xp: 4.6, xpBasis: "history" }],
    [2, { id: 2, xp: 3.2, xpBasis: "estimate" }],
    // Player 3 deliberately absent: no xP at all.
  ]),
  starters: [
    { position: "MID", xp: 5.4 },
    { position: "MID", xp: 3.1 },
  ],
  seasonPoints: new Map([[1, 82]]),
  // `seasons` is a list of season-start years (see xpSeasonsLabel), not a count.
  xpStats: { seasons: [2025, 2024, 2023] },
};

test("a free-agent row quotes xP the same way the draft board does", () => {
  const html = renderFantasyFreeAgentRows([waiverPlayer(1, "MID")], { position: "All", search: "" }, null, FA_CONTEXT);
  assert.match(html, /xP 4\.6/);
  assert.match(html, /fantasy-fa-row__xp/);
  // A measured figure is NOT marked as an estimate.
  assert.doesNotMatch(html, /fantasy-fa-row__xp is-estimate/);
});

test("a cohort-derived xP keeps its is-estimate treatment on the free-agent row", () => {
  const html = renderFantasyFreeAgentRows([waiverPlayer(2, "MID")], { position: "All", search: "" }, null, FA_CONTEXT);
  assert.match(html, /xP 3\.2/);
  assert.match(html, /is-estimate/, "an estimate must never read as this player's own record");
});

test("a player with no xP gets the existing dim placeholder, never a fabricated zero", () => {
  const html = renderFantasyFreeAgentRows([waiverPlayer(3, "MID")], { position: "All", search: "" }, null, FA_CONTEXT);
  assert.match(html, /xP •/);
  assert.match(html, /is-empty/);
  assert.doesNotMatch(html, /xP 0/);
  // With no xP there is no honest upgrade figure either.
  assert.doesNotMatch(html, /fantasy-fa-row__delta/);
});

test("the row shows the gain over the manager's own worst starter at that position", () => {
  // Worst starting MID is 3.1; this free agent is 4.6, so +1.5.
  const html = renderFantasyFreeAgentRows([waiverPlayer(1, "MID")], { position: "All", search: "" }, null, FA_CONTEXT);
  assert.match(html, /\+1\.5/);
  assert.match(html, /is-up/);
  assert.match(html, /worst starting MID/);
});

test("a downgrade is shown as negative rather than hidden", () => {
  const context = { ...FA_CONTEXT, statsById: new Map([[1, { id: 1, xp: 2.0, xpBasis: "history" }]]) };
  const html = renderFantasyFreeAgentRows([waiverPlayer(1, "MID")], { position: "All", search: "" }, null, context);
  assert.match(html, /-1\.1/);
  assert.match(html, /is-down/);
});

test("with no lineup loaded there is no upgrade figure at all, not one on another basis", () => {
  const context = { ...FA_CONTEXT, starters: [] };
  const html = renderFantasyFreeAgentRows([waiverPlayer(1, "MID")], { position: "All", search: "" }, null, context);
  assert.match(html, /xP 4\.6/, "xP still shows; it does not depend on the lineup");
  assert.doesNotMatch(html, /fantasy-fa-row__delta/);
});

test("REGRESSION: the free-agent panel never says 'nothing is locked' above locked rows", () => {
  // Pre-season and locked overlap for the two hours between gameweek 1's
  // deadline and the opening kickoff. Branching the lock sentence on pre-season
  // alone put "Pre-season, so nothing is locked" directly above fifteen rows
  // each showing a Locked chip. Caught by driving the real app, not by a test.
  const waivers = {
    mode: "faab",
    faabBudget: 100,
    myBudgetRemaining: 100,
    currentGameweek: 1,
    priorities: [],
    freeAgents: [waiverPlayer(1, "MID", "Someone")],
    wire: [],
    myClaims: [],
    lastRun: null,
    lockedPlayerIds: [1],
    preseason: true,
    squadLocked: true,
    seasonStart: Date.parse("2026-08-21T19:00:00Z"),
    squadDeadline: Date.parse("2026-08-21T17:00:00Z"),
    seasonPoints: {},
  };
  const html = renderFantasyWaiversPanel(waivers, { myUserId: 1, roster: [], now: Date.parse("2026-08-21T18:00:00Z") });

  assert.match(html, /fantasy-chip--locked/, "the row is locked");
  assert.doesNotMatch(html, /nothing is locked/, "the panel must not contradict its own rows");
  assert.match(html, /squad deadline has passed/);
});

test("season points show once played and are omitted entirely before any match", () => {
  const played = renderFantasyFreeAgentRows([waiverPlayer(1, "MID")], { position: "All", search: "" }, null, FA_CONTEXT);
  assert.match(played, /82 pts/);

  // Pre-season: the table is empty, so the map is empty. A 0 here would read
  // as "this player is worthless" rather than "no games played yet".
  const preseason = renderFantasyFreeAgentRows(
    [waiverPlayer(1, "MID")],
    { position: "All", search: "" },
    null,
    { ...FA_CONTEXT, seasonPoints: new Map() },
  );
  assert.doesNotMatch(preseason, /pts</);
  assert.doesNotMatch(preseason, /0 pts/);
});

test("renderFantasyWireRows filters by position and shows a Claim action per row", () => {
  const wire = [
    { player: waiverPlayer(1, "GK", "Alisson", "Liverpool"), clearsAfterGameweek: 5 },
    { player: waiverPlayer(2, "FWD", "Haaland", "Man City"), clearsAfterGameweek: 5 },
  ];
  const gkOnly = renderFantasyWireRows(wire, { position: "GK", search: "" });
  assert.match(gkOnly, /Alisson/);
  assert.doesNotMatch(gkOnly, /Haaland/);
  assert.match(gkOnly, /data-fantasy-wire-claim="1"/);
});

// -- Claim flow (add/claim confirm step) --------------------------------------

test("renderFantasyClaimFlow lists only same-position roster players as drop candidates and explains why", () => {
  const roster = [
    { id: 20, name: "My Def One", team: "Test FC", position: "DEF" },
    { id: 21, name: "My Def Two", team: "Test FC", position: "DEF" },
    { id: 22, name: "My Mid", team: "Test FC", position: "MID" },
  ];
  const flow = { addPlayer: waiverPlayer(10, "DEF", "New Def"), path: "free_agent", dropPlayerId: null };
  const html = renderFantasyClaimFlow(flow, { roster, mode: "faab" });
  assert.match(html, /My Def One/);
  assert.match(html, /My Def Two/);
  assert.doesNotMatch(html, /My Mid/);
  // The rule moved into a hint; the visible line names the action.
  assert.match(html, /Drop one of your DEFs/);
  assert.match(html, /same position/);
  assert.doesNotMatch(html, /data-fantasy-claim-bid/); // free-agent path never bids
});

test("renderFantasyClaimFlow shows a bid field only for a waiver claim in faab mode", () => {
  const roster = [{ id: 20, name: "My Def", team: "Test FC", position: "DEF" }];
  const flow = { addPlayer: waiverPlayer(10, "DEF", "Wire Def"), path: "waiver", dropPlayerId: null };
  const faab = renderFantasyClaimFlow(flow, { roster, mode: "faab" });
  assert.match(faab, /data-fantasy-claim-bid/);

  const rolling = renderFantasyClaimFlow(flow, { roster, mode: "rolling" });
  assert.doesNotMatch(rolling, /data-fantasy-claim-bid/);
});

test("renderFantasyClaimFlow disables submit until a drop candidate is selected, and enables it once one is", () => {
  const roster = [{ id: 20, name: "My Def", team: "Test FC", position: "DEF" }];
  const flow = { addPlayer: waiverPlayer(10, "DEF"), path: "free_agent", dropPlayerId: null };
  const noSelection = renderFantasyClaimFlow(flow, { roster, mode: "faab" });
  assert.match(noSelection, /data-fantasy-claim-submit[^>]*disabled/);

  const selected = renderFantasyClaimFlow({ ...flow, dropPlayerId: 20 }, { roster, mode: "faab" });
  assert.doesNotMatch(selected, /data-fantasy-claim-submit[^>]*disabled/);
  assert.match(selected, /is-selected/);
});

test("renderFantasyClaimFlow explains when the caller has no same-position player to drop", () => {
  const roster = [{ id: 20, name: "My Mid", team: "Test FC", position: "MID" }];
  const flow = { addPlayer: waiverPlayer(10, "FWD"), path: "free_agent", dropPlayerId: null };
  const html = renderFantasyClaimFlow(flow, { roster, mode: "faab" });
  assert.match(html, /You have no FWD to drop/);
  assert.match(html, /data-fantasy-claim-submit[^>]*disabled/);
});

test("renderFantasyClaimFlow excludes a locked roster player from drop candidates on the free-agent path, and explains why", () => {
  const roster = [
    { id: 20, name: "Locked Def", team: "Test FC", position: "DEF" },
    { id: 21, name: "Open Def", team: "Test FC", position: "DEF" },
  ];
  const flow = { addPlayer: waiverPlayer(10, "DEF", "New Def"), path: "free_agent", dropPlayerId: null };
  const html = renderFantasyClaimFlow(flow, { roster, mode: "faab", lockedIds: new Set([20]) });
  assert.doesNotMatch(html, /Locked Def/);
  assert.match(html, /Open Def/);
  assert.match(html, /Locked players are hidden/);
});

test("renderFantasyClaimFlow does not filter locked players out of drop candidates on the waiver-claim path", () => {
  const roster = [{ id: 20, name: "Locked Def", team: "Test FC", position: "DEF" }];
  const flow = { addPlayer: waiverPlayer(10, "DEF", "Wire Def"), path: "waiver", dropPlayerId: null };
  const html = renderFantasyClaimFlow(flow, { roster, mode: "faab", lockedIds: new Set([20]) });
  // A queued claim resolves at the next gameweek boundary, long after this
  // gameweek's matches are decided, so the kickoff lock has nothing to say
  // about it (see CLAUDE.md/runLeagueWaiverRun): the drop candidate must
  // still be offered.
  assert.match(html, /Locked Def/);
  assert.doesNotMatch(html, /list is shorter than usual/);
});

test("renderFantasyClaimFlow explains a fully-locked same-position roster distinctly from having none at all", () => {
  const roster = [{ id: 20, name: "Locked Def", team: "Test FC", position: "DEF" }];
  const flow = { addPlayer: waiverPlayer(10, "DEF", "New Def"), path: "free_agent", dropPlayerId: null };
  const html = renderFantasyClaimFlow(flow, { roster, mode: "faab", lockedIds: new Set([20]) });
  assert.match(html, /You have no DEF to drop that isn't locked/);
});

test("renderFantasyClaimFlow surfaces a submit error in the shared form-error style", () => {
  const roster = [{ id: 20, name: "My Def", team: "Test FC", position: "DEF" }];
  const flow = { addPlayer: waiverPlayer(10, "DEF"), path: "free_agent", dropPlayerId: 20, error: "Player is not a free agent" };
  const html = renderFantasyClaimFlow(flow, { roster, mode: "faab" });
  assert.match(html, /fantasy-form__error/);
  assert.match(html, /Player is not a free agent/);
});

// -- Bot managers: labelled everywhere they appear -------------------------------
//
// The product requirement these enforce: a user must never be misled into
// thinking they are playing a person. That is not one chip in one place, it is
// every surface a manager's name reaches.

const botMembers = [
  { userId: 1, name: "Alice", draftPosition: 1, isBot: false },
  { userId: 2, name: "Bot Alfie", draftPosition: 2, isBot: true },
];

test("the lobby labels a bot manager and never reports a bare manager total that counts one", () => {
  const html = renderFantasyLobby(lobbyLeague(), botMembers, {
    playerPool: null,
    filter: { position: "All", search: "" },
    seats: { total: 2, humans: 1, bots: 1, open: 8, max: 10 },
  });
  assert.match(html, /fantasy-chip--bot/);
  // The heading has to split the count: "2 managers" would imply two people.
  assert.match(html, /1 manager · 1 bot · 2\/10 seats/);
});

test("bot seat controls live on the settings tab, and a seated bot can be removed there while pending", () => {
  const html = renderFantasySettingsPanel(lobbyLeague({ draftStatus: "pending" }), botMembers, {
    seats: { total: 2, humans: 1, bots: 1, open: 8, max: 10 },
    schedule: null,
  });
  assert.match(html, /data-fantasy-add-bots/);
  assert.match(html, /data-fantasy-bot-count/);
  assert.match(html, /autopicks its squad/);
  assert.match(html, /data-fantasy-remove-bot="2"/);
});

test("the lobby itself carries no bot controls, only the seat split and the bot chip", () => {
  // The controls moved to Settings; the lobby still tells the room who is a
  // bot (the chip on the member row and the split in the heading), because
  // hiding that would imply real people where none sit.
  const html = renderFantasyLobby(lobbyLeague(), botMembers, {
    playerPool: null,
    filter: { position: "All", search: "" },
    seats: { total: 2, humans: 1, bots: 1, open: 8, max: 10 },
  });
  assert.doesNotMatch(html, /data-fantasy-add-bots/);
  assert.doesNotMatch(html, /data-fantasy-remove-bot/);
  assert.match(html, /1 manager · 1 bot/);
  assert.match(html, /fantasy-chip--bot/);
});

test("the invite card leads with a shareable link and keeps the raw code below it", () => {
  const html = renderFantasyLobby(lobbyLeague(), botMembers, {
    playerPool: null,
    filter: { position: "All", search: "" },
    inviteUrl: "https://kickoffdraft.com/#join/AB12CD34",
  });
  assert.match(html, /data-fantasy-copy-invite="https:\/\/kickoffdraft\.com\/#join\/AB12CD34"/);
  assert.match(html, /Copy link/);
  assert.match(html, /data-fantasy-copy-invite="AB12CD34"/);
  assert.match(html, /sees the league before being asked to sign in/);
});

test("the standings table labels a bot row", () => {
  const html = renderFantasyStandingsPanel(
    {
      throughGameweek: 3,
      standings: [
        { userId: 2, name: "Bot Alfie", isBot: true, played: 3, wins: 2, draws: 0, losses: 1, pointsFor: 150, pointsAgainst: 140, recordPoints: 6 },
        { userId: 1, name: "Alice", isBot: false, played: 3, wins: 1, draws: 0, losses: 2, pointsFor: 140, pointsAgainst: 150, recordPoints: 3 },
      ],
    },
    { myUserId: 1 },
  );
  assert.equal(html.match(/fantasy-chip--bot/g).length, 1);
});

test("the matchup card labels a bot opponent", () => {
  const html = renderFantasyMatchupPanel({
    gameweek: 4,
    status: "live",
    me: { userId: 1, name: "Alice", score: 42 },
    opponent: { userId: 2, name: "Bot Alfie", isBot: true, score: 38 },
  });
  assert.match(html, /fantasy-chip--bot/);
});

test("the post-draft roster board labels a bot's squad card", () => {
  const html = renderFantasyComplete(botMembers, []);
  assert.equal(html.match(/fantasy-chip--bot/g).length, 1);
});

// -- The public invite preview ----------------------------------------------------

function invitePreview(overrides = {}) {
  return {
    league: {
      name: "Sunday League",
      draftStatus: "pending",
      joinable: true,
      seats: { total: 3, humans: 2, bots: 1, open: 7, max: 10 },
      ...overrides.league,
    },
    managers: overrides.managers ?? [
      { name: "Alice", isBot: false, isCommissioner: true },
      { name: "Bo", isBot: false, isCommissioner: false },
      { name: "Bot Alfie", isBot: true, isCommissioner: false },
    ],
  };
}

test("the invite preview explains the league and mounts sign-in LAST, not first", () => {
  const html = renderFantasyInvitePreview(invitePreview(), { signedIn: false });
  assert.match(html, /Sunday League/);
  assert.match(html, /What you're joining/);
  assert.match(html, /Alice/);
  // The sign-in slot must come AFTER the explanation, since the whole point is
  // that nobody meets a sign-in wall before knowing what is behind it.
  assert.ok(html.indexOf("What you're joining") < html.indexOf("gisButton"));
  assert.doesNotMatch(html, /data-fantasy-invite-join/);
});

test("the invite preview counts bots separately and labels them", () => {
  const html = renderFantasyInvitePreview(invitePreview(), { signedIn: false });
  assert.match(html, /Managers · 2 \+ 1 bot · 7 seats open/);
  assert.match(html, /fantasy-chip--bot/);
});

test("an already-signed-in visitor gets an explicit Join button, never an automatic join", () => {
  const html = renderFantasyInvitePreview(invitePreview(), { signedIn: true });
  assert.match(html, /data-fantasy-invite-join/);
  assert.doesNotMatch(html, /gisButton/);
});

test("the invite preview refuses to offer a join for a league that cannot take one", () => {
  const started = renderFantasyInvitePreview(
    invitePreview({ league: { name: "Sunday League", draftStatus: "drafting", joinable: false, seats: { total: 10, humans: 10, bots: 0, open: 0, max: 10 } } }),
    { signedIn: true },
  );
  assert.doesNotMatch(started, /data-fantasy-invite-join/);
  assert.match(started, /already started its draft/);

  const full = renderFantasyInvitePreview(
    invitePreview({ league: { name: "Sunday League", draftStatus: "pending", joinable: false, seats: { total: 10, humans: 10, bots: 0, open: 0, max: 10 } } }),
    { signedIn: true },
  );
  assert.match(full, /This league is full/);
});

test("the invite preview escapes a league name and a manager name containing HTML", () => {
  const html = renderFantasyInvitePreview(
    invitePreview({
      league: { name: "<img src=x onerror=1>", draftStatus: "pending", joinable: true, seats: { total: 1, humans: 1, bots: 0, open: 9, max: 10 } },
      managers: [{ name: "<script>alert(1)</script>", isBot: false, isCommissioner: true }],
    }),
    { signedIn: false },
  );
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
});

test("a bad invite code renders an honest dead end rather than a spinner", () => {
  const html = renderFantasyInvitePreview(null, { error: "That invite code doesn't match any league." });
  assert.match(html, /This invite doesn't work/);
  assert.match(html, /doesn&#39;t match any league/);
});

test("the league header chip never reports a bare manager total that counts bots", () => {
  const withBots = renderFantasyLeagueHeader(lobbyLeague(), botMembers, "draftroom");
  assert.match(withBots, /1 manager · 1 bot/);
  assert.doesNotMatch(withBots, />2 managers</);
  // A league with no bots keeps exactly the wording it always had.
  const humansOnly = renderFantasyLeagueHeader(lobbyLeague(), [{ userId: 1, name: "Alice" }, { userId: 2, name: "Bo" }], "draftroom");
  assert.match(humansOnly, /2 managers/);
});

// -- Draft board markers inside the pool and the sub-tab bar --------------------

test("the pool sorts by the manager's own board when the Board pill is chosen", () => {
  const players = [
    { ...pooledPlayer(1, "MID", "Alpha"), xp: 9 },
    { ...pooledPlayer(2, "MID", "Bravo"), xp: 8 },
    { ...pooledPlayer(3, "MID", "Charlie"), xp: 7 },
  ];
  const board = { order: [3, 1, 2], tierBreaks: [], notes: {} };
  const html = renderFantasyPlayerRows(
    players,
    { position: "All", search: "", sort: "board" },
    { isMyTurn: false, myRoster: [], draftedIds: new Set(), leagueSize: 4, board },
  );
  assert.ok(html.indexOf("Charlie") < html.indexOf("Alpha"));
  assert.ok(html.indexOf("Alpha") < html.indexOf("Bravo"));
});

test("a pool row carries the board's tier chip only once more than one tier exists", () => {
  const players = [
    { ...pooledPlayer(1, "MID", "Alpha"), xp: 9 },
    { ...pooledPlayer(2, "MID", "Bravo"), xp: 8 },
  ];
  const context = { isMyTurn: false, myRoster: [], draftedIds: new Set(), leagueSize: 4 };
  const flat = renderFantasyPlayerRows(players, { position: "All", search: "" }, {
    ...context,
    board: { order: [1, 2], tierBreaks: [], notes: {} },
  });
  assert.doesNotMatch(flat, /fantasy-board-chip/);

  const tiered = renderFantasyPlayerRows(players, { position: "All", search: "" }, {
    ...context,
    board: { order: [1, 2], tierBreaks: [2], notes: {} },
  });
  assert.match(tiered, /fantasy-board-chip">T1</);
  assert.match(tiered, /fantasy-board-chip">T2</);
});

test("a pool row shows the manager's own note, escaped, at the moment of the pick", () => {
  const players = [{ ...pooledPlayer(1, "MID", "Alpha"), xp: 9 }];
  const html = renderFantasyPlayerRows(players, { position: "All", search: "" }, {
    isMyTurn: false,
    myRoster: [],
    draftedIds: new Set(),
    leagueSize: 4,
    board: { order: [1], tierBreaks: [], notes: { 1: `set-piece "specialist" & penalties` } },
  });
  assert.match(html, /fantasy-board-note-mark/);
  assert.match(html, /set-piece &quot;specialist&quot; &amp; penalties/);
});

test("the draft room's side column carries the board card and the suggested pick's note", () => {
  const members = [
    { userId: 1, name: "Me" },
    { userId: 2, name: "Them" },
  ];
  const players = [
    { ...pooledPlayer(10, "GK", "Keeper"), xp: 5 },
    { ...pooledPlayer(11, "MID", "Middle"), xp: 9 },
  ];
  const html = renderFantasyDraftRoom({
    members,
    draft: {
      status: "drafting",
      memberIds: [1, 2],
      round: 1,
      pickInRound: 1,
      overallPick: 1,
      onClockUserId: 1,
      picks: [],
      rosters: { 1: [], 2: [] },
      remainingMs: 30000,
    },
    playerPool: players,
    filter: { position: "All", search: "" },
    myUserId: 1,
    queue: [],
    board: { order: [11, 10], tierBreaks: [10], notes: { 11: "happy to take him a round early" } },
  });
  assert.match(html, /class="card fantasy-board fantasy-board--compact/);
  assert.match(html, /data-board-rows/);
  // The suggestion is the best player on the board with an open bucket (the
  // midfielder, xP 9, not the keeper), so its note is the one that must be in
  // front of a manager on the clock.
  assert.match(html, /Your note: happy to take him a round early/);
});

test("My board and Waivers are each live for exactly one half of a league's life", () => {
  const members = [{ userId: 1, name: "Me" }];
  const pending = renderFantasyLeagueHeader({ name: "L", draftStatus: "pending" }, members, "board");
  assert.match(pending, /data-fantasy-subtab="board" >My board/);
  assert.match(pending, /data-fantasy-subtab="waivers" disabled/);

  const complete = renderFantasyLeagueHeader({ name: "L", draftStatus: "complete" }, members, "feed");
  assert.match(complete, /data-fantasy-subtab="board" disabled/);
  assert.match(complete, /data-fantasy-subtab="waivers" >Waivers/);
});

test("an Average opponent renders as a real scoreline, chipped as AVG and never as a bot", () => {
  const html = renderFantasyMatchupPanel(
    {
      gameweek: 7,
      status: "final",
      me: { userId: 1, name: "Alex", score: 62 },
      opponent: { userId: 0, name: "Average", isBot: false, isAverage: true, score: 50 },
    },
    { leagueSize: 3 },
  );
  assert.match(html, /fantasy-matchup__vs/, "this is a fixture, not a bye card");
  assert.match(html, /fantasy-matchup__name">Average\s*<span/);
  assert.match(html, /fantasy-chip--average/);
  assert.doesNotMatch(html, /fantasy-chip--bot/, "Average is not a bot and must never be chipped as one");
  assert.match(html, />62</);
  assert.match(html, />50</);
});

test("standings round a floating-point points total instead of printing it raw", () => {
  // 297.6 as a sum of one-decimal scores is 297.59999999999997 in binary float,
  // and the table used to print every digit of it.
  const html = renderFantasyStandingsPanel(
    {
      throughGameweek: 5,
      standings: [
        { userId: 1, name: "Alex", played: 5, wins: 5, draws: 0, losses: 0, pointsFor: 297.59999999999997, pointsAgainst: 236.75, recordPoints: 15 },
      ],
    },
    { myUserId: 1 },
  );
  assert.match(html, />297\.6</);
  assert.match(html, />236\.8</);
  assert.doesNotMatch(html, /297\.59999/);
});

test("the Average row in standings is chipped AVG and never as a bot", () => {
  const html = renderFantasyStandingsPanel(
    {
      throughGameweek: 5,
      standings: [
        { userId: 0, name: "Average", isAverage: true, played: 5, wins: 1, draws: 0, losses: 4, pointsFor: 261.95, pointsAgainst: 315.7, recordPoints: 3 },
      ],
    },
    { myUserId: 1 },
  );
  assert.match(html, /fantasy-chip--average/);
  assert.doesNotMatch(html, /fantasy-chip--bot/);
});

// Issue #49: the pitch reads keeper-first, matching FPL, which is the reference
// product for anyone playing a Premier League fantasy game. It was previously
// attacker-first and a reporter hit exactly that confusion.
test("the pitch renders goalkeeper first and forwards last", () => {
  const roster = [
    { id: 1, name: "Keeper", team: "Arsenal", position: "GK" },
    { id: 2, name: "Backline", team: "Arsenal", position: "DEF" },
    { id: 3, name: "Middle", team: "Arsenal", position: "MID" },
    { id: 4, name: "Striker", team: "Arsenal", position: "FWD" },
  ];
  const html = renderFantasyRosterPanel({
    currentGameweek: 1,
    roster,
    lineup: {
      gameweek: 1,
      starters: [
        { playerId: 1, isCaptain: false },
        { playerId: 2, isCaptain: false },
        { playerId: 3, isCaptain: false },
        { playerId: 4, isCaptain: true },
      ],
      bench: [],
    },
    playerPool: [],
    picks: [],
    editState: null,
    drawerPlayerId: null,
    lineupError: "",
  });
  const order = ["Keeper", "Backline", "Middle", "Striker"].map((name) => html.indexOf(name));
  assert.ok(order.every((i) => i >= 0), "every player should render");
  assert.deepEqual(
    [...order].sort((a, b) => a - b),
    order,
    "pitch rows should run GK, DEF, MID, FWD from the top",
  );
});


// -- The defending champion (issue #43) -----------------------------------------

const CHAMPION_MEMBERS = [
  { userId: 1, name: "Alice", isChampion: false },
  { userId: 2, name: "Rory", isChampion: true },
  { userId: 7, name: "Bot Alfie", isBot: true, isChampion: false },
];

test("the standings table gives the trophy to exactly one manager", () => {
  const standings = {
    throughGameweek: 3,
    standings: [
      { userId: 2, name: "Rory", played: 3, wins: 3, draws: 0, losses: 0, pointsFor: 160, pointsAgainst: 120, recordPoints: 9 },
      { userId: 1, name: "Alice", played: 3, wins: 0, draws: 0, losses: 3, pointsFor: 120, pointsAgainst: 160, recordPoints: 0 },
    ],
  };
  const html = renderFantasyStandingsPanel(standings, { myUserId: 1, previousWinnerUserId: 2 });
  assert.equal(html.match(/fantasy-chip--champion/g).length, 1);
  const roryRow = html.match(/<div class="fantasy-standings-row[^"]*">[\s\S]*?Rory[\s\S]*?<\/div>/)[0];
  assert.match(roryRow, /fantasy-chip--champion/);
});

test("no champion recorded means no trophy anywhere, and Average never wears one", () => {
  const standings = {
    throughGameweek: 3,
    standings: [
      { userId: 1, name: "Alice", played: 3, wins: 2, draws: 0, losses: 1, pointsFor: 160, pointsAgainst: 120, recordPoints: 6 },
      // The Average opponent's sentinel id is 0 (src/fantasyAverage.js).
      { userId: 0, name: "Average", isAverage: true, played: 3, wins: 1, draws: 0, losses: 2, pointsFor: 120, pointsAgainst: 160, recordPoints: 3 },
    ],
  };
  assert.doesNotMatch(renderFantasyStandingsPanel(standings, { myUserId: 1 }), /fantasy-chip--champion/);
  assert.doesNotMatch(
    renderFantasyStandingsPanel(standings, { myUserId: 1, previousWinnerUserId: 0 }),
    /fantasy-chip--champion/,
  );
});

test("the matchup card marks a defending champion on either side", () => {
  const matchup = {
    gameweek: 4,
    status: "live",
    me: { userId: 1, name: "Alice", score: 42 },
    opponent: { userId: 2, name: "Rory", score: 38 },
  };
  const opponentHolds = renderFantasyMatchupPanel(matchup, { previousWinnerUserId: 2 });
  assert.equal(opponentHolds.match(/fantasy-chip--champion/g).length, 1);

  const iHold = renderFantasyMatchupPanel(matchup, { previousWinnerUserId: 1 });
  assert.equal(iHold.match(/fantasy-chip--champion/g).length, 1);

  assert.doesNotMatch(renderFantasyMatchupPanel(matchup, {}), /fantasy-chip--champion/);
});

test("the lobby marks the champion's seat", () => {
  const html = renderFantasyLobby(lobbyLeague(), CHAMPION_MEMBERS, { filter: { position: "All", search: "" } });
  const roryRow = html.match(/<div class="fantasy-member-row">[\s\S]*?Rory[\s\S]*?<\/div>/)[0];
  assert.match(roryRow, /fantasy-chip--champion/);
  const aliceRow = html.match(/<div class="fantasy-member-row">[\s\S]*?Alice[\s\S]*?<\/div>/)[0];
  assert.doesNotMatch(aliceRow, /fantasy-chip--champion/);
});

test("the champion picker never offers a bot manager", () => {
  const html = renderChampionCard({ isCommissioner: true, previousWinnerUserId: 2 }, CHAMPION_MEMBERS);
  assert.match(html, /data-fantasy-champion-select/);
  assert.match(html, /<option value="2" selected>Rory<\/option>/);
  assert.match(html, /<option value="1">Alice<\/option>/);
  assert.doesNotMatch(html, /Bot Alfie/);
  // Clearing has to be reachable from the same control that sets it.
  assert.match(html, /value=""/);
});

test("a non-commissioner reads the champion as a fact, and sees nothing when there is none", () => {
  const html = renderChampionCard({ isCommissioner: false, previousWinnerUserId: 2 }, CHAMPION_MEMBERS);
  assert.match(html, /Rory/);
  assert.doesNotMatch(html, /data-fantasy-champion-select/);
  assert.doesNotMatch(html, /data-fantasy-champion-save/);

  // An empty card explaining a control they do not have is worse than no card.
  assert.equal(renderChampionCard({ isCommissioner: false, previousWinnerUserId: null }, CHAMPION_MEMBERS), "");
});

test("a champion who has left the league is not named by the card", () => {
  const gone = renderChampionCard({ isCommissioner: false, previousWinnerUserId: 99 }, CHAMPION_MEMBERS);
  assert.equal(gone, "");
  const commissioner = renderChampionCard({ isCommissioner: true, previousWinnerUserId: 99 }, CHAMPION_MEMBERS);
  assert.doesNotMatch(commissioner, /is the defending champion/);
});

test("the champion card escapes team names and its own error message", () => {
  const html = renderChampionCard(
    { isCommissioner: true, previousWinnerUserId: 2 },
    [{ userId: 2, name: `<script>alert(1)</script>` }],
    { championError: `bad <choice>` },
  );
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /bad &lt;choice&gt;/);
});

// -- Commissioner settings tab -----------------------------------------------

test("the Settings tab is offered to every member; the body scopes what each can do", () => {
  const members = [{ userId: 1, name: "Me" }];
  const asCommish = renderFantasyLeagueHeader({ name: "L", draftStatus: "complete", isCommissioner: true }, members, "feed");
  const asManager = renderFantasyLeagueHeader({ name: "L", draftStatus: "complete", isCommissioner: false }, members, "feed");
  // Settings holds each member's OWN team name, so it cannot be a
  // commissioner-only tab; the league-level levers scope themselves inside.
  assert.match(asCommish, /data-fantasy-subtab="settings"/);
  assert.match(asManager, /data-fantasy-subtab="settings"/);
});

test("a non-commissioner's settings hold their team name and none of the league levers", () => {
  const html = renderFantasySettingsPanel({ name: "L", draftStatus: "complete", isCommissioner: false }, [], {
    teamName: "The Goon Squad",
    teamNameFallback: "Ada",
  });
  assert.match(html, /Your team/);
  assert.match(html, /The Goon Squad/);
  assert.match(html, /data-fantasy-teamname-edit/, "the rename form's home is Settings");
  assert.doesNotMatch(html, /data-fantasy-add-bots/);
  assert.doesNotMatch(html, /data-fantasy-settings-mode/);
});

test("the commissioner's settings lead with their own team card before the league levers", () => {
  const html = renderFantasySettingsPanel(
    { name: "L", draftStatus: "complete", isCommissioner: true },
    [{ userId: 1, name: "Me" }],
    {
      seats: { total: 10, humans: 1, bots: 0, open: 9 },
      schedule: null,
      waivers: { mode: "faab", faabBudget: 100, myClaims: [] },
      teamName: null,
      teamNameFallback: "Me",
    },
  );
  assert.match(html, /Your team/);
  assert.match(html, /data-fantasy-teamname-edit/);
  assert.match(html, /data-fantasy-settings-mode/, "league levers still there for the commissioner");
  assert.ok(html.indexOf("Your team") < html.indexOf("Waivers"), "own settings first, league levers after");
});

test("the My team pitch shows the team name with a pencil that jumps to Settings, not a second form", () => {
  const html = renderTeamNameRow({ teamName: "The Goon Squad", fallbackName: "Ada", editable: false });
  assert.match(html, /The Goon Squad/);
  assert.match(html, /data-fantasy-subtab="settings"/);
  assert.doesNotMatch(html, /data-fantasy-teamname-edit/, "one form, one home");
  assert.doesNotMatch(html, /data-fantasy-teamname-input/);
});

test("a pending league's settings offer the draft and bot controls, and explain why waivers are not there yet", () => {
  const html = renderFantasySettingsPanel(
    { name: "L", draftStatus: "pending", isCommissioner: true },
    [{ userId: 1, name: "Me" }],
    { seats: { total: 10, humans: 1, bots: 0, open: 9 }, schedule: null },
  );
  assert.match(html, /data-fantasy-add-bots/, "bots are settable before the draft");
  assert.match(html, /Free agency starts after the draft/);
  assert.doesNotMatch(html, /data-fantasy-settings-mode/, "waiver mode is not settable yet");
});

test("a drafted league's settings drop the bot and schedule controls but keep waiver mode", () => {
  const html = renderFantasySettingsPanel(
    { name: "L", draftStatus: "complete", isCommissioner: true },
    [{ userId: 1, name: "Me" }],
    {
      seats: { total: 10, humans: 1, bots: 0, open: 9 },
      schedule: null,
      waivers: { mode: "faab", faabBudget: 100, myClaims: [] },
    },
  );
  assert.doesNotMatch(html, /data-fantasy-add-bots/, "seats are fixed once the draft starts");
  assert.match(html, /Seats are fixed once the draft starts/);
  assert.match(html, /data-fantasy-settings-mode/, "waiver mode is settable now");
  assert.match(html, /card__title">Waivers</, "titled for its home, not 'Commissioner settings'");
});

// -- Gameweek tracker --------------------------------------------------------

test("the tracker names your players in each fixture and leads with the live one", () => {
  const tracker = {
    counts: { total: 2, done: 0, inPlay: 1, toCome: 1, blank: 0 },
    fixtures: [
      {
        match: { id: 1, homeTeam: "Arsenal", awayTeam: "Everton", status: "IN_PLAY", minute: 63, score: { home: 2, away: 1 }, utcDate: "2026-08-21T14:00:00Z" },
        yours: [{ id: 10, name: "Saka" }],
      },
      {
        match: { id: 2, homeTeam: "Chelsea", awayTeam: "Fulham", status: "TIMED", score: {}, utcDate: "2026-08-21T16:30:00Z" },
        yours: [{ id: 11, name: "Palmer" }],
      },
    ],
  };
  const html = renderGameweekTracker(tracker, { gameweek: 6 });
  assert.match(html, /Gameweek 6/);
  assert.match(html, /1 in play · 1 to come/);
  assert.match(html, /Saka/);
  assert.match(html, /2 – 1/);
  assert.ok(html.indexOf("Saka") < html.indexOf("Palmer"), "the live fixture leads");
  assert.match(html, /fantasy-gwtrack-row is-live/);
});

// Without a feed every starter would look like a blank gameweek, which is a
// lie rather than a gap.
test("no live feed says so rather than reporting everyone blank", () => {
  const html = renderGameweekTracker(null, { gameweek: 6, hasLiveFeed: false });
  assert.match(html, /Live scores are unavailable/);
  assert.doesNotMatch(html, /blank/);
});

test("an unset lineup asks for one instead of rendering an empty bar", () => {
  const html = renderGameweekTracker({ counts: { total: 0 }, fixtures: [] }, { gameweek: 6 });
  assert.match(html, /No starting eleven set/);
});

test("the pitch names who each player is up against, home or away", () => {
  const roster = [
    { id: 1, name: "Keeper", team: "Arsenal", position: "GK" },
    { id: 2, name: "Backline", team: "Everton", position: "DEF" },
  ];
  const matches = [
    { id: 90, utcDate: "2026-08-21T19:00:00Z", status: "TIMED", matchday: 1, homeTeam: "Arsenal", awayTeam: "Coventry City", score: {} },
    { id: 91, utcDate: "2026-08-22T14:00:00Z", status: "TIMED", matchday: 1, homeTeam: "Chelsea", awayTeam: "Everton", score: {} },
  ];
  const html = renderFantasyRosterPanel({
    currentGameweek: 1,
    roster,
    lineup: { gameweek: 1, starters: [{ playerId: 1 }, { playerId: 2 }], bench: [] },
    playerPool: [],
    picks: [],
    editState: null,
    drawerPlayerId: null,
    lineupError: "",
    matches,
  });
  // abbrFor derives its own short form (the feed's TLA in production, initials
  // as a fallback), so the expectation is built from it rather than hardcoded.
  assert.match(html, new RegExp(`${abbrFor("Coventry City")} \\(H\\)`), "a home fixture names the opponent and (H)");
  assert.match(html, new RegExp(`${abbrFor("Chelsea")} \\(A\\)`), "an away fixture names the opponent and (A)");
});

// A missing line reads as a rendering gap; "No fixture" is a fact a manager
// needs before the deadline, not after.
test("a club with no fixture this gameweek says so on the pitch", () => {
  const html = renderFantasyRosterPanel({
    currentGameweek: 1,
    roster: [{ id: 1, name: "Idle", team: "Arsenal", position: "GK" }],
    lineup: { gameweek: 1, starters: [{ playerId: 1 }], bench: [] },
    playerPool: [],
    picks: [],
    editState: null,
    drawerPlayerId: null,
    lineupError: "",
    matches: [
      { id: 90, utcDate: "2026-08-21T19:00:00Z", status: "TIMED", matchday: 1, homeTeam: "Chelsea", awayTeam: "Everton", score: {} },
    ],
  });
  assert.match(html, /No fixture/);
});

// Without a feed, saying "No fixture" for everyone would be a lie rather than
// a gap, so the line is omitted entirely.
test("with no feed the pitch omits the fixture line rather than claiming none", () => {
  const html = renderFantasyRosterPanel({
    currentGameweek: 1,
    roster: [{ id: 1, name: "Keeper", team: "Arsenal", position: "GK" }],
    lineup: { gameweek: 1, starters: [{ playerId: 1 }], bench: [] },
    playerPool: [],
    picks: [],
    editState: null,
    drawerPlayerId: null,
    lineupError: "",
    matches: null,
  });
  assert.doesNotMatch(html, /No fixture/);
  assert.doesNotMatch(html, /fantasy-pitch__opp/);
});

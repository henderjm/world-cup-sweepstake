import assert from "node:assert/strict";
import test from "node:test";

import {
  renderFantasyClaimFlow,
  renderFantasyComplete,
  renderFantasyDraftRoom,
  renderFantasyFreeAgentRows,
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
  renderFantasyWaiversPanel,
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
  assert.match(html, /data-fantasy-pool-sort="rank">Rank</);
  assert.match(html, /data-fantasy-pool-sort="xp">xP</);
  assert.match(html, /data-fantasy-pool-sort="name">Name</);
  assert.match(html, /seg is-active" type="button" data-fantasy-pool-sort="xp"/);
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
  // The Rank column (fantasyDraftRank.js) is unconditional, unlike Tier/Apps -
  // this fixture carries no xp, so it legitimately renders the same empty-
  // placeholder class once, for the rank cell only. Scoped to "exactly one,
  // and it's the rank cell's" rather than "absent anywhere in the row".
  const emptyPlaceholders = html.match(/fantasy-stat--empty/g) ?? [];
  assert.equal(emptyPlaceholders.length, 1, "only the Rank cell should use fantasy-stat--empty here");
  assert.match(html, /fantasy-player-row__rank fantasy-stat fantasy-stat--empty/);
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

test("renderFantasyLobby offers a commissioner a schedule picker when nothing is scheduled yet", () => {
  const html = renderFantasyLobby(lobbyLeague({ isCommissioner: true }), lobbyMembers, {
    playerPool: null,
    filter: { position: "All", search: "" },
  });
  assert.match(html, /Schedule the draft/);
  assert.match(html, /data-fantasy-schedule-input/);
  assert.match(html, /data-fantasy-schedule-save/);
});

test("renderFantasyLobby tells a non-commissioner nothing is scheduled yet, with no picker", () => {
  const html = renderFantasyLobby(lobbyLeague({ isCommissioner: false }), lobbyMembers, {
    playerPool: null,
    filter: { position: "All", search: "" },
  });
  assert.match(html, /hasn't scheduled the draft yet/);
  assert.doesNotMatch(html, /data-fantasy-schedule-input/);
});

test("renderFantasyLobby shows the scheduled time, a countdown and reschedule/clear controls for the commissioner", () => {
  const scheduledAt = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
  const html = renderFantasyLobby(lobbyLeague({ isCommissioner: true }), lobbyMembers, {
    playerPool: null,
    filter: { position: "All", search: "" },
    schedule: { scheduledAt },
  });
  assert.match(html, /Draft scheduled/);
  assert.match(html, new RegExp(`data-scheduled-at="${scheduledAt}"`));
  assert.match(html, /data-fantasy-schedule-save/);
  assert.match(html, /Reschedule/);
  assert.match(html, /data-fantasy-schedule-clear/);
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

test("renderFantasyLobby surfaces a schedule error message, escaped", () => {
  const html = renderFantasyLobby(lobbyLeague({ isCommissioner: true }), lobbyMembers, {
    playerPool: null,
    filter: { position: "All", search: "" },
    scheduleError: `bad "date" <here>`,
  });
  assert.match(html, /bad &quot;date&quot; &lt;here&gt;/);
});

test("renderFantasyLobby disables schedule controls while a save/clear is in flight", () => {
  const scheduledAt = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
  const html = renderFantasyLobby(lobbyLeague({ isCommissioner: true }), lobbyMembers, {
    playerPool: null,
    filter: { position: "All", search: "" },
    schedule: { scheduledAt },
    scheduleBusy: true,
  });
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

test("renderFantasyLeagueHeader marks the active sub-tab and leaves the other three live", () => {
  const html = renderFantasyLeagueHeader({ name: "Test League" }, members, "myteam");
  const myTeamButton = html.match(/<button class="fantasy-subtab[^"]*" type="button" data-fantasy-subtab="myteam">/)[0];
  assert.match(myTeamButton, /is-active/);
  const matchupButton = html.match(/<button class="fantasy-subtab[^"]*" type="button" data-fantasy-subtab="matchup">/)[0];
  assert.doesNotMatch(matchupButton, /disabled/);
  const standingsButton = html.match(/<button class="fantasy-subtab[^"]*" type="button" data-fantasy-subtab="standings">/)[0];
  assert.doesNotMatch(standingsButton, /disabled/);
  assert.doesNotMatch(html, /Soon/);
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

test("renderFantasyMatchupPanel explains a bye week plainly when opponent is null", () => {
  const html = renderFantasyMatchupPanel({ gameweek: 7, status: "scheduled", me: { userId: 1, name: "Alex", score: 0 }, opponent: null });
  assert.match(html, /Bye week/);
  assert.match(html, /No fixture for you this gameweek/);
  assert.doesNotMatch(html, /vs/);
});

test("renderFantasyMatchupPanel shows a pending score (not a bare 0-0) while the matchup is scheduled", () => {
  const html = renderFantasyMatchupPanel({
    gameweek: 7,
    status: "scheduled",
    me: { userId: 1, name: "Alex", score: 0 },
    opponent: { userId: 2, name: "Sam", score: 0 },
  });
  assert.match(html, /Not started yet/);
  assert.doesNotMatch(html, /fantasy-matchup__bar-me/);
  assert.match(html, /fantasy-stat--empty/);
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
  assert.match(html, /Blind bidding \(FAAB\)/);
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

test("renderFantasyWaiversPanel shows commissioner settings only for the commissioner", () => {
  const commissionerView = renderFantasyWaiversPanel(waiversFixture(), { myUserId: 3, roster: [], isCommissioner: true });
  assert.match(commissionerView, /Commissioner settings/);
  assert.match(commissionerView, /data-fantasy-settings-save/);

  const memberView = renderFantasyWaiversPanel(waiversFixture(), { myUserId: 3, roster: [], isCommissioner: false });
  assert.doesNotMatch(memberView, /Commissioner settings/);
  assert.doesNotMatch(memberView, /data-fantasy-settings-save/);
});

test("renderFantasyWaiversPanel disables commissioner settings and explains why when the caller has a pending claim", () => {
  const withPending = waiversFixture({ myClaims: [{ claimId: 1, addPlayerId: 11, dropPlayerId: 20, bid: 10, priority: 1, status: "pending", reason: null, gameweek: 7 }] });
  const html = renderFantasyWaiversPanel(withPending, { myUserId: 3, roster: [], isCommissioner: true });
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
  assert.match(html, /dropping one of your own DEF/);
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
  assert.match(html, /list is shorter than usual/);
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

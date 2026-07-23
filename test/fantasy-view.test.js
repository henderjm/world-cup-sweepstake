import assert from "node:assert/strict";
import test from "node:test";

import { renderFantasyDraftRoom, renderFantasyLeagueList, renderFantasyPlayerRows, renderFantasySessionExpired } from "../src/fantasyView.js";

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

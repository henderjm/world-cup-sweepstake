import assert from "node:assert/strict";
import test from "node:test";

import { BOT_WAIVER_MARGIN, chooseBotWaiverClaim } from "../src/fantasyDemoWaiverBots.js";

function player(id, position, points) {
  return { id, position };
}

test("chooseBotWaiverClaim claims the biggest clear upgrade across every position bucket", () => {
  const roster = [player(1, "GK"), player(2, "DEF"), player(3, "MID"), player(4, "FWD")];
  const available = [player(10, "DEF"), player(11, "MID")];
  const pointsByPlayer = new Map([
    [1, 20],
    [2, 5], // weak DEF
    [3, 30],
    [4, 40],
    [10, 12], // DEF upgrade: +7, under the default margin of 6? no, 7 > 6
    [11, 60], // MID upgrade: +30, the clear winner
  ]);
  const claim = chooseBotWaiverClaim({ roster, available, pointsByPlayer });
  assert.deepEqual(claim, { addPlayerId: 11, dropPlayerId: 3 });
});

test("chooseBotWaiverClaim returns null when nothing clears the margin", () => {
  const roster = [player(1, "GK"), player(2, "DEF")];
  const available = [player(10, "DEF")];
  const pointsByPlayer = new Map([
    [1, 10],
    [2, 10],
    [10, 12], // only +2, below BOT_WAIVER_MARGIN
  ]);
  assert.equal(chooseBotWaiverClaim({ roster, available, pointsByPlayer }), null);
});

test("chooseBotWaiverClaim respects a custom margin", () => {
  const roster = [player(1, "DEF")];
  const available = [player(10, "DEF")];
  const pointsByPlayer = new Map([
    [1, 0],
    [10, 5],
  ]);
  assert.equal(chooseBotWaiverClaim({ roster, available, pointsByPlayer, margin: 10 }), null);
  assert.deepEqual(chooseBotWaiverClaim({ roster, available, pointsByPlayer, margin: 1 }), {
    addPlayerId: 10,
    dropPlayerId: 1,
  });
});

test("chooseBotWaiverClaim never proposes an add/drop across different positions", () => {
  const roster = [player(1, "GK")];
  const available = [player(10, "FWD")]; // huge upgrade in points, but no FWD to drop for
  const pointsByPlayer = new Map([
    [1, 0],
    [10, 100],
  ]);
  assert.equal(chooseBotWaiverClaim({ roster, available, pointsByPlayer }), null);
});

test("chooseBotWaiverClaim is deterministic: ties break by ascending player id on both sides", () => {
  const roster = [player(2, "DEF"), player(1, "DEF")]; // both score 0, id 1 should be picked as weakest
  const available = [player(20, "DEF"), player(10, "DEF")]; // both score 100, id 10 should be picked as best
  const pointsByPlayer = new Map([
    [1, 0],
    [2, 0],
    [10, 100],
    [20, 100],
  ]);
  assert.deepEqual(chooseBotWaiverClaim({ roster, available, pointsByPlayer }), { addPlayerId: 10, dropPlayerId: 1 });
});

test("chooseBotWaiverClaim tolerates an empty available pool or roster without crashing", () => {
  assert.equal(chooseBotWaiverClaim({ roster: [], available: [], pointsByPlayer: new Map() }), null);
  assert.equal(chooseBotWaiverClaim({ roster: [player(1, "GK")], available: [], pointsByPlayer: new Map() }), null);
});

test("BOT_WAIVER_MARGIN is a positive number (a real threshold, not accidentally disabled)", () => {
  assert.ok(BOT_WAIVER_MARGIN > 0);
});

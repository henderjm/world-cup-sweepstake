import assert from "node:assert/strict";
import test from "node:test";

import { diffMatchEvents } from "../src/matchPushEvents.js";

const match = { homeTeam: "Chelsea", awayTeam: "Man United", minute: 34 };
const live = (home, away) => ({ status: "IN_PLAY", home, away, reds: 0 });

test("a goal VAR takes back sends a ruled-out push on the goal alert's tag", () => {
  const events = diffMatchEvents(live(0, 1), live(0, 0), match, null, 36);
  assert.deepEqual(events, [{ pref: "goals", title: "Goal ruled out: Chelsea 0-0 Man United", body: "36'" }]);
});

test("a stale feed reading lower is not announced as a ruled-out goal", () => {
  assert.deepEqual(diffMatchEvents(live(0, 1), live(0, 0), match, null, 36, { stale: true }), []);
});

test("a missing score is not a ruled-out goal", () => {
  assert.deepEqual(diffMatchEvents(live(1, 0), live(null, null), match, null, null), []);
});

test("one goal ruled out and another given on the same tick sends both, the goal last", () => {
  const events = diffMatchEvents(live(1, 0), live(0, 1), match, null, 40);
  assert.deepEqual(events.map((e) => e.title), ["Goal ruled out: Chelsea 0-1 Man United", "⚽ Chelsea 0-1 Man United"]);
});

test("an ordinary goal still sends only the goal push", () => {
  assert.deepEqual(diffMatchEvents(live(0, 0), live(1, 0), match, null, 14), [
    { pref: "goals", title: "⚽ Chelsea 1-0 Man United", body: "14'" },
  ]);
});

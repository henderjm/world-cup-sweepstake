import assert from "node:assert/strict";
import test from "node:test";

import {
  buildWaiverPlayerLookup,
  claimStatusLabel,
  dropCandidates,
  isLegalDropCandidate,
  partitionWaiverClaims,
  priorityOrdinalLabel,
  waiverModeExplanation,
  waiverModeLabel,
} from "../src/fantasyWaiversView.js";

// -- waiverModeLabel / waiverModeExplanation --------------------------------

test("waiverModeLabel names all three modes", () => {
  assert.equal(waiverModeLabel("faab"), "Blind bidding (FAAB)");
  assert.equal(waiverModeLabel("rolling"), "Rolling list");
  assert.equal(waiverModeLabel("reverse_standings"), "Reverse standings");
});

test("waiverModeLabel falls back to the raw value for an unknown mode", () => {
  assert.equal(waiverModeLabel("mystery"), "mystery");
});

test("waiverModeExplanation gives a distinct, honest sentence for each mode", () => {
  const faab = waiverModeExplanation("faab");
  const rolling = waiverModeExplanation("rolling");
  const reverse = waiverModeExplanation("reverse_standings");
  assert.match(faab, /highest bid wins/i);
  assert.match(rolling, /back of the queue/i);
  assert.match(reverse, /worst-placed manager/i);
  // All three are distinct sentences, not copy-pasted with a word swapped.
  assert.notEqual(faab, rolling);
  assert.notEqual(rolling, reverse);
  assert.notEqual(faab, reverse);
});

test("waiverModeExplanation returns an empty string for an unknown mode rather than fabricating one", () => {
  assert.equal(waiverModeExplanation("mystery"), "");
});

// -- priorityOrdinalLabel ----------------------------------------------------

test("priorityOrdinalLabel renders 'Nth of M'", () => {
  assert.equal(priorityOrdinalLabel(3, 4), "3rd of 4");
  assert.equal(priorityOrdinalLabel(1, 1), "1st of 1");
  assert.equal(priorityOrdinalLabel(11, 12), "11th of 12");
});

test("priorityOrdinalLabel renders nothing for a null priority or a non-positive total", () => {
  assert.equal(priorityOrdinalLabel(null, 4), "");
  assert.equal(priorityOrdinalLabel(undefined, 4), "");
  assert.equal(priorityOrdinalLabel(1, 0), "");
  assert.equal(priorityOrdinalLabel(1, -1), "");
});

// -- dropCandidates / isLegalDropCandidate -----------------------------------

const roster = [
  { id: 1, position: "GK" },
  { id: 2, position: "DEF" },
  { id: 3, position: "DEF" },
  { id: 4, position: "MID" },
];

test("dropCandidates filters the roster to just the matching position", () => {
  assert.deepEqual(
    dropCandidates(roster, "DEF").map((p) => p.id),
    [2, 3],
  );
  assert.deepEqual(
    dropCandidates(roster, "FWD").map((p) => p.id),
    [],
  );
});

test("dropCandidates returns an empty array for a missing position rather than the whole roster", () => {
  assert.deepEqual(dropCandidates(roster, null), []);
  assert.deepEqual(dropCandidates(roster, undefined), []);
});

test("isLegalDropCandidate is true only when both players share a position", () => {
  assert.equal(isLegalDropCandidate({ position: "DEF" }, { position: "DEF" }), true);
  assert.equal(isLegalDropCandidate({ position: "DEF" }, { position: "MID" }), false);
  assert.equal(isLegalDropCandidate({ position: "DEF" }, null), false);
  assert.equal(isLegalDropCandidate(null, { position: "DEF" }), false);
});

// -- partitionWaiverClaims ----------------------------------------------------

test("partitionWaiverClaims splits pending from resolved, preserving order within each group", () => {
  const claims = [
    { claimId: 1, status: "pending" },
    { claimId: 2, status: "rejected", reason: "Outbid" },
    { claimId: 3, status: "pending" },
    { claimId: 4, status: "processed" },
  ];
  const { pending, resolved } = partitionWaiverClaims(claims);
  assert.deepEqual(pending.map((c) => c.claimId), [1, 3]);
  assert.deepEqual(resolved.map((c) => c.claimId), [2, 4]);
});

test("partitionWaiverClaims handles an empty or missing list", () => {
  assert.deepEqual(partitionWaiverClaims([]), { pending: [], resolved: [] });
  assert.deepEqual(partitionWaiverClaims(undefined), { pending: [], resolved: [] });
});

// -- buildWaiverPlayerLookup --------------------------------------------------

test("buildWaiverPlayerLookup merges free agents, the wire and the roster into one id lookup", () => {
  const lookup = buildWaiverPlayerLookup({
    freeAgents: [{ id: 1, name: "Free Agent", team: "Test FC", position: "MID" }],
    wire: [{ player: { id: 2, name: "Wire Player", team: "Test FC", position: "DEF" }, clearsAfterGameweek: 5 }],
    roster: [{ id: 3, name: "My Player", team: "Test FC", position: "GK" }],
  });
  assert.equal(lookup.get(1).name, "Free Agent");
  assert.equal(lookup.get(2).name, "Wire Player");
  assert.equal(lookup.get(3).name, "My Player");
  assert.equal(lookup.size, 3);
});

test("buildWaiverPlayerLookup tolerates missing lists", () => {
  const lookup = buildWaiverPlayerLookup({});
  assert.equal(lookup.size, 0);
});

// -- claimStatusLabel ----------------------------------------------------------

test("claimStatusLabel names processed/rejected/pending in plain English", () => {
  assert.equal(claimStatusLabel("processed"), "Won");
  assert.equal(claimStatusLabel("rejected"), "Rejected");
  assert.equal(claimStatusLabel("pending"), "Pending");
});

test("claimStatusLabel falls back to the raw status for anything unexpected", () => {
  assert.equal(claimStatusLabel("mystery"), "mystery");
});

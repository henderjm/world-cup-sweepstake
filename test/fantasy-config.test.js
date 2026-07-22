import assert from "node:assert/strict";
import test from "node:test";

import { bucketPosition, validateFormation, STARTING_SIZE } from "../src/fantasy.js";

test("bucketPosition maps the coarse squad-endpoint values directly", () => {
  assert.equal(bucketPosition("Goalkeeper"), "GK");
  assert.equal(bucketPosition("Defence"), "DEF");
  assert.equal(bucketPosition("Midfield"), "MID");
  assert.equal(bucketPosition("Offence"), "FWD");
});

test("bucketPosition falls back to keyword matching for granular lineup positions", () => {
  assert.equal(bucketPosition("Right-Back"), "DEF");
  assert.equal(bucketPosition("Attacking Midfield"), "MID");
  assert.equal(bucketPosition("Centre-Forward"), "FWD");
  assert.equal(bucketPosition("Goalkeeper (sub)"), "GK");
});

test("bucketPosition returns null for missing input", () => {
  assert.equal(bucketPosition(null), null);
  assert.equal(bucketPosition(""), null);
});

test("validateFormation accepts a standard 4-4-2 with a GK", () => {
  const xi = [
    "GK",
    "DEF", "DEF", "DEF", "DEF",
    "MID", "MID", "MID", "MID",
    "FWD", "FWD",
  ];
  assert.equal(xi.length, STARTING_SIZE);
  const result = validateFormation(xi);
  assert.equal(result.valid, true);
});

test("validateFormation rejects two goalkeepers", () => {
  const xi = ["GK", "GK", "DEF", "DEF", "DEF", "DEF", "MID", "MID", "MID", "FWD", "FWD"];
  const result = validateFormation(xi);
  assert.equal(result.valid, false);
});

test("validateFormation rejects a squad short of eleven", () => {
  const result = validateFormation(["GK", "DEF", "DEF", "DEF", "MID", "MID", "MID", "FWD"]);
  assert.equal(result.valid, false);
});

test("validateFormation rejects too many defenders", () => {
  const xi = ["GK", "DEF", "DEF", "DEF", "DEF", "DEF", "DEF", "MID", "MID", "FWD", "FWD"];
  const result = validateFormation(xi);
  assert.equal(result.valid, false);
});

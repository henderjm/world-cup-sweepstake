import assert from "node:assert/strict";
import test from "node:test";

import { isFantasyNotDeployed } from "../src/fantasyApi.js";

function errorWithStatus(status) {
  const error = new Error(`fantasy api ${status}`);
  error.status = status;
  return error;
}

test("isFantasyNotDeployed is true for a 404 (routes not deployed yet)", () => {
  assert.equal(isFantasyNotDeployed(errorWithStatus(404)), true);
});

test("isFantasyNotDeployed is true for a 501 (routes deployed but not configured)", () => {
  assert.equal(isFantasyNotDeployed(errorWithStatus(501)), true);
});

test("isFantasyNotDeployed is false for genuine errors that should keep the retry path", () => {
  assert.equal(isFantasyNotDeployed(errorWithStatus(500)), false);
  assert.equal(isFantasyNotDeployed(errorWithStatus(502)), false);
  assert.equal(isFantasyNotDeployed(errorWithStatus(401)), false);
  assert.equal(isFantasyNotDeployed(errorWithStatus(403)), false);
});

test("isFantasyNotDeployed is false for a network failure with no status", () => {
  assert.equal(isFantasyNotDeployed(new TypeError("Failed to fetch")), false);
  assert.equal(isFantasyNotDeployed(null), false);
  assert.equal(isFantasyNotDeployed(undefined), false);
});

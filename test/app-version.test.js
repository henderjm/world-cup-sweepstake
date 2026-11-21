import { test } from "node:test";
import assert from "node:assert/strict";
import { chosenVersion } from "../src/appVersion.js";

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), data };
}

test("V2 is the default, and a remembered V1 choice is kept", () => {
  assert.equal(chosenVersion("", memoryStorage()), "2");
  assert.equal(chosenVersion("", memoryStorage({ "kd-app-version": "1" })), "1");
});

test("an embedded load is always V1", () => {
  assert.equal(chosenVersion("?embed=1", memoryStorage({ "kd-app-version": "2" })), "1");
});

test("the URL choice wins and is remembered", () => {
  const storage = memoryStorage({ "kd-app-version": "1" });
  assert.equal(chosenVersion("?v=2", storage), "2");
  assert.equal(chosenVersion("", storage), "2");
  assert.equal(chosenVersion("?v=1", storage), "1");
});

test("unknown versions and broken storage fall back to the default", () => {
  assert.equal(chosenVersion("?v=9", memoryStorage()), "2");
  const throwing = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  assert.equal(chosenVersion("", throwing), "2");
  assert.equal(chosenVersion("?v=2", throwing), "2");
});

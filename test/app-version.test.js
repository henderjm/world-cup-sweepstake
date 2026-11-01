import { test } from "node:test";
import assert from "node:assert/strict";
import { chosenVersion } from "../src/appVersion.js";

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), data };
}

test("V1 is the default", () => {
  assert.equal(chosenVersion("", memoryStorage()), "1");
});

test("the URL choice wins and is remembered", () => {
  const storage = memoryStorage({ "kd-app-version": "1" });
  assert.equal(chosenVersion("?v=2", storage), "2");
  assert.equal(chosenVersion("", storage), "2");
  assert.equal(chosenVersion("?v=1", storage), "1");
});

test("unknown versions and broken storage fall back to V1", () => {
  assert.equal(chosenVersion("?v=9", memoryStorage()), "1");
  const throwing = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  assert.equal(chosenVersion("", throwing), "1");
  assert.equal(chosenVersion("?v=2", throwing), "2");
});

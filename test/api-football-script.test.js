import assert from "node:assert/strict";
import test from "node:test";

import { assertApiFootballPayload } from "../src/apiFootballPayload.js";

test("accepts a successful API-Football payload", () => {
  assert.doesNotThrow(() => assertApiFootballPayload({ errors: [], response: [] }));
  assert.doesNotThrow(() => assertApiFootballPayload({ errors: {}, response: [{ fixture: { id: 1 } }] }));
});

test("rejects API-Football errors returned with HTTP 200", () => {
  assert.throws(
    () => assertApiFootballPayload({ errors: { season: "Free plans do not have access" }, response: [] }),
    /Free plans do not have access/,
  );
});

test("rejects malformed API-Football payloads before overwriting baked data", () => {
  assert.throws(() => assertApiFootballPayload({ errors: [] }), /malformed response/);
});

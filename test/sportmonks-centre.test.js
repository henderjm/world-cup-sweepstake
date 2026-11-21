import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { matchCentre, resetSportmonksMemo } from "../worker/sportmonksCentre.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/sportmonks-fixture-ft.json", import.meta.url)));
const env = { SPORTMONKS_API_KEY: "test-key" };
const match = { competition: "PL", status: "FINISHED", utcDate: "2026-10-31T12:30:00Z", homeTeam: "Chelsea", awayTeam: "Man United" };

let calls;
function stub(remaining = 2400) {
  calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), auth: init?.headers?.Authorization });
    const data = String(url).includes("/fixtures/date/") ? [fixture] : fixture;
    return new Response(JSON.stringify({ data, rate_limit: { remaining, resets_in_seconds: 1200, requested_entity: "Fixture" } }));
  };
}

beforeEach(() => resetSportmonksMemo());

test("a finished match joins by date and clubs, then reads its centre", async () => {
  stub();
  const centre = await matchCentre(env, match, 0);
  assert.equal(centre.available, true);
  assert.equal(centre.teamStats.home.shots, 18);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.auth === "test-key" && !call.url.includes("test-key")), "key only ever in the header");
});

test("repeat reads inside the window are served from the memo", async () => {
  stub();
  await matchCentre(env, match, 0);
  await matchCentre(env, match, 60_000);
  assert.equal(calls.length, 2);
});

test("an upcoming match is read for who is out, a postponed one spends nothing", async () => {
  stub();
  assert.equal((await matchCentre(env, { ...match, status: "TIMED" }, 0)).available, true);
  const spent = calls.length;
  assert.deepEqual(await matchCentre(env, { ...match, status: "POSTPONED" }, 0), { available: false });
  assert.equal(calls.length, spent);
});

test("below the allowance floor it stops calling until the hour resets", async () => {
  stub(150);
  await assert.rejects(matchCentre(env, match, 0));
  await assert.rejects(matchCentre(env, { ...match, utcDate: "2026-11-01T15:00:00Z" }, 1000));
  assert.equal(calls.length, 1, "only the call that reported the floor was made");
});

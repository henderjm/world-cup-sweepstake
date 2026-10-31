import { test } from "node:test";
import assert from "node:assert/strict";
import { d1Instant, postDecision, viewOfMessage } from "../src/talkModeration.js";

const message = (extra = {}) => ({ userId: 7, reports: 0, moderatorReported: false, hiddenAt: null, authorMuted: false, ...extra });

test("an ordinary comment is visible to everyone", () => {
  assert.deepEqual(viewOfMessage(message(), { viewerId: 1 }), { state: "visible" });
  assert.deepEqual(viewOfMessage(message()), { state: "visible" });
});

test("one report leaves it up, two hide it pending review", () => {
  assert.deepEqual(viewOfMessage(message({ reports: 1 }), { viewerId: 1 }), { state: "visible" });
  assert.equal(viewOfMessage(message({ reports: 2 }), { viewerId: 1 }), null);
  assert.deepEqual(viewOfMessage(message({ reports: 2 }), { viewerId: 7 }), { state: "pending" });
});

test("one report from a moderator is enough", () => {
  assert.equal(viewOfMessage(message({ reports: 1, moderatorReported: true })), null);
});

test("a hidden comment is gone for everyone but its author", () => {
  assert.equal(viewOfMessage(message({ hiddenAt: "2026-10-31 15:00:00" }), { viewerId: 1 }), null);
  assert.deepEqual(viewOfMessage(message({ hiddenAt: "2026-10-31 15:00:00" }), { viewerId: 7 }), { state: "removed" });
});

test("a muted author sees their own posts as normal and nobody else sees them", () => {
  assert.deepEqual(viewOfMessage(message({ authorMuted: true }), { viewerId: 7 }), { state: "visible" });
  assert.equal(viewOfMessage(message({ authorMuted: true }), { viewerId: 1 }), null);
  assert.equal(viewOfMessage(message({ authorMuted: true })), null, "signed out readers too");
});

test("a moderator sees everything, labelled", () => {
  assert.deepEqual(viewOfMessage(message({ reports: 2 }), { viewerId: 1, moderator: true }), { state: "pending" });
  assert.deepEqual(viewOfMessage(message({ authorMuted: true }), { moderator: true }), { state: "muted" });
});

test("posting is limited to one every 10 seconds and 60 per match", () => {
  const now = Date.parse("2026-10-31T15:00:10Z");
  assert.equal(postDecision({ lastPostAt: "2026-10-31T15:00:05Z" }, now), "too-fast");
  assert.equal(postDecision({ lastPostAt: "2026-10-31T14:59:59Z" }, now), "ok");
  assert.equal(postDecision({ postsInMatch: 60 }, now), "match-cap");
  assert.equal(postDecision({ muted: true }, now), "ok-muted");
});

test("D1 timestamps read as UTC", () => {
  assert.equal(d1Instant("2026-10-31 15:00:05"), "2026-10-31T15:00:05Z");
  assert.equal(d1Instant(null), null);
});

test("Talk shows a report link on others' comments, nothing on your own, tools for a moderator", async () => {
  const { renderMessage } = await import("../src/banter.js");
  const other = { id: 5, name: "sara", text: "hi", state: "visible" };
  assert.match(renderMessage(other, { signedIn: true, moderation: true }), /data-talk-action="report"/);
  assert.match(renderMessage({ ...other, reported: true }, { signedIn: true, moderation: true }), /Reported/);
  assert.doesNotMatch(renderMessage({ ...other, mine: true }, { signedIn: true, moderation: true }), /data-talk-action/);
  assert.doesNotMatch(renderMessage(other, { signedIn: false, moderation: true }), /data-talk-action/);
  assert.doesNotMatch(renderMessage(other, { signedIn: true, moderation: false }), /data-talk-action/, "no report link before the migration");
  const mod = renderMessage({ ...other, state: "muted", reports: 2 }, { signedIn: true, moderator: true, moderation: true });
  assert.match(mod, /2 reports/);
  assert.match(mod, /data-talk-action="hide"/);
  assert.match(mod, /data-talk-action="unmute"/);
  assert.match(renderMessage({ ...other, mine: true, state: "pending" }, { signedIn: true, moderation: true }), /Hidden pending review/);
});

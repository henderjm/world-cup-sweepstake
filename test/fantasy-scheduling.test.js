import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_SCHEDULE_DAYS,
  dueDraftReminder,
  formatLocalSchedule,
  formatScheduleCountdown,
  isDraftSoon,
  isoToLocalInputValue,
  localInputValueToUtcIso,
  validateDraftSchedule,
} from "../src/fantasyScheduling.js";

const NOW = new Date("2026-08-01T12:00:00Z").getTime();
const ONE_HOUR = 60 * 60 * 1000;
const ONE_DAY = 24 * ONE_HOUR;

// -- validateDraftSchedule ------------------------------------------------------

test("validateDraftSchedule accepts a well-formed future date", () => {
  const result = validateDraftSchedule(new Date(NOW + ONE_DAY).toISOString(), NOW);
  assert.equal(result.ok, true);
  assert.equal(result.scheduledAtIso, new Date(NOW + ONE_DAY).toISOString());
});

test("validateDraftSchedule rejects an unparseable date", () => {
  const result = validateDraftSchedule("not a date", NOW);
  assert.equal(result.ok, false);
  assert.match(result.error, /valid date/);
});

test("validateDraftSchedule rejects a date in the past", () => {
  const result = validateDraftSchedule(new Date(NOW - ONE_HOUR).toISOString(), NOW);
  assert.equal(result.ok, false);
  assert.match(result.error, /future/);
});

test("validateDraftSchedule rejects the current instant (not strictly future)", () => {
  const result = validateDraftSchedule(new Date(NOW).toISOString(), NOW);
  assert.equal(result.ok, false);
});

test("validateDraftSchedule rejects a date more than MAX_SCHEDULE_DAYS out", () => {
  const tooFar = NOW + (MAX_SCHEDULE_DAYS + 1) * ONE_DAY;
  const result = validateDraftSchedule(new Date(tooFar).toISOString(), NOW);
  assert.equal(result.ok, false);
  assert.match(result.error, /too far out/);
});

test("validateDraftSchedule accepts a date exactly at the MAX_SCHEDULE_DAYS boundary", () => {
  const atLimit = NOW + MAX_SCHEDULE_DAYS * ONE_DAY;
  const result = validateDraftSchedule(new Date(atLimit).toISOString(), NOW);
  assert.equal(result.ok, true);
});

// -- dueDraftReminder ------------------------------------------------------------

test("dueDraftReminder returns null well outside any window", () => {
  const scheduledAt = NOW + 10 * ONE_DAY;
  assert.equal(dueDraftReminder({ scheduledAt, now: NOW, sentKinds: [] }), null);
});

test("dueDraftReminder fires 24h once inside the 24h window", () => {
  const scheduledAt = NOW + 24 * ONE_HOUR;
  assert.equal(dueDraftReminder({ scheduledAt, now: NOW, sentKinds: [] }), "24h");
});

test("dueDraftReminder does not re-fire 24h once already sent", () => {
  const scheduledAt = NOW + 24 * ONE_HOUR;
  assert.equal(dueDraftReminder({ scheduledAt, now: NOW, sentKinds: ["24h"] }), null);
});

test("dueDraftReminder fires 1h once inside the 1h window", () => {
  const scheduledAt = NOW + ONE_HOUR;
  assert.equal(dueDraftReminder({ scheduledAt, now: NOW, sentKinds: ["24h"] }), "1h");
});

test("dueDraftReminder does not re-fire 1h once already sent", () => {
  const scheduledAt = NOW + ONE_HOUR;
  assert.equal(dueDraftReminder({ scheduledAt, now: NOW, sentKinds: ["24h", "1h"] }), null);
});

test("dueDraftReminder fires start exactly at the scheduled instant", () => {
  assert.equal(dueDraftReminder({ scheduledAt: NOW, now: NOW, sentKinds: ["24h", "1h"] }), "start");
});

test("dueDraftReminder fires start once the scheduled instant has passed", () => {
  const scheduledAt = NOW - 5 * 60 * 1000;
  assert.equal(dueDraftReminder({ scheduledAt, now: NOW, sentKinds: ["24h", "1h"] }), "start");
});

test("dueDraftReminder does not re-fire start once already sent", () => {
  const scheduledAt = NOW - ONE_HOUR;
  assert.equal(dueDraftReminder({ scheduledAt, now: NOW, sentKinds: ["24h", "1h", "start"] }), null);
});

test("dueDraftReminder goes straight to start and skips stale 24h/1h when discovered very late (Worker outage spanning the scheduled time)", () => {
  // scheduledAt was 3 days ago; the 24h/1h windows are long gone, but this
  // must never retroactively fire them - only "start" makes sense now.
  const scheduledAt = NOW - 3 * ONE_DAY;
  assert.equal(dueDraftReminder({ scheduledAt, now: NOW, sentKinds: [] }), "start");
});

test("dueDraftReminder never fires 24h for a league scheduled with less than 24h lead time", () => {
  // Scheduled only 2 hours out: the 24h window (23h-24h before) is never
  // entered because msUntil starts already below it. Not stale, just skipped.
  const scheduledAt = NOW + 2 * ONE_HOUR;
  assert.equal(dueDraftReminder({ scheduledAt, now: NOW, sentKinds: [] }), null);
});

test("dueDraftReminder accepts sentKinds as a Set or a plain array interchangeably", () => {
  const scheduledAt = NOW + 24 * ONE_HOUR;
  assert.equal(dueDraftReminder({ scheduledAt, now: NOW, sentKinds: new Set(["24h"]) }), null);
  assert.equal(dueDraftReminder({ scheduledAt, now: NOW, sentKinds: ["24h"] }), null);
});

test("dueDraftReminder returns null for an unparseable scheduledAt rather than throwing", () => {
  assert.equal(dueDraftReminder({ scheduledAt: "not a date", now: NOW, sentKinds: [] }), null);
});

// -- isDraftSoon -----------------------------------------------------------------

test("isDraftSoon is true within the hour, false beyond it", () => {
  assert.equal(isDraftSoon(30 * 60 * 1000), true);
  assert.equal(isDraftSoon(ONE_HOUR), true);
  assert.equal(isDraftSoon(ONE_HOUR + 1), false);
  assert.equal(isDraftSoon(2 * ONE_HOUR), false);
});

test("isDraftSoon is false once the instant has passed", () => {
  assert.equal(isDraftSoon(-1), false);
});

// -- formatScheduleCountdown ------------------------------------------------------

test("formatScheduleCountdown renders days+hours when a day or more remains", () => {
  assert.equal(formatScheduleCountdown(2 * ONE_DAY + 4 * ONE_HOUR), "2d 4h");
});

test("formatScheduleCountdown renders hours+minutes under a day", () => {
  assert.equal(formatScheduleCountdown(3 * ONE_HOUR + 12 * 60 * 1000), "3h 12m");
});

test("formatScheduleCountdown renders just minutes under an hour", () => {
  assert.equal(formatScheduleCountdown(8 * 60 * 1000), "8m");
});

test("formatScheduleCountdown never goes negative", () => {
  assert.equal(formatScheduleCountdown(-500), "Starting any moment");
  assert.equal(formatScheduleCountdown(0), "Starting any moment");
});

// -- Local time formatting/conversion --------------------------------------------

test("isoToLocalInputValue then localInputValueToUtcIso round-trips to the same instant (minute precision)", () => {
  const iso = "2026-08-17T19:00:00.000Z";
  const inputValue = isoToLocalInputValue(iso);
  const roundTripped = localInputValueToUtcIso(inputValue);
  assert.equal(roundTripped, iso);
});

test("isoToLocalInputValue returns the datetime-local shape", () => {
  const value = isoToLocalInputValue("2026-08-17T19:00:00.000Z");
  assert.match(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
});

test("isoToLocalInputValue returns empty string for a bad input rather than throwing", () => {
  assert.equal(isoToLocalInputValue("not a date"), "");
});

test("localInputValueToUtcIso returns null for empty/bad input", () => {
  assert.equal(localInputValueToUtcIso(""), null);
  assert.equal(localInputValueToUtcIso(null), null);
  assert.equal(localInputValueToUtcIso("not a date"), null);
});

test("formatLocalSchedule produces a weekday-day-month, time string", () => {
  const label = formatLocalSchedule("2026-08-17T19:00:00.000Z");
  assert.match(label, /^[A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2}, \d{2}:\d{2}$/);
});

test("formatLocalSchedule returns empty string for a bad input rather than throwing", () => {
  assert.equal(formatLocalSchedule("not a date"), "");
});

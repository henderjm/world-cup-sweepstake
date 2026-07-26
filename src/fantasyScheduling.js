// Pure draft-scheduling logic: validating a commissioner's chosen start time,
// deciding which one-time reminder (if any) is due right now, and the
// countdown/timezone formatting the lobby UI needs. No DOM, no fetch, no D1:
// worker.js and src/fantasyView.js/app.js are thin shells around these
// functions, mirroring how draftLogic.js/fantasyWaivers.js/fantasyLocks.js
// keep their rules unit-tested outside the Worker and the browser alike.
//
// The stored value (fantasy_draft_schedule.scheduled_at) is always an ISO
// 8601 UTC string; every local-time concern (display, the datetime-local
// input) lives entirely in this module's isoToLocalInputValue/
// localInputValueToUtcIso/formatLocalSchedule so the rest of the app never
// juggles timezones by hand.

const ONE_HOUR_MS = 60 * 60 * 1000;
const TWENTY_FOUR_HOURS_MS = 24 * ONE_HOUR_MS;
// Tolerance either side of a target offset (24h/1h before kickoff), so a
// once-a-minute cron reliably catches the instant even with an occasional
// slow tick; mirrors the 15-minute cadence already used elsewhere for
// upcoming-fixture polling (see worker.js's getLive).
const REMINDER_WINDOW_MS = 15 * 60 * 1000;

// Reject anything wildly far out: a "6 months from now" schedule is almost
// certainly a mis-entered date (wrong year, day/month swapped), not a real
// plan, so it is refused at the door rather than silently accepted.
export const MAX_SCHEDULE_DAYS = 183;

// Validates a commissioner-supplied scheduledAt (any string Date.parse
// accepts; the route always sends ISO 8601) against `now` (epoch ms).
// Returns { ok: true, scheduledAtIso } or { ok: false, error }.
export function validateDraftSchedule(scheduledAt, now = Date.now()) {
  const ms = Date.parse(scheduledAt);
  if (!Number.isFinite(ms)) return { ok: false, error: "scheduledAt must be a valid date" };
  if (ms <= now) return { ok: false, error: "scheduledAt must be in the future" };
  const maxMs = MAX_SCHEDULE_DAYS * 24 * 60 * 60 * 1000;
  if (ms - now > maxMs) {
    return { ok: false, error: `scheduledAt is too far out (max ${MAX_SCHEDULE_DAYS} days)` };
  }
  return { ok: true, scheduledAtIso: new Date(ms).toISOString() };
}

// Which reminder kind, if any, is due right now for a league scheduled at
// `scheduledAt`, given the set of kinds ("24h" | "1h" | "start") already sent
// (fantasy_draft_reminders). `now` and `scheduledAt` are both epoch ms or
// anything Date.parse accepts.
//
// Once the scheduled instant has arrived or passed (msUntil <= 0), the
// answer is always "start", never a stale "24h"/"1h" - this is what keeps a
// Worker outage spanning the scheduled time from firing an earlier reminder
// after the fact once the moment itself has already arrived: starting the
// draft late is still correct, announcing it was "tomorrow" after it has
// already happened is not. Each window is deliberately narrow and far apart
// from the others (23 hours separate the 24h and 1h windows), so a league
// scheduled with less lead time than a window's offset simply never enters
// it - not a bug, just nothing to remind about that far out.
export function dueDraftReminder({ scheduledAt, now = Date.now(), sentKinds = [] }) {
  const scheduledMs = typeof scheduledAt === "number" ? scheduledAt : Date.parse(scheduledAt);
  if (!Number.isFinite(scheduledMs)) return null;
  const sent = sentKinds instanceof Set ? sentKinds : new Set(sentKinds);
  const nowMs = typeof now === "number" ? now : Date.parse(now);
  const msUntil = scheduledMs - nowMs;

  if (msUntil <= 0) return sent.has("start") ? null : "start";
  if (!sent.has("1h") && withinWindow(msUntil, ONE_HOUR_MS)) return "1h";
  if (!sent.has("24h") && withinWindow(msUntil, TWENTY_FOUR_HOURS_MS)) return "24h";
  return null;
}

function withinWindow(msUntil, targetMs) {
  return msUntil <= targetMs + REMINDER_WINDOW_MS && msUntil > targetMs - REMINDER_WINDOW_MS;
}

// Whether a scheduled draft is "soon" (within the hour), for the lobby's
// countdown to visually emphasize the same way the live pick clock does.
export function isDraftSoon(msRemaining) {
  return Number.isFinite(msRemaining) && msRemaining >= 0 && msRemaining <= ONE_HOUR_MS;
}

// "2d 4h" / "3h 12m" / "8m" style countdown for a schedule that can be days
// away, unlike fantasyDraft.js's formatCountdown (mm:ss, for the 60-second
// pick clock). Clamped so a message arriving a beat late never shows
// negative, matching that module's own convention.
export function formatScheduleCountdown(msRemaining) {
  if (!Number.isFinite(msRemaining) || msRemaining <= 0) return "Starting any moment";
  const totalMinutes = Math.floor(msRemaining / 60000);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Formats a stored UTC ISO instant for display in the caller's local
// timezone, e.g. "Sun 17 Aug, 20:00". Built from Date's own local getters
// (getDay/getHours/...) rather than Intl, so the result never depends on the
// runtime's ICU data or locale defaults - only its timezone offset, which is
// exactly the one thing this function is meant to apply.
export function formatLocalSchedule(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${WEEKDAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]}, ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// Converts a stored UTC ISO instant to the value a <input type="datetime-
// local"> expects ("YYYY-MM-DDTHH:mm"), in the caller's local timezone, so a
// commissioner rescheduling sees the input pre-filled with the time they
// actually picked rather than the raw UTC instant.
export function isoToLocalInputValue(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// Reverse of isoToLocalInputValue: interprets a datetime-local input's value
// (no timezone suffix) as local time - the behavior both browsers and Node's
// Date constructor already give a date-time string with no offset - and
// returns the equivalent UTC ISO string, which is what the schedule route
// stores and every reminder/auto-start comparison above runs against.
export function localInputValueToUtcIso(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

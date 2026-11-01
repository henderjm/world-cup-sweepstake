// GET /match/:id/centre: Sportmonks team statistics, xG and pressure for an
// API-Football fixture id (the hybrid described in src/sportmonks.js).
//
// Spend is bounded three ways, because the trial key's allowance is per
// entity per hour and a leak here would be paid in Fixture calls:
//   1. In-isolate memo: a day's fixture list for six hours, a live fixture's
//      centre for 60 seconds, a finished one for 10 minutes (Basic xG lands
//      after the whistle, so it is worth a few re-reads), nothing pre-match.
//   2. A floor on the provider's own `rate_limit.remaining`: below it the
//      route stops calling until the hour resets and answers "unavailable".
//   3. Missing SPORTMONKS_API_KEY is a 501, the same convention as DB.
// The key is sent as a header, never in a URL that could reach a log.

import { isFinished, isLive } from "../src/format.js";
import {
  MATCH_CENTRE_INCLUDES, SPORTMONKS_BASE, SPORTMONKS_LEAGUES, findSportmonksFixture, mapMatchCentre,
} from "../src/sportmonks.js";

const DAY_TTL_MS = 6 * 60 * 60 * 1000;
const LIVE_TTL_MS = 60 * 1000;
const FINISHED_TTL_MS = 10 * 60 * 1000;
export const SPORTMONKS_REMAINING_FLOOR = 200;

const memo = new Map();
let limitedUntil = 0;

async function sportmonks(env, path, ttlMs, now) {
  const hit = memo.get(path);
  if (hit && hit.expires > now) return hit.value;
  if (now < limitedUntil) throw Error("sportmonks allowance floor reached");
  const response = await fetch(`${SPORTMONKS_BASE}${path}`, {
    headers: { Authorization: env.SPORTMONKS_API_KEY, Accept: "application/json" },
  });
  const body = await response.json().catch(() => ({}));
  const remaining = Number(body.rate_limit?.remaining);
  if (Number.isFinite(remaining) && remaining < SPORTMONKS_REMAINING_FLOOR) {
    limitedUntil = now + Math.max(60, Number(body.rate_limit?.resets_in_seconds) || 3600) * 1000;
    console.error(`sportmonks: ${remaining} ${body.rate_limit?.requested_entity} calls left, pausing`);
  }
  if (!response.ok) throw Error(`sportmonks ${response.status}`);
  memo.set(path, { value: body.data ?? null, expires: now + ttlMs });
  if (memo.size > 200) memo.delete(memo.keys().next().value);
  return body.data ?? null;
}

// { available: false } when there is nothing to show yet (pre-match, no
// joinable fixture, allowance floor); the client then omits the section.
export async function matchCentre(env, match, now = Date.now()) {
  const league = SPORTMONKS_LEAGUES[match.competition];
  const live = isLive(match.status);
  if (!league || !(live || isFinished(match.status))) return { available: false };
  const day = String(match.utcDate ?? "").slice(0, 10);
  const fixtures = await sportmonks(env, `/fixtures/date/${day}?filters=fixtureLeagues:${league}&include=participants`, DAY_TTL_MS, now);
  const fixture = findSportmonksFixture(fixtures, match);
  if (!fixture) return { available: false };
  const centre = mapMatchCentre(await sportmonks(
    env, `/fixtures/${fixture.id}?include=${MATCH_CENTRE_INCLUDES}`, live ? LIVE_TTL_MS : FINISHED_TTL_MS, now,
  ));
  return centre ? { available: true, ...centre } : { available: false };
}

export function resetSportmonksMemo() {
  memo.clear();
  limitedUntil = 0;
}

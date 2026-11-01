// GET /match/:id/centre: Sportmonks team statistics, xG and pressure for an
// API-Football fixture id (the hybrid described in src/sportmonks.js).
//
// Cached for a day's fixture list six hours, a live fixture's centre 60
// seconds, a finished one 10 minutes (Basic xG lands after the whistle, so it
// is worth a few re-reads), nothing pre-match. The memo, the allowance floor
// and the header-only key are worker/sportmonksClient.js's. Missing
// SPORTMONKS_API_KEY is a 501, the same convention as DB.

import { isFinished, isLive } from "../src/format.js";
import { MATCH_CENTRE_INCLUDES, SPORTMONKS_LEAGUES, findSportmonksFixture, mapMatchCentre } from "../src/sportmonks.js";
import { sportmonksIdOf } from "../src/sportmonksFeed.js";
import { resetSportmonksClient, sportmonks } from "./sportmonksClient.js";

const DAY_TTL_MS = 6 * 60 * 60 * 1000;
const LIVE_TTL_MS = 60 * 1000;
const FINISHED_TTL_MS = 10 * 60 * 1000;

// { available: false } when there is nothing to show yet (pre-match, no
// joinable fixture, allowance floor); the client then omits the section.
export async function matchCentre(env, match, now = Date.now()) {
  const live = isLive(match.status);
  if (!(live || isFinished(match.status))) return { available: false };
  // A Sportmonks-served competition's match IS a Sportmonks fixture: no join.
  const direct = sportmonksIdOf(match.id);
  if (direct) {
    const centre = mapMatchCentre(await sportmonks(env, `/fixtures/${direct}?include=${MATCH_CENTRE_INCLUDES}`, live ? LIVE_TTL_MS : FINISHED_TTL_MS, now));
    return centre ? { available: true, ...centre } : { available: false };
  }
  const league = SPORTMONKS_LEAGUES[match.competition];
  if (!league) return { available: false };
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
  resetSportmonksClient();
}

// GET /match/:id/centre: Sportmonks team statistics, xG and pressure for an
// API-Football fixture id (the hybrid described in src/sportmonks.js).
//
// Cached for a day's fixture list six hours, a live fixture's centre 60
// seconds (30 since the Starter plan's 3,000+ calls an hour), a finished one 10 minutes (Basic xG lands after the whistle, so it
// is worth a few re-reads), an upcoming one 30 minutes (only who is out is
// worth showing before kickoff). The memo, the allowance floor
// and the header-only key are worker/sportmonksClient.js's. Missing
// SPORTMONKS_API_KEY is a 501, the same convention as DB.

import { isFinished, isLive } from "../src/format.js";
import { MATCH_CENTRE_INCLUDES, PREDICTION_INCLUDES, SPORTMONKS_LEAGUES, findSportmonksFixture, mapMatchCentre, mapPredictions } from "../src/sportmonks.js";
import { sportmonksIdOf } from "../src/sportmonksFeed.js";
import { resetSportmonksClient, sportmonks } from "./sportmonksClient.js";

const DAY_TTL_MS = 6 * 60 * 60 * 1000;
const LIVE_TTL_MS = 30 * 1000;
const FINISHED_TTL_MS = 10 * 60 * 1000;
const UPCOMING_TTL_MS = 30 * 60 * 1000;
const UPCOMING = new Set(["TIMED", "SCHEDULED"]);

// The pre-match model, only before kickoff. Its own call and its own catch:
// predictions are an add-on, and losing them must never lose the centre.
async function predictionsFor(env, fixtureId, now) {
  try {
    return mapPredictions(await sportmonks(env, `/fixtures/${fixtureId}?include=${PREDICTION_INCLUDES}`, UPCOMING_TTL_MS, now));
  } catch {
    return null;
  }
}

async function centreFor(env, fixtureId, match, ttl, now) {
  const centre = mapMatchCentre(await sportmonks(env, `/fixtures/${fixtureId}?include=${MATCH_CENTRE_INCLUDES}`, ttl, now));
  if (!centre) return { available: false };
  const predictions = UPCOMING.has(match.status) ? await predictionsFor(env, fixtureId, now) : null;
  return { available: true, ...centre, predictions };
}

// { available: false } when there is nothing to show (no joinable fixture,
// allowance floor); the client then omits the sections it feeds.
export async function matchCentre(env, match, now = Date.now()) {
  const live = isLive(match.status);
  if (!(live || isFinished(match.status) || UPCOMING.has(match.status))) return { available: false };
  const ttl = live ? LIVE_TTL_MS : isFinished(match.status) ? FINISHED_TTL_MS : UPCOMING_TTL_MS;
  // A Sportmonks-served competition's match IS a Sportmonks fixture: no join.
  const direct = sportmonksIdOf(match.id);
  if (direct) return centreFor(env, direct, match, ttl, now);
  const league = SPORTMONKS_LEAGUES[match.competition];
  if (!league) return { available: false };
  const day = String(match.utcDate ?? "").slice(0, 10);
  const fixtures = await sportmonks(env, `/fixtures/date/${day}?filters=fixtureLeagues:${league}&include=participants`, DAY_TTL_MS, now);
  const fixture = findSportmonksFixture(fixtures, match);
  if (!fixture) return { available: false };
  return centreFor(env, fixture.id, match, ttl, now);
}

export function resetSportmonksMemo() {
  resetSportmonksClient();
}

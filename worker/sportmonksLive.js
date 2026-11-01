// The live feed, match lookup and match detail for competitions Sportmonks
// serves on its own (Serie A, La Liga). Mapping is src/sportmonksFeed.js;
// spending is worker/sportmonksClient.js. Nothing here touches the
// API-Football allowance, which is the point: see the comment on SA/PD in
// src/competitions.js.
//
// Cadence (per isolate, both leagues): the season id twelve-hourly; the
// fixture window (five weeks back for form, three ahead for the date strip)
// every ten minutes, every two while a match is on or about to start; the
// in-play list once a minute, and only while one is; the table every ten
// minutes, every five while a match is on.

import { COMPETITIONS, SPORTMONKS_COMPETITION_CODES } from "../src/competitions.js";
import { mapSportmonksDetail, mapSportmonksFeed, sportmonksIdOf, sportmonksInstant } from "../src/sportmonksFeed.js";
import { sportmonks, sportmonksBody, sportmonksPages } from "./sportmonksClient.js";

const SEASON_TTL_MS = 12 * 60 * 60 * 1000;
const WINDOW_TTL_MS = 10 * 60 * 1000;
const HOT_WINDOW_TTL_MS = 2 * 60 * 1000;
const INPLAY_TTL_MS = 60 * 1000;
const TABLE_TTL_MS = 10 * 60 * 1000;
const HOT_TABLE_TTL_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const FEED_INCLUDES = "participants;state;scores;periods;round;venue";
const DETAIL_INCLUDES = "participants;scores;state;periods;events;lineups.details;formations;venue;referees.referee;round";
const ENDED = new Set(["FT", "AET", "FT_PEN", "POSTPONED", "CANCELLED", "ABANDONED", "DELETED", "AWARDED", "WO"]);

export function isSportmonksCompetition(code) {
  return SPORTMONKS_COMPETITION_CODES.includes(code);
}

function day(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// A match on now or within the next ten minutes: the window refreshes faster
// and the in-play list is read.
function hot(fixtures, now) {
  return fixtures.some(fixture => {
    const kickoff = Date.parse(sportmonksInstant(fixture.starting_at) ?? "");
    return !ENDED.has(fixture.state?.developer_name) && kickoff <= now + 10 * 60 * 1000 && kickoff >= now - 4 * 60 * 60 * 1000;
  });
}

export async function getSportmonksLive(env, code, now = Date.now()) {
  const league = COMPETITIONS[code]?.sportmonksLeagueId;
  if (!league) throw Error(`not a Sportmonks competition: ${code}`);
  const season = (await sportmonks(env, `/leagues/${league}?include=currentSeason`, SEASON_TTL_MS, now))?.currentseason;
  const windowPath = `/fixtures/between/${day(now - 35 * DAY_MS)}/${day(now + 21 * DAY_MS)}?filters=fixtureLeagues:${league}&per_page=50&include=${FEED_INCLUDES}`;
  let window = await sportmonksPages(env, windowPath, WINDOW_TTL_MS, now);
  const isHot = hot(window.rows, now);
  if (isHot) window = await sportmonksPages(env, windowPath, HOT_WINDOW_TTL_MS, now);
  let fixtures = window.rows;
  let fetchedAt = window.fetchedAt;
  if (isHot) {
    const inplay = await sportmonksBody(env, `/livescores/inplay?filters=fixtureLeagues:${league}&include=${FEED_INCLUDES}`, INPLAY_TTL_MS, now);
    const live = new Map((inplay.body.data ?? []).map(fixture => [fixture.id, fixture]));
    fixtures = fixtures.map(fixture => live.get(fixture.id) ?? fixture);
    fetchedAt = inplay.fetchedAt;
  }
  const standings = season?.id
    ? (await sportmonks(env, `/standings/seasons/${season.id}?include=participant;details`, isHot ? HOT_TABLE_TTL_MS : TABLE_TTL_MS, now)) ?? []
    : [];
  return mapSportmonksFeed({
    competition: code,
    season: String(season?.name ?? "").slice(0, 4) || null,
    fixtures,
    standings,
    lastUpdated: new Date(fetchedAt).toISOString(),
  });
}

// The app match for a Sportmonks-served id, with its competition, or null.
export async function findSportmonksMatch(env, id, now = Date.now()) {
  if (!sportmonksIdOf(id) || !env.SPORTMONKS_API_KEY) return null;
  for (const code of SPORTMONKS_COMPETITION_CODES) {
    try {
      const match = (await getSportmonksLive(env, code, now)).matches.find(entry => entry.id === id);
      if (match) return { ...match, competition: code };
    } catch {
      // one league's feed being down must not 404 the other
    }
  }
  return null;
}

export async function sportmonksMatchDetail(env, match, now = Date.now()) {
  const id = sportmonksIdOf(match.id);
  const ttl = match.status === "FINISHED" ? 10 * 60 * 1000 : match.status === "TIMED" ? 5 * 60 * 1000 : 30 * 1000;
  const fixture = await sportmonks(env, `/fixtures/${id}?include=${DETAIL_INCLUDES}&filters=lineupDetailTypes:118,119`, ttl, now);
  return fixture ? mapSportmonksDetail(fixture) : null;
}

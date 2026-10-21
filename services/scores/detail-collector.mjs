import { isLive } from "../../src/format.js";
import { COMPETITIONS } from "../../src/competitions.js";
import { assertApiFootballPayload } from "../../src/apiFootballPayload.js";
import { mapApiFootballMatches } from "../../src/mapApiFootball.js";
import { matchDetailCacheProfile } from "../../src/matchDetailCache.js";
import { DETAIL_SECTIONS, detailCoverage, detailKey, detailSubject } from "./details.mjs";

export function detailJobs(snapshots, seasons, manifests, now) {
  const jobs = [], known = new Set();
  for (const [competition, season] of Object.entries(seasons)) {
    for (const { match } of snapshots[competition]?.fixtures ?? []) {
      const key = detailKey(competition, season, match.id);
      known.add(key);
      if (Date.parse(match.utcDate) > now + 2 * 3600000 || ["CANCELLED", "POSTPONED"].includes(match.status)) continue;
      const terminal = ["FINISHED", "AWARDED"].includes(match.status);
      const kickoff = Date.parse(match.utcDate);
      const current = isLive(match.status) || (kickoff >= now - 24 * 3600000
        && (terminal || ["TIMED", "SCHEDULED"].includes(match.status)));
      const priority = current ? 4 : 6;
      const beforeKickoff = ["TIMED", "SCHEDULED"].includes(match.status);
      const add = (section, due) => {
        const admission = current ? "scores" : "supplementary";
        jobs.push({ competition, season, kind: "detail", section, match, priority, due, admission,
          detailKey: key, key: `${key}:${section}:${admission}` });
      };
      if (!manifests.has(key)) { add("hydrate", 0); continue; }
      const manifest = manifests.get(key), profile = matchDetailCacheProfile(match, now);
      const coverage = detailCoverage(manifest, match, now);
      for (const section of DETAIL_SECTIONS) {
        if (beforeKickoff && ["events", "players"].includes(section)) continue;
        // Fixture identity supplies the team IDs used to validate other sections.
        if (section !== "fixture" && !manifest?.sections.fixture) continue;
        const previous = manifest?.sections[section];
        const interval = beforeKickoff ? (section === "fixture" || previous?.coverage === "complete" ? 15 * 60000 : 5 * 60000)
          : terminal ? profile[section] * 1000
            : Math.min(profile[section] * 1000, previous?.coverage === "partial" ? 60000 : Infinity);
        add(section, previous && coverage[section].state !== "outdated-result"
          ? previous.observedAt + interval : 0);
      }
    }
  }
  for (const key of manifests.keys()) if (!known.has(key)) manifests.delete(key);
  return jobs;
}

const positive = value => Number.isSafeInteger(value) && value > 0;
// A payload whose own shape is wrong (a player with no provider id, an event
// for a team not in the fixture). Refetching it seconds later returns the same
// payload, so the collector backs these off (DETAIL_VALIDATION_RETRY_MS) where
// a mismatch with the stored score, which clears within a tick, keeps the
// short retry. Named so the logs say which kind of failure it was.
export function malformed(message) {
  const error = Error(message);
  error.name = "MalformedDetailPayload";
  return error;
}
const named = value => typeof value === "string" && value.trim().length > 0;
// The provider fields players it has not registered yet with id null (lineups)
// or 0 (player statistics): Roma's Di Nunzio on 2026-10-20 failed five CL
// fixtures' sections every five minutes all day. A few such named players per
// team are real; a team of them is a broken payload.
const MAX_UNREGISTERED_PER_TEAM = 3;
const unregistered = value => (value?.id == null || value.id === 0) && named(value?.name);
const player = value => (positive(value?.id) || unregistered(value)) && named(value?.name);
function validRoster(entries) {
  const ids = entries.map(entry => entry.player?.id).filter(positive);
  return entries.every(entry => player(entry.player)) && new Set(ids).size === ids.length
    && entries.length - ids.length <= MAX_UNREGISTERED_PER_TEAM;
}

export function validateDetailPayload(payload, job, stored) {
  assertApiFootballPayload(payload);
  if (payload.paging?.current !== 1 || payload.paging.total !== 1 || payload.results !== payload.response.length)
    throw Error("Incomplete detail page");
  const rows = payload.response;
  if (job.section === "fixture") {
    const row = rows[0];
    if (rows.length !== 1 || row.fixture?.id !== job.match.id
      || row.league?.id !== COMPETITIONS[job.competition].apiFootballLeagueId || String(row.league.season) !== job.season
      || !positive(row.teams?.home?.id) || !positive(row.teams?.away?.id) || row.teams.home.id === row.teams.away.id
      || detailSubject(mapApiFootballMatches(payload)[0]) !== detailSubject(job.match))
      throw Error("Detail fixture does not match stored score");
    return "complete";
  }
  const fixture = stored?.payloads.fixture?.response[0];
  if (!fixture) throw Error("Detail fixture identity unavailable");
  const teamIds = [fixture.teams.home.id, fixture.teams.away.id];
  const beforeKickoff = ["TIMED", "SCHEDULED"].includes(job.match.status);
  let complete;
  if (job.section === "events") {
    if (rows.length > 500 || rows.some(row => !teamIds.includes(row.team?.id) || !named(row.type)
      || !Number.isInteger(row.time?.elapsed) || row.time.elapsed < 0 || row.time.elapsed > 180))
      throw malformed("Invalid match events");
    const goals = rows.filter(row => row.type === "Goal" && ["Normal Goal", "Own Goal", "Penalty"].includes(row.detail));
    const score = job.match.score;
    complete = Number.isInteger(score?.home) && Number.isInteger(score?.away) && goals.length === score.home + score.away;
  } else {
    if (rows.length > 2 || new Set(rows.map(row => row.team?.id)).size !== rows.length
      || rows.some(row => !teamIds.includes(row.team?.id))) throw malformed("Unexpected detail teams");
    if (job.section === "lineups") {
      if (rows.some(row => !Array.isArray(row.startXI) || !Array.isArray(row.substitutes)
        || row.startXI.length > 11 || row.substitutes.length > 30
        || !validRoster([...row.startXI, ...row.substitutes])))
        throw malformed("Invalid lineup players");
      complete = rows.length === 2 && rows.every(row => row.startXI.length === 11);
    } else if (job.section === "players") {
      if (rows.some(row => !Array.isArray(row.players) || row.players.length > 50
        || !validRoster(row.players)
        || row.players.some(entry => !Array.isArray(entry.statistics) || entry.statistics.length !== 1
          || !entry.statistics[0].games || (entry.statistics[0].games.minutes != null
            && (!Number.isInteger(entry.statistics[0].games.minutes) || entry.statistics[0].games.minutes < 0)))))
        throw malformed("Invalid player statistics");
      complete = rows.length === 2 && rows.every(row => row.players.filter(entry => Number.isInteger(entry.statistics[0].games.minutes)).length >= 11);
    } else throw Error("Unknown detail section");
  }
  return complete ? "complete" : beforeKickoff && rows.length === 0 ? "unpublished" : "partial";
}

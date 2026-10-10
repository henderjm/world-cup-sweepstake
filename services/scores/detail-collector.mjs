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
      const priority = terminal ? 6 : 4;
      const kickoff = Date.parse(match.utcDate);
      const current = isLive(match.status) || (kickoff >= now - 4 * 3600000
        && (terminal || ["TIMED", "SCHEDULED"].includes(match.status)));
      const add = (section, due) => {
        const admission = current && section !== "players" ? "match-detail" : "supplementary";
        jobs.push({ competition, season, kind: "detail", section, match, priority, due, admission,
          detailKey: key, key: `${key}:${section}:${admission}` });
      };
      if (!manifests.has(key)) { add("hydrate", 0); continue; }
      const manifest = manifests.get(key), profile = matchDetailCacheProfile(match, now);
      const coverage = detailCoverage(manifest, match, now);
      for (const section of DETAIL_SECTIONS) {
        // Fixture identity supplies the team IDs used to validate other sections.
        if (section !== "fixture" && !manifest?.sections.fixture) continue;
        const previous = manifest?.sections[section];
        add(section, previous && coverage[section].state !== "outdated-result"
          ? previous.observedAt + Math.min(profile[section] * 1000, previous.coverage === "partial" ? 30000 : Infinity) : 0);
      }
    }
  }
  for (const key of manifests.keys()) if (!known.has(key)) manifests.delete(key);
  return jobs;
}

const positive = value => Number.isSafeInteger(value) && value > 0;
const named = value => typeof value === "string" && value.trim().length > 0;
const player = value => positive(value?.id) && named(value?.name);

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
      throw Error("Invalid match events");
    const goals = rows.filter(row => row.type === "Goal" && ["Normal Goal", "Own Goal", "Penalty"].includes(row.detail));
    const score = job.match.score;
    complete = Number.isInteger(score?.home) && Number.isInteger(score?.away) && goals.length === score.home + score.away;
  } else {
    if (rows.length > 2 || new Set(rows.map(row => row.team?.id)).size !== rows.length
      || rows.some(row => !teamIds.includes(row.team?.id))) throw Error("Unexpected detail teams");
    if (job.section === "lineups") {
      if (rows.some(row => !Array.isArray(row.startXI) || !Array.isArray(row.substitutes)
        || row.startXI.length > 11 || row.substitutes.length > 30
        || [...row.startXI, ...row.substitutes].some(entry => !player(entry.player))
        || new Set([...row.startXI, ...row.substitutes].map(entry => entry.player.id)).size !== row.startXI.length + row.substitutes.length))
        throw Error("Invalid lineup players");
      complete = rows.length === 2 && rows.every(row => row.startXI.length === 11);
    } else if (job.section === "players") {
      if (rows.some(row => !Array.isArray(row.players) || row.players.length > 50
        || new Set(row.players.map(entry => entry.player?.id)).size !== row.players.length
        || row.players.some(entry => !player(entry.player) || !Array.isArray(entry.statistics) || entry.statistics.length !== 1
          || !entry.statistics[0].games || (entry.statistics[0].games.minutes != null
            && (!Number.isInteger(entry.statistics[0].games.minutes) || entry.statistics[0].games.minutes < 0)))))
        throw Error("Invalid player statistics");
      complete = rows.length === 2 && rows.every(row => row.players.filter(entry => Number.isInteger(entry.statistics[0].games.minutes)).length >= 11);
    } else throw Error("Unknown detail section");
  }
  return complete ? "complete" : beforeKickoff && rows.length === 0 ? "unpublished" : "partial";
}

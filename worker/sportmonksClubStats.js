// GET /:comp/club?team=<name>: one club's season player stats for the club
// sheet, from Sportmonks' season squad. The club is resolved server-side by
// name against the current season's standings, so the caller's text never
// reaches a Sportmonks path; only the resolved numeric team id does. Spending
// goes through worker/sportmonksClient.js like every other Sportmonks call.

import { findParticipantId, mapSquadStats } from "../src/sportmonksSquad.js";
import { sportmonksLeagueFor } from "../src/sportmonksTopscorers.js";
import { currentSeasonId } from "./sportmonksLeagueStats.js";
import { sportmonks, sportmonksBody } from "./sportmonksClient.js";

// Same path as worker/sportmonksLive.js's table read, so the Sportmonks-served
// leagues share its memo instead of paying twice.
const STANDINGS_TTL_MS = 10 * 60 * 1000;
// Season figures move only when a match finishes.
const SQUAD_TTL_MS = 60 * 60 * 1000;
export const CLUB_NAME_MAX = 80;

export async function clubStats(env, code, team, now = Date.now()) {
  const league = sportmonksLeagueFor(code);
  if (!league || !team || team.length > CLUB_NAME_MAX) return { available: false };
  const seasonId = await currentSeasonId(env, league, now);
  if (!seasonId) return { available: false };
  const standings = await sportmonks(env, `/standings/seasons/${seasonId}?include=participant;details`, STANDINGS_TTL_MS, now);
  const teamId = findParticipantId(standings, team);
  if (!teamId) return { available: false };
  const entry = await sportmonksBody(
    env,
    `/squads/seasons/${seasonId}/teams/${teamId}?include=player.statistics.details&filters=playerStatisticSeasons:${seasonId}`,
    SQUAD_TTL_MS,
    now,
  );
  const players = mapSquadStats(entry.body.data, seasonId);
  if (!players.length) return { available: false };
  return { available: true, seasonId, fetchedAt: new Date(entry.fetchedAt).toISOString(), players };
}

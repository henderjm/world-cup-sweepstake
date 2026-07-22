// Bakes data/PL/players.json: the fantasy draftable player pool. Runs on a slower
// (daily) cadence than the live-data fetch, since squads barely change.
//
// Primary path: football-data's /v4/teams/{id} squad endpoint gives a complete
// pool for every club on day one, with a clean four-value position field
// (Goalkeeper/Defence/Midfield/Offence) that maps directly to GK/DEF/MID/FWD. Its
// tier isn't documented, so this is attempted first and verified by running it.
//
// Fallback path: if the squads endpoint fails for the competition (403/404/network),
// the pool is instead accumulated from every match-detail file already baked under
// data/PL/matches/ (the same directory the Golden Boot scans) — lineups and benches
// only reveal players as they actually feature, so the pool starts shallow and grows
// gameweek by gameweek. The output is stamped `complete: false` so the frontend can
// say so, rather than accumulation and squads ever silently mixing mid-run.

import { readFile, readdir, writeFile } from "node:fs/promises";

import { bucketPosition } from "../src/fantasy.js";
import { fetchFootballData, sleep } from "./lib/footballData.mjs";

const token = process.env.FOOTBALL_DATA_TOKEN;
const competition = process.env.FANTASY_COMPETITION ?? "PL";
const season = process.env.FOOTBALL_DATA_SEASON ?? "2026";

const dataDir = new URL(`../data/${competition}/`, import.meta.url);
const matchesDir = new URL("matches/", dataDir);

// Spacing between per-club squad calls, same reasoning as the live-data script's
// per-match throttle: stay comfortably under football-data's ~10 req/min free tier.
const TEAM_THROTTLE_MS = 6500;

if (!token) {
  console.log("FOOTBALL_DATA_TOKEN is not set; no player pool generated.");
  process.exit(0);
}

const standings = await fetchFootballData(
  `/v4/competitions/${competition}/standings?season=${season}`,
  token,
).catch((error) => {
  console.warn(`could not load ${competition} standings for club ids: ${error.message}`);
  return { standings: [] };
});

const clubs = (standings.standings?.[0]?.table ?? [])
  .map((row) => row.team)
  .filter((team) => team?.id);

if (!clubs.length) {
  console.warn(`no ${competition} clubs found (standings empty or unavailable); nothing to fetch.`);
  process.exit(0);
}

const players = await fetchViaSquads(clubs);
const { list, complete } = players ?? (await fetchViaLineups());

const body = {
  source: complete ? "football-data.org (squads)" : "football-data.org (accumulated from lineups)",
  lastUpdated: new Date().toISOString(),
  complete,
  players: list,
};
await writeFile(new URL("players.json", dataDir), `${JSON.stringify(body, null, 2)}\n`);
console.log(`Wrote ${competition}/players.json (${list.length} players, complete=${complete}).`);

// Primary path: one call per club to /v4/teams/{id}. Any single club failing marks
// the whole run as unavailable (rather than a competition's pool being some clubs'
// full squads and others' partial lineup-only players, which would be a confusing,
// silently-inconsistent mix) and falls through to the lineup-accumulation path.
async function fetchViaSquads(clubs) {
  const list = [];
  for (const club of clubs) {
    try {
      const team = await fetchFootballData(`/v4/teams/${club.id}`, token);
      for (const member of team.squad ?? []) {
        if (member?.id == null) continue;
        list.push({
          id: member.id,
          name: member.name ?? "",
          team: team.shortName ?? team.name ?? club.shortName ?? club.name ?? "",
          position: bucketPosition(member.position),
          crest: team.crest ?? club.crest ?? null,
        });
      }
    } catch (error) {
      console.warn(`squads endpoint unavailable (${club.name}: ${error.message}); falling back to lineups`);
      return null;
    }
    await sleep(TEAM_THROTTLE_MS);
  }
  return { list, complete: true };
}

// Fallback path: accumulate from every match-detail file already on disk. Only
// reveals players who have actually appeared in a lineup or on the bench so far.
async function fetchViaLineups() {
  const files = (await readdir(matchesDir).catch(() => [])).filter((file) => file.endsWith(".json"));
  const byId = new Map();
  for (const file of files) {
    let detail;
    try {
      detail = JSON.parse(await readFile(new URL(file, matchesDir), "utf8"));
    } catch {
      continue; // unreadable/partial file, skip
    }
    for (const side of ["home", "away"]) {
      const team = detail[side];
      for (const member of [...(team?.lineup ?? []), ...(team?.bench ?? [])]) {
        if (member?.id == null || byId.has(member.id)) continue;
        byId.set(member.id, {
          id: member.id,
          name: member.name ?? "",
          team: team.name ?? "",
          position: bucketPosition(member.pos),
          crest: team.crest ?? null,
        });
      }
    }
  }
  return { list: [...byId.values()], complete: false };
}

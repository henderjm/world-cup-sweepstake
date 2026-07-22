// Bakes data/PL/players.json: the fantasy draftable player pool. Runs on a slower
// (daily) cadence than the live-data fetch, since squads barely change.
//
// Primary path: API-Football's /players/squads endpoint gives a complete
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

import { readFile, readdir, stat, writeFile } from "node:fs/promises";

import { COMPETITIONS } from "../src/competitions.js";
import { bucketPosition } from "../src/fantasy.js";
import { normalizeTeamName } from "../src/domain.js";
import { fetchApiFootball } from "./lib/apiFootball.mjs";

const token = process.env.API_FOOTBALL_KEY;
const competition = process.env.FANTASY_COMPETITION ?? "PL";
const season = process.env.API_FOOTBALL_SEASON ?? "2026";
const leagueId = COMPETITIONS[competition]?.apiFootballLeagueId;

const dataDir = new URL(`../data/${competition}/`, import.meta.url);
const matchesDir = new URL("matches/", dataDir);
const playersFile = new URL("players.json", dataDir);

if (!token) {
  console.log("API_FOOTBALL_KEY is not set; no player pool generated.");
  process.exit(0);
}
if (!Number.isInteger(leagueId)) throw new Error(`No API-Football league id configured for ${competition}`);

const refreshHours = Number(process.env.FANTASY_REFRESH_HOURS ?? 24);
const existing = await stat(playersFile).catch(() => null);
if (existing && Date.now() - existing.mtimeMs < refreshHours * 60 * 60 * 1000) {
  console.log(`${competition}/players.json is fresh; skipping squad refresh.`);
  process.exit(0);
}

const standings = await fetchApiFootball(`/standings?league=${leagueId}&season=${season}`).catch((error) => {
  console.warn(`could not load ${competition} standings for club ids: ${error.message}`);
  return { response: [] };
});

const clubs = [
  ...new Map(
    (standings.response ?? [])
      .flatMap((entry) => entry.league?.standings ?? [])
      .flatMap((table) => table ?? [])
      .map((row) => row.team)
      .filter((team) => team?.id)
      .map((team) => [team.id, team]),
  ).values(),
];

if (!clubs.length) {
  console.warn(`no ${competition} clubs found (standings empty or unavailable); nothing to fetch.`);
  process.exit(0);
}

const players = await fetchViaSquads(clubs);
const { list, complete } = players ?? (await fetchViaLineups());

const body = {
  source: complete ? "API-Football (squads)" : "API-Football (accumulated from lineups)",
  lastUpdated: new Date().toISOString(),
  complete,
  players: list,
};
await writeFile(playersFile, `${JSON.stringify(body, null, 2)}\n`);
console.log(`Wrote ${competition}/players.json (${list.length} players, complete=${complete}).`);

// Primary path: one call per club to /players/squads. Any single club failing marks
// the whole run as unavailable (rather than a competition's pool being some clubs'
// full squads and others' partial lineup-only players, which would be a confusing,
// silently-inconsistent mix) and falls through to the lineup-accumulation path.
async function fetchViaSquads(clubs) {
  const list = [];
  let payloads;
  try {
    payloads = await fetchApiFootball(clubs.map((club) => `/players/squads?team=${club.id}`));
  } catch (error) {
    console.warn(`squads endpoint unavailable (${error.message}); falling back to lineups`);
    return null;
  }
  for (const [index, payload] of payloads.entries()) {
    const club = clubs[index];
    const squad = payload.response?.[0];
    if (!squad?.team || !Array.isArray(squad.players)) return null;
    try {
      for (const member of squad.players) {
        if (member?.id == null) continue;
        list.push({
          id: member.id,
          name: member.name ?? "",
          team: normalizeTeamName(squad.team.name ?? club.name),
          position: bucketPosition(member.position),
          crest: squad.team.logo ?? club.logo ?? null,
        });
      }
    } catch (error) {
      console.warn(`squads endpoint unavailable (${club.name}: ${error.message}); falling back to lineups`);
      return null;
    }
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

// Squads refresh daily; incomplete squads fall back to the explicitly partial
// lineup pool. Historical data is independent and never makes the pool complete.

import { fileURLToPath } from "node:url";
import { exportStoredPlayerPool } from "./lib/stored-player-export.mjs";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

import { COMPETITIONS } from "../src/competitions.js";
import { bucketPosition } from "../src/fantasy.js";
import { decodeEntities } from "../src/mapApiFootball.js";
import { sortPlayerPool } from "../src/fantasyPlayerTier.js";
import { fetchFantasyHistory, squadPlayers } from "../services/scores/fantasy-data.mjs";
import { deriveTiersFromSeason, enrichPoolWithHistoricalXp } from "../src/fantasyHistoricalXp.js";
import { fetchApiFootball, isUnexpectedApiFootballFailure } from "./lib/apiFootball.mjs";

const token = process.env.API_FOOTBALL_KEY;
const competition = process.env.FANTASY_COMPETITION ?? "PL";
const season = process.env.API_FOOTBALL_SEASON ?? "2026";
const leagueId = COMPETITIONS[competition]?.apiFootballLeagueId;

const dataDir = new URL(`../data/${competition}/`, import.meta.url);
const matchesDir = new URL("matches/", dataDir);
const playersFile = new URL("players.json", dataDir);

if (process.env.SCORE_READ_ORIGIN) {
  console.log(await exportStoredPlayerPool({ origin: process.env.SCORE_READ_ORIGIN, competition, season, path: fileURLToPath(playersFile) }));
  process.exit(0);
}

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
  if (isUnexpectedApiFootballFailure(error)) throw error;
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

const historical = await fetchFantasyHistory({
  leagueId, season, unexpected: isUnexpectedApiFootballFailure,
  request: async path => {
    // Single-page validation requires separate CLI calls, so preserve its
    // between-request delay outside the CLI's per-process batch loop.
    await sleep(250);
    return fetchApiFootball(path);
  },
});

const tierResult = deriveTiersFromSeason(list, historical.perSeason[0] ?? null);
const xpResult = enrichPoolWithHistoricalXp(tierResult.players, historical.perSeason, historical.requestCount);

const body = {
  source: complete ? "API-Football (squads)" : "API-Football (accumulated from lineups)",
  lastUpdated: new Date().toISOString(),
  complete,
  priorSeasonStats: tierResult.header,
  xpStats: xpResult.header,
  players: sortPlayerPool(xpResult.players),
};
await writeFile(playersFile, `${JSON.stringify(body, null, 2)}\n`);
console.log(
  `Wrote ${competition}/players.json (${list.length} players, complete=${complete}, ` +
    `xp available=${xpResult.header.available}, history=${xpResult.header.basisCounts.history}, ` +
    `estimate=${xpResult.header.basisCounts.estimate}, none=${xpResult.header.basisCounts.none}).`,
);

// Primary path: one call per club to /players/squads. Any single club failing marks
// the whole run as unavailable (rather than a competition's pool being some clubs'
// full squads and others' partial lineup-only players, which would be a confusing,
// silently-inconsistent mix) and falls through to the lineup-accumulation path.
async function fetchViaSquads(clubs) {
  try {
    const payloads = await fetchApiFootball(clubs.map((club) => `/players/squads?team=${club.id}`));
    return { list: squadPlayers(payloads, clubs), complete: true };
  } catch (error) {
    if (isUnexpectedApiFootballFailure(error)) throw error;
    console.warn(`squads endpoint unavailable (${error.message}); falling back to lineups`);
    return null;
  }
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
          name: decodeEntities(member.name ?? ""),
          team: team.name ?? "",
          position: bucketPosition(member.pos),
          crest: team.crest ?? null,
        });
      }
    }
  }
  return { list: [...byId.values()], complete: false };
}

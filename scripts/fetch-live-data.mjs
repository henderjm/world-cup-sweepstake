import { mkdir, writeFile } from "node:fs/promises";

import { mapFootballDataMatches } from "../src/domain.js";

const token = process.env.FOOTBALL_DATA_TOKEN;
const competition = process.env.FOOTBALL_DATA_COMPETITION ?? "WC";
const season = process.env.FOOTBALL_DATA_SEASON ?? "2026";
const dataDir = new URL("../data/", import.meta.url);
const matchesDir = new URL("../data/matches/", import.meta.url);

if (!token) {
  console.log("FOOTBALL_DATA_TOKEN is not set; no live data generated.");
  process.exit(0);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const [matchesPayload, standingsPayload] = await Promise.all([
  fetchFootballData(`/v4/competitions/${competition}/matches?season=${season}`),
  fetchFootballData(`/v4/competitions/${competition}/standings`),
]);

await mkdir(dataDir, { recursive: true });
await writeFile(
  new URL("live.json", dataDir),
  `${JSON.stringify(
    {
      source: "football-data.org",
      lastUpdated: new Date().toISOString(),
      competition,
      season,
      matches: mapFootballDataMatches(matchesPayload),
      standings: standingsPayload.standings ?? [],
    },
    null,
    2,
  )}\n`,
);
console.log("Wrote live.json");

// Per-match detail (lineups, scorers, subs, cards) for matches that have it, or will
// soon: finished, in-play, or kicking off within the next 90 minutes (lineups post
// about an hour before). The client fetches one of these files only when a match is
// opened, so the main payload stays small.
const LIVE = new Set(["IN_PLAY", "PAUSED", "LIVE", "EXTRA_TIME", "PENALTY_SHOOTOUT", "BREAK"]);
const AROUND_KICKOFF_MS = 90 * 60 * 1000;
const now = Date.now();

const relevant = (matchesPayload.matches ?? []).filter((match) => {
  if (match.status === "FINISHED" || match.status === "AWARDED") return true;
  if (LIVE.has(match.status)) return true;
  if (match.status === "TIMED" || match.status === "SCHEDULED") {
    const delta = new Date(match.utcDate).getTime() - now;
    return delta <= AROUND_KICKOFF_MS && delta > -AROUND_KICKOFF_MS;
  }
  return false;
});

await mkdir(matchesDir, { recursive: true });
console.log(`Fetching detail for ${relevant.length} matches (throttled under 30/min)...`);
let written = 0;
for (const match of relevant) {
  try {
    const detail = await fetchFootballData(`/v4/matches/${match.id}`);
    await writeFile(new URL(`${match.id}.json`, matchesDir), `${JSON.stringify(mapDetail(detail))}\n`);
    written += 1;
  } catch (error) {
    console.warn(`detail ${match.id} failed: ${error.message}`);
  }
  await sleep(2200);
}
console.log(`Wrote ${written} match detail files.`);

function mapDetail(match) {
  return {
    id: match.id,
    status: match.status,
    utcDate: match.utcDate,
    stage: match.stage ?? null,
    group: match.group ?? null,
    venue: match.venue ?? null,
    attendance: match.attendance ?? null,
    minute: match.minute ?? null,
    score: {
      home: match.score?.fullTime?.home ?? null,
      away: match.score?.fullTime?.away ?? null,
      htHome: match.score?.halfTime?.home ?? null,
      htAway: match.score?.halfTime?.away ?? null,
    },
    home: mapTeam(match.homeTeam),
    away: mapTeam(match.awayTeam),
    goals: (match.goals ?? []).map((goal) => ({
      minute: goal.minute,
      injuryTime: goal.injuryTime ?? null,
      type: goal.type ?? "REGULAR",
      team: goal.team?.name ?? "",
      scorer: goal.scorer?.name ?? "",
      assist: goal.assist?.name ?? null,
      home: goal.score?.home ?? null,
      away: goal.score?.away ?? null,
    })),
    cards: (match.bookings ?? []).map((booking) => ({
      minute: booking.minute,
      team: booking.team?.name ?? "",
      player: booking.player?.name ?? "",
      card: booking.card ?? "",
    })),
    subs: (match.substitutions ?? []).map((sub) => ({
      minute: sub.minute,
      team: sub.team?.name ?? "",
      in: sub.playerIn?.name ?? "",
      out: sub.playerOut?.name ?? "",
    })),
    referee:
      (match.referees ?? []).find((ref) => ref.type === "REFEREE")?.name ??
      (match.referees ?? [])[0]?.name ??
      null,
  };
}

function mapTeam(team) {
  return {
    name: team?.name ?? "",
    formation: team?.formation ?? null,
    coach: team?.coach?.name ?? null,
    lineup: (team?.lineup ?? []).map(mapPlayer),
    bench: (team?.bench ?? []).map(mapPlayer),
  };
}

function mapPlayer(player) {
  return { name: player?.name ?? "", pos: player?.position ?? null, num: player?.shirtNumber ?? null };
}

async function fetchFootballData(path) {
  const response = await fetch(`https://api.football-data.org${path}`, {
    headers: { "X-Auth-Token": token },
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
  }

  return response.json();
}

import { mkdir, writeFile } from "node:fs/promises";

import { mapFootballDataMatches } from "../src/domain.js";

const token = process.env.FOOTBALL_DATA_TOKEN;
const competition = process.env.FOOTBALL_DATA_COMPETITION ?? "WC";
const season = process.env.FOOTBALL_DATA_SEASON ?? "2026";
const outputPath = new URL("../data/live.json", import.meta.url);

if (!token) {
  console.log("FOOTBALL_DATA_TOKEN is not set; no live data generated.");
  process.exit(0);
}

const [matchesPayload, standingsPayload] = await Promise.all([
  fetchFootballData(`/v4/competitions/${competition}/matches?season=${season}`),
  fetchFootballData(`/v4/competitions/${competition}/standings`),
]);

await mkdir(new URL("../data/", import.meta.url), { recursive: true });
await writeFile(
  outputPath,
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

console.log(`Wrote ${outputPath.pathname}`);

async function fetchFootballData(path) {
  const response = await fetch(`https://api.football-data.org${path}`, {
    headers: { "X-Auth-Token": token },
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
  }

  return response.json();
}

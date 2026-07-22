import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";

import { mapFootballDataMatches } from "../src/domain.js";
import { mapMatchDetail } from "../src/mapDetail.js";
import { aggregateScorers } from "../src/scorers.js";
import { fetchFootballData as fetchFromApi, sleep } from "./lib/footballData.mjs";

const token = process.env.FOOTBALL_DATA_TOKEN;

// Competitions to bake, as CODE:season pairs ("PL:2026,CL:2026"). The first is the
// default competition and is also written to the legacy unnamespaced data/ paths so
// cached clients keep working through a deploy. Season is football-data's starting
// year: 2026 = the 2026-27 season. Falls back to the old singular vars.
const competitions = (
  process.env.FOOTBALL_DATA_COMPETITIONS ??
  `${process.env.FOOTBALL_DATA_COMPETITION ?? "PL"}:${process.env.FOOTBALL_DATA_SEASON ?? "2026"}`
)
  .split(",")
  .map((pair) => {
    const [code, season] = pair.split(":").map((part) => part?.trim());
    return { code: (code ?? "").toUpperCase(), season: season || "2026" };
  })
  .filter((comp) => /^[A-Z0-9]{2,6}$/.test(comp.code));

const rootDir = new URL("../data/", import.meta.url);

if (!token) {
  console.log("FOOTBALL_DATA_TOKEN is not set; no live data generated.");
  process.exit(0);
}
if (!competitions.length) {
  console.error("No valid competitions configured.");
  process.exit(1);
}

// Spacing between detail fetches. football-data's free tier allows ~10 requests/minute,
// so ~6.5s keeps us just under it; fetchFootballData's own retry is the safety net for
// the per-competition standings/matches calls or a busier window tipping us over.
const DETAIL_THROTTLE_MS = 6500;

const LIVE = new Set(["IN_PLAY", "PAUSED", "LIVE", "EXTRA_TIME", "PENALTY_SHOOTOUT", "BREAK"]);
const FINAL = new Set(["FINISHED", "AWARDED"]);
const AROUND_KICKOFF_MS = 90 * 60 * 1000;

// One competition failing (e.g. a cup whose new season football-data has not opened
// yet: every call 4xxs) must not kill the bake for the others. Its previously baked
// files simply stay as they are.
for (const comp of competitions) {
  try {
    await bakeCompetition(comp, comp === competitions[0]);
  } catch (error) {
    console.warn(`${comp.code}: bake failed, keeping previous data (${error.message.slice(0, 120)})`);
  }
}

async function bakeCompetition({ code, season }, isDefault) {
  const dataDir = new URL(`${code}/`, rootDir);
  const matchesDir = new URL("matches/", dataDir);
  console.log(`== ${code} (season ${season}) ==`);

  // Both calls pin the season: an unpinned /standings returns football-data's "current
  // season", which between seasons is still last year's final table and silently
  // disagrees with the season-pinned fixtures. Standings are optional: a cup before
  // its league phase has fixtures but no table yet (upstream 404s), and that must not
  // fail the bake for every competition.
  const [matchesPayload, standingsPayload] = await Promise.all([
    fetchFromApi(`/v4/competitions/${code}/matches?season=${season}`, token),
    fetchFromApi(`/v4/competitions/${code}/standings?season=${season}`, token).catch((error) => {
      console.warn(`${code} standings unavailable (${error.message.split(":")[0]}); baking without a table`);
      return { standings: [] };
    }),
  ]);

  await mkdir(dataDir, { recursive: true });
  const liveBody = `${JSON.stringify(
    {
      source: "football-data.org",
      lastUpdated: new Date().toISOString(),
      competition: code,
      season,
      matches: mapFootballDataMatches(matchesPayload),
      standings: standingsPayload.standings ?? [],
    },
    null,
    2,
  )}\n`;
  await writeFile(new URL("live.json", dataDir), liveBody);
  if (isDefault) await writeFile(new URL("live.json", rootDir), liveBody);
  console.log(`Wrote ${code}/live.json`);

  // Per-match detail (lineups, scorers, subs, cards) for matches that have it, or will
  // soon: finished, in-play, or kicking off within the next 90 minutes (lineups post
  // about an hour before). The client fetches one of these files only when a match is
  // opened, so the main payload stays small.
  const now = Date.now();
  await mkdir(matchesDir, { recursive: true });

  // Which matches do we already hold *final* detail for? A finished match's detail
  // never changes, so once we have it we never re-fetch: the request budget goes to
  // the matches that still need it, and no match is starved out of the scorer tally.
  const finalOnDisk = new Set();
  for (const file of await readdir(matchesDir).catch(() => [])) {
    if (!file.endsWith(".json")) continue;
    try {
      const stored = JSON.parse(await readFile(new URL(file, matchesDir), "utf8"));
      if (FINAL.has(stored.status)) finalOnDisk.add(String(stored.id));
    } catch {
      // Unreadable/partial file: leave it out so it gets re-fetched.
    }
  }

  const relevant = (matchesPayload.matches ?? []).filter((match) => {
    if (FINAL.has(match.status)) return !finalOnDisk.has(String(match.id));
    if (LIVE.has(match.status)) return true;
    if (match.status === "TIMED" || match.status === "SCHEDULED") {
      const delta = new Date(match.utcDate).getTime() - now;
      return delta <= AROUND_KICKOFF_MS && delta > -AROUND_KICKOFF_MS;
    }
    return false;
  });
  console.log(`Fetching detail for ${relevant.length} ${code} matches (throttled under 10/min)...`);
  let written = 0;
  for (const match of relevant) {
    try {
      const detail = await fetchFromApi(`/v4/matches/${match.id}`, token);
      await writeFile(new URL(`${match.id}.json`, matchesDir), `${JSON.stringify(mapMatchDetail(detail))}\n`);
      written += 1;
    } catch (error) {
      console.warn(`detail ${match.id} failed: ${error.message}`);
    }
    await sleep(DETAIL_THROTTLE_MS);
  }
  console.log(`Wrote ${written} match detail files.`);

  // Golden Boot aggregate. Tally from every detail file in this competition's dir (not
  // just the matches refreshed this run) so the board covers the whole season, then
  // bake a small scorers.json next to live.json. Reuses detail already fetched.
  const detailFiles = (await readdir(matchesDir)).filter((file) => file.endsWith(".json"));
  const details = [];
  for (const file of detailFiles) {
    try {
      details.push(JSON.parse(await readFile(new URL(file, matchesDir), "utf8")));
    } catch (error) {
      console.warn(`scorers: skipping ${file}: ${error.message}`);
    }
  }
  const scorers = aggregateScorers(details);
  const scorersBody = `${JSON.stringify(
    { source: "football-data.org", lastUpdated: new Date().toISOString(), scorers },
    null,
    2,
  )}\n`;
  await writeFile(new URL("scorers.json", dataDir), scorersBody);
  if (isDefault) await writeFile(new URL("scorers.json", rootDir), scorersBody);
  console.log(`Wrote ${code}/scorers.json (${scorers.length} scorers).`);
}

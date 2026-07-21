import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";

import { mapFootballDataMatches } from "../src/domain.js";
import { mapMatchDetail } from "../src/mapDetail.js";
import { aggregateScorers } from "../src/scorers.js";

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Spacing between detail fetches and the retry ceiling for a 429. football-data's free
// tier allows ~10 requests/minute, so ~6.5s keeps us just under it; the retry is the
// safety net for the per-competition standings/matches calls or a busier window
// tipping us over.
const DETAIL_THROTTLE_MS = 6500;
const MAX_RATELIMIT_RETRIES = 4;

const LIVE = new Set(["IN_PLAY", "PAUSED", "LIVE", "EXTRA_TIME", "PENALTY_SHOOTOUT", "BREAK"]);
const FINAL = new Set(["FINISHED", "AWARDED"]);
const AROUND_KICKOFF_MS = 90 * 60 * 1000;

for (const comp of competitions) {
  await bakeCompetition(comp, comp === competitions[0]);
}

async function bakeCompetition({ code, season }, isDefault) {
  const dataDir = new URL(`${code}/`, rootDir);
  const matchesDir = new URL("matches/", dataDir);
  console.log(`== ${code} (season ${season}) ==`);

  // Both calls pin the season: an unpinned /standings returns football-data's "current
  // season", which between seasons is still last year's final table and silently
  // disagrees with the season-pinned fixtures.
  const [matchesPayload, standingsPayload] = await Promise.all([
    fetchFootballData(`/v4/competitions/${code}/matches?season=${season}`),
    fetchFootballData(`/v4/competitions/${code}/standings?season=${season}`),
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
      const detail = await fetchFootballData(`/v4/matches/${match.id}`);
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

async function fetchFootballData(path, attempt = 0) {
  const response = await fetch(`https://api.football-data.org${path}`, {
    headers: { "X-Auth-Token": token },
  });

  // Rate limited. football-data caps requests per minute (10/min on the free tier)
  // and tells us how long to wait. Honour it and retry rather than dropping the
  // match: a dropped detail file is a match missing from the Golden Boot tally. The
  // wait paces the whole loop to the real limit, so a run fetches all its matches.
  if (response.status === 429 && attempt < MAX_RATELIMIT_RETRIES) {
    const waitMs = retryAfterMs(response, await response.text());
    console.log(`rate limited on ${path}; waiting ${Math.round(waitMs / 1000)}s then retrying`);
    await sleep(waitMs);
    return fetchFootballData(path, attempt + 1);
  }

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
  }

  return response.json();
}

// How long to wait before retrying a 429, from the Retry-After header if present, else
// the "Wait N seconds" the body carries, else a full one-minute window. Padded by a
// second so we resume just after the window resets rather than on its edge.
function retryAfterMs(response, body) {
  const header = Number(response.headers.get("Retry-After"));
  if (Number.isFinite(header) && header > 0) return (header + 1) * 1000;
  const match = /wait\s+(\d+)\s*second/i.exec(body ?? "");
  if (match) return (Number(match[1]) + 1) * 1000;
  return 61_000;
}

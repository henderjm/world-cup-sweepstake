import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { createStoredScoreReader } from "../../worker/stored-scores.js";
import { createStoredDetailReader } from "../../worker/stored-detail.js";
import { aggregateScorers } from "../../src/scorers.js";
import { isLive } from "../../src/format.js";

async function previous(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT" || error instanceof SyntaxError) return null; throw error; }
}
async function save(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify(value) + "\n", { flag: "wx" }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}
const played = match => isLive(match.status) || ["FINISHED", "AWARDED"].includes(match.status);

export async function exportStoredScores({ competitions, origin, rootDir, fetcher, now = Date.now, log = console.log }) {
  const readScores = createStoredScoreReader({ fetcher, now });
  const readDetail = createStoredDetailReader({ fetcher, now });
  const results = [];
  for (const comp of competitions) {
    if (!["PL", "CL"].includes(comp.code) || !/^\d{4}$/.test(String(comp.season))) throw Error("Invalid export competition");
    const dataDir = join(rootDir, comp.code), matchesDir = join(dataDir, "matches");
    try {
      const feed = await readScores(comp, origin);
      if (feed.stale) throw Error("Stored score observations are stale");
      const old = await previous(join(dataDir, "live.json"));
      if (old?.competition === comp.code && old.season === String(comp.season)
        && (Date.parse(old.lastUpdated) > Date.parse(feed.lastUpdated)
          || (old.source === "stored-score-service" && (old.snapshot?.version > feed.snapshot.version
            || old.snapshot?.collectorEpoch > feed.snapshot.collectorEpoch)))) throw Error("Export would regress stored scores");
      await mkdir(matchesDir, { recursive: true });
      await save(join(dataDir, "live.json"), feed);
      if (comp === competitions[0]) await save(join(rootDir, "live.json"), feed);
      const relevant = feed.matches.filter(match => played(match)
        || (["TIMED", "SCHEDULED"].includes(match.status) && Math.abs(Date.parse(match.utcDate) - now()) <= 90 * 60000));
      const details = [], missing = [], times = [];
      let index = 0, written = 0;
      await Promise.all(Array.from({ length: Math.min(4, relevant.length) }, async () => {
        while (index < relevant.length) {
          const match = relevant[index++];
          // Four workers stay below the reader's ten-request/second ceiling.
          await pause(1000);
          try {
            const detail = await readDetail(comp, match.id, origin);
            const path = join(matchesDir, `${match.id}.json`), oldDetail = await previous(path);
            if (oldDetail?.source === "stored-score-service" && oldDetail.competition === comp.code && oldDetail.season === String(comp.season)
              && ["version", "collectorEpoch", "detailVersion", "detailCollectorEpoch"].some(key =>
                (oldDetail.snapshot?.[key] ?? 0) > (detail.snapshot?.[key] ?? 0))) throw Error("Export would regress detail");
            await save(path, detail); written++;
            if (played(match)) {
              if (detail.coverage.events.state !== "complete" || detail.degraded.includes("/fixtures/events")
                || detail.stale || detail.status !== match.status || detail.score.home !== match.score.home || detail.score.away !== match.score.away)
                missing.push(match.id);
              else { details.push(detail); times.push(detail.coverage.events.observedAt); }
            }
          } catch (error) {
            if (played(match)) missing.push(match.id);
            log(`${comp.code} detail ${match.id}: retaining previous file (${error.message})`);
          }
        }
      }));
      if (!missing.length) {
        const scorers = { source: "stored-score-service", competition: comp.code, season: String(comp.season),
          lastUpdated: times.length ? new Date(Math.min(...times)).toISOString() : feed.lastUpdated,
          snapshotVersion: feed.snapshot.version, scorers: aggregateScorers(details) };
        await save(join(dataDir, "scorers.json"), scorers);
        if (comp === competitions[0]) await save(join(rootDir, "scorers.json"), scorers);
      }
      const result = { competition: comp.code, matches: feed.matches.length, details: written, missingScorerMatches: missing.sort((a, b) => a - b) };
      results.push(result); log(JSON.stringify(result));
    } catch (error) {
      results.push({ competition: comp.code, error: error.message });
      log(`${comp.code}: export failed (${error.message}); files not replaced retain their previous timestamps`);
    }
  }
  return results;
}

import { createServer } from "node:http";
import { mapApiFootballMatches } from "../../src/mapApiFootball.js";
import { scoreFeed } from "../../services/scores/snapshots.mjs";

let now = Date.parse("2026-10-13T19:30:00Z"), mode = "failure", version = 1, reads = 0, forbiddenCalls = 0;
Date.now = () => now;
const { default: worker } = await import("../../worker/worker.js");
globalThis.fetch = async url => {
  if (String(url) !== "https://stored-score-fixture.invalid/CL/live") {
    forbiddenCalls++;
    throw Error("Unexpected network request in stored-reader replay");
  }
  reads++;
  if (mode === "failure" || mode === "stale") return new Response("unavailable", { status: 503 });
  const matches = mode === "empty" ? [] : mapApiFootballMatches({ response: [{
    fixture: { id: 900001, date: "2026-10-13T19:00:00Z", status: { short: "2H", elapsed: 60 } },
    league: { id: 2, season: 2026, round: "League Stage - 2" },
    teams: { home: { id: 42, name: "Arsenal" }, away: { id: 541, name: "Real Madrid" } },
    goals: { home: mode === "correction" ? 0 : 1, away: 0 },
  }] });
  return Response.json(scoreFeed({ competition: "CL", season: "2026", version, collectorEpoch: 1,
    publishedAt: now, scheduleObservedAt: now, fixtures: matches.map(match => ({ match, observedAt: now })),
    standings: { rows: [], observedAt: null, delayed: true } }, now));
};
const server = createServer(async (req, res) => {
  try {
    const control = new URL(req.url, "http://localhost").pathname.match(/^\/control\/(failure|empty|initial|stale|correction|state)$/)?.[1];
    if (control) {
      if (control !== "state") { mode = control; version++; now += control === "stale" ? 60000 : 1000; }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ now, mode, reads, forbiddenCalls })); return;
    }
    const response = await worker.fetch(new Request("https://worker-fixture.invalid" + req.url,
      { headers: { Origin: "https://kickoffdraft.com" } }),
    { API_FOOTBALL_KEY: "fixture-only", API_FOOTBALL_COMPETITIONS: "CL:2026", SCORE_READ_ORIGIN: "https://stored-score-fixture.invalid" }, { waitUntil() {} });
    res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(await response.text());
  } catch (error) { res.writeHead(500); res.end(error.message); }
});
server.listen(8743, "127.0.0.1", () => console.log("Stored-reader Worker replay listening on 8743"));
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { server.closeAllConnections(); server.close(); });

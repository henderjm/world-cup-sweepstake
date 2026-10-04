import { createServer } from "node:http";
import { mapApiFootballMatches } from "../../src/mapApiFootball.js";
import { scoreFeed } from "../../services/scores/snapshots.mjs";
import { storedMatchDetail } from "../../services/scores/detail-read.mjs";
import { detailPublication, detailSubject } from "../../services/scores/details.mjs";

let now = Date.parse("2026-10-13T19:30:00Z"), mode = "failure", version = 1, reads = 0, forbiddenCalls = 0;
Date.now = () => now;
const { default: worker } = await import("../../worker/worker.js");
function snapshot() {
  const fixture = { fixture: { id: 900001, date: "2026-10-13T19:00:00Z", referee: "Test Referee", status: { short: "2H", elapsed: 60 } },
    league: { id: 2, season: 2026, round: "League Stage - 2" },
    teams: { home: { id: 42, name: "Arsenal" }, away: { id: 541, name: "Real Madrid" } },
    goals: { home: mode === "correction" ? 0 : 1, away: 0 } };
  const match = mapApiFootballMatches({ response: [fixture] })[0];
  return { fixture, match, data: { competition: "CL", season: "2026", version, collectorEpoch: 1,
    publishedAt: now, scheduleObservedAt: now, fixtures: [{ match, observedAt: now }],
    standings: { rows: [], observedAt: null, delayed: true } } };
}
globalThis.fetch = async url => {
  if (!["https://stored-detail-fixture.invalid/CL/live", "https://stored-detail-fixture.invalid/CL/match/900001"].includes(String(url))) {
    forbiddenCalls++; throw Error("Unexpected provider call");
  }
  reads++;
  const { data, fixture, match } = snapshot();
  if (String(url).endsWith("/live")) return Response.json(scoreFeed(data, now));
  if (mode === "failure" || mode === "stale") return new Response("unavailable", { status: 503 });
  let manifest = null; const payloads = {};
  if (mode !== "empty") {
    const lineups = [42, 541].map(id => ({ team: { id }, startXI: Array.from({ length: 11 }, (_, n) =>
      ({ player: { id: id * 100 + n, name: `Player ${id}-${n}`, number: n + 1, pos: n ? "DF" : "GK" } })), substitutes: [] }));
    const rows = { fixture: [fixture], lineups,
      events: match.score.home ? [{ time: { elapsed: 12 }, team: { id: 42 }, type: "Goal", detail: "Normal Goal", player: { id: 4201, name: "Stored Scorer" } }] : [],
      players: lineups.map(row => ({ team: row.team, players: row.startXI.map(entry => ({ player: entry.player,
        statistics: [{ games: { minutes: 60, position: "D" }, tackles: { total: 0, blocks: 0, interceptions: 0 } }] })) })) };
    for (const [section, response] of Object.entries(rows)) {
      payloads[section] = { response };
      manifest = detailPublication(manifest, { competition: "CL", season: "2026", id: 900001, section, observedAt: now,
        subject: detailSubject(match), coverage: "complete", payload: payloads[section], baseVersion: manifest?.version ?? 0 }, { epoch: 1 }, now).manifest;
    }
    manifest.version = version * 4;
  }
  return Response.json(storedMatchDetail(data, data.fixtures[0], manifest ? { ...manifest, payloads } : null, now));
};
const server = createServer(async (req, res) => {
  try {
    const modeChange = new URL(req.url, "http://localhost").pathname.match(/^\/control\/(failure|empty|initial|stale|correction|state)$/)?.[1];
    if (modeChange) {
      if (modeChange !== "state") { mode = modeChange; version++; now += mode === "stale" ? 60000 : 1000; }
      res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ now, mode, reads, forbiddenCalls })); return;
    }
    const result = await worker.fetch(new Request("https://worker-fixture.invalid" + req.url, { headers: { Origin: "https://kickoffdraft.com" } }),
      { API_FOOTBALL_KEY: "synthetic", API_FOOTBALL_COMPETITIONS: "CL:2026", SCORE_READ_ORIGIN: "https://stored-detail-fixture.invalid" }, { waitUntil() {} });
    res.writeHead(result.status, Object.fromEntries(result.headers)); res.end(await result.text());
  } catch (error) { res.writeHead(500); res.end(error.message); }
});
server.listen(8743, "127.0.0.1", () => console.log("Stored detail replay on 8743"));
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { server.closeAllConnections(); server.close(); });

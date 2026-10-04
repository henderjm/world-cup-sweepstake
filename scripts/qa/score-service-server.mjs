// Local replay publisher and stored-data API; no provider credentials or calls.
import { createServer } from "node:http";
import { ScoreReplayStore } from "../../test/helpers/scoreReplayStore.mjs";
import { createScoreReadApi } from "../../services/scores/snapshots.mjs";

const start = Date.parse("2026-10-13T19:30:00Z");
let now = start, store = new ScoreReplayStore(), lease, publications = 0;
function publish(score, empty = false, mixed = false) {
  lease = store.claim("replay-collector", now);
  const previous = store.read("CL", "2026");
  store.publish(lease, { competition: "CL", season: "2026", baseVersion: previous?.version ?? 0,
    scheduleObservedAt: now,
    fixtures: empty ? [] : [{ observedAt: now, providerUpdatedAt: null, match: {
      id: 900001, utcDate: "2026-10-13T19:00:00Z", homeTeam: "Home", awayTeam: "Away",
      status: "IN_PLAY", stage: "LEAGUE_STAGE", minute: 30, score: { home: score, away: 0 },
    } }, ...(mixed ? [{ observedAt: now - 120000, providerUpdatedAt: null, match: {
      id: 900002, utcDate: "2026-10-13T19:00:00Z", homeTeam: "Other Home", awayTeam: "Other Away",
      status: "IN_PLAY", stage: "LEAGUE_STAGE", score: { home: 0, away: 0 },
    } }] : [])],
  }, now);
  publications++;
}
const api = createScoreReadApi({ readSnapshot: (code, season) => store.read(code, season), seasons: { CL: "2026" }, now: () => now });
createServer(async (req, res) => {
  try {
    if (req.url === "/reset") { now = start; store = new ScoreReplayStore(); publications = 0; }
    else if (req.url === "/empty") publish(0, true);
    else if (req.url === "/initial") publish(1);
    else if (req.url === "/stall") now += 60000;
    else if (req.url === "/recover") { now += 1000; publish(2); }
    else if (req.url === "/mixed-age") { now += 1000; publish(3, false, true); }
    else if (req.url === "/state") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ now, publications })); return;
    } else {
      const response = await api(new Request(`http://127.0.0.1:8743${req.url}`, { method: req.method }));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(await response.text()); return;
    }
    res.end("ready");
  } catch { res.writeHead(500); res.end("replay failure"); }
}).listen(8743, "127.0.0.1", () => console.log("Stored score replay listening on 8743"));

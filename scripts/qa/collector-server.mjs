import { createServer } from "node:http";
import { once } from "node:events";
import { ScoreCollector } from "../../services/scores/collector.mjs";
import { ScoreProvider } from "../../services/scores/provider.mjs";
import { DynamoScoreStore } from "../../services/scores/dynamodb.mjs";
import { createReadHandler } from "../../services/scores/read-handler.mjs";
import { client, createTable, deleteTable } from "../../services/scores/test/support.mjs";

const start = Date.parse("2026-10-13T19:30:00Z"), db = client();
let now = start, tableName, store, collector, score = null, failed = false, calls = 0, publications = 0;
const source = createServer((req, res) => {
  calls++;
  if (failed) { res.writeHead(503); res.end("unavailable"); return; }
  const response = score == null ? [] : [{
    fixture: { id: 900001, date: "2026-10-13T19:00:00Z", status: { short: "2H", elapsed: 60 } },
    league: { id: 2, season: 2026, round: "League Stage - 2" },
    teams: { home: { name: "Arsenal" }, away: { name: "Real Madrid" } }, goals: { home: score, away: 0 },
  }];
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ errors: [], results: response.length, paging: { current: 1, total: 1 }, response }));
});
source.listen(0, "127.0.0.1"); await once(source, "listening");
async function reset() {
  if (tableName) await deleteTable(db, tableName);
  tableName = await createTable(db);
  now = start - 61000; score = null; failed = false; calls = 0; publications = 0;
  store = new DynamoScoreStore({ client: db, tableName, now: () => now });
  await store.initializeBudget(await store.claim("bootstrap"), { dailyLimit: 100, minuteLimit: 300, scoreReserve: 20 }, 0);
  now = start;
  const provider = new ScoreProvider({ store, apiKey: "localtest", now: () => now,
    fetch: (url, options) => fetch(new URL(url.pathname + url.search, `http://127.0.0.1:${source.address().port}`), options) });
  collector = new ScoreCollector({ store, provider, seasons: { CL: 2026 }, now: () => now });
}
await reset();
const api = createReadHandler({ store: { read: (code, season) => store.read(code, season) }, seasons: { CL: 2026 }, now: () => now });
const server = createServer(async (req, res) => {
  try {
    if (req.url === "/reset") await reset();
    else if (["/empty", "/initial", "/stall", "/recover"].includes(req.url)) {
      if (req.url === "/initial") { now += 15 * 60000; score = 1; }
      if (req.url === "/stall") { now += 60000; failed = true; }
      if (req.url === "/recover") { now += 31000; failed = false; score = 2; }
      const event = await collector.step();
      if (event.state === "published") publications++;
      else if (!(req.url === "/stall" && event.state === "failed")) throw Error(`Unexpected collector state: ${event.state}`);
    } else if (req.url !== "/state") {
      const response = await api({ version: "2.0", rawPath: new URL(req.url, "http://localhost").pathname,
        requestContext: { http: { method: req.method } } });
      res.writeHead(response.statusCode, response.headers); res.end(response.body); return;
    }
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ now, calls, publications }));
  } catch (error) { res.writeHead(500); res.end(error.message); }
});
server.listen(8743, "127.0.0.1", () => console.log("Database-backed collector QA listening on 8743"));
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, async () => {
  server.closeAllConnections(); source.closeAllConnections(); server.close(); source.close();
  try { await deleteTable(db, tableName); } finally { db.destroy(); }
});

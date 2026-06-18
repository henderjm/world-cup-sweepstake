// Goon Squad data API (Cloudflare Worker).
//
// Proxies football-data.org so the static site can poll for live data many times a
// minute without a deploy. The API token lives here as a Worker secret and never
// reaches the browser. Upstream calls are edge-cached briefly, so a crowd of pollers
// collapses into roughly one upstream call per cache window, staying well under the
// 30 calls/minute plan limit.
//
// Endpoints:
//   GET /live        -> { source, lastUpdated, matches, standings }  (same shape as data/live.json)
//   GET /match/:id   -> compact match detail (lineups, scorers, subs, cards)
//
// Reuses the site's own mapping modules so shapes never drift.

import { mapFootballDataMatches } from "../src/domain.js";
import { mapMatchDetail } from "../src/mapDetail.js";

const API = "https://api.football-data.org";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (request.method !== "GET") return json({ error: "method not allowed" }, 405);

    const token = env.FOOTBALL_DATA_TOKEN;
    if (!token) return json({ error: "FOOTBALL_DATA_TOKEN secret is not set" }, 500);
    const competition = env.FOOTBALL_DATA_COMPETITION || "WC";
    const season = env.FOOTBALL_DATA_SEASON || "2026";

    try {
      if (url.pathname === "/live") {
        const [matches, standings] = await Promise.all([
          fdFetch(`/v4/competitions/${competition}/matches?season=${season}`, token, 20),
          fdFetch(`/v4/competitions/${competition}/standings`, token, 30),
        ]);
        return json(
          {
            source: "football-data.org",
            lastUpdated: new Date().toISOString(),
            competition,
            season,
            matches: mapFootballDataMatches(matches),
            standings: standings.standings ?? [],
          },
          200,
          { "Cache-Control": "public, max-age=15" },
        );
      }

      const detailRoute = url.pathname.match(/^\/match\/(\d+)$/);
      if (detailRoute) {
        const detail = await fdFetch(`/v4/matches/${detailRoute[1]}`, token, 25);
        return json(mapMatchDetail(detail), 200, { "Cache-Control": "public, max-age=25" });
      }

      if (url.pathname === "/" || url.pathname === "/health") {
        return json({ ok: true, service: "goon-squad-data", endpoints: ["/live", "/match/:id"] });
      }
      return json({ error: "not found" }, 404);
    } catch (error) {
      return json({ error: String((error && error.message) || error) }, 502);
    }
  },
};

async function fdFetch(path, token, cacheTtl) {
  const response = await fetch(`${API}${path}`, {
    headers: { "X-Auth-Token": token },
    cf: { cacheTtl, cacheEverything: true },
  });
  if (!response.ok) throw new Error(`football-data ${response.status} for ${path}`);
  return response.json();
}

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS, ...extra },
  });
}

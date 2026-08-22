// Feeds live match detail into the Worker's KV safety copy from an egress IP
// api-sports does not throttle.
//
// Why this exists: api-sports both hard-refuses (429/rateLimit) and
// soft-throttles (200-with-empty for fixtures that HAVE data) the shared
// Cloudflare Workers egress IPs. Measured conclusively on GW1 2026-27: the
// same key, in the same second, returned full lineups to a residential IP and
// results:0 to the Worker. GitHub Actions' IPs are trusted (the hourly Pages
// bake proves it every day), so this script runs there on a five-minute cron
// (.github/workflows/live-detail-feeder.yml), fetches the detail payloads for
// every match that matters right now, and POSTs them to the Worker's
// bearer-gated /ingest/detail/:id, which maps and stores them through the
// same substance-guarded KV path the drawer already serves from.
//
// Which matches matter: anything in play, anything within LINEUP_LEAD_MS of
// kickoff (teams are published about an hour before), and anything finished
// within FULL_TIME_TAIL_MS (full-time reads and late settling). The list of
// candidates comes from the Worker's own public /:comp/live feed, which costs
// no upstream call here.
//
// Missing secrets exit 0 with a note rather than failing the workflow: the
// feeder is an optional layer, and a red run every five minutes on a repo
// without the token configured would be alarm fatigue, not information.

const WORKER_ORIGIN = process.env.WORKER_ORIGIN ?? "https://goon-squad-data.gs-wc.workers.dev";
const API = "https://v3.football.api-sports.io";
const KEY = process.env.API_FOOTBALL_KEY;
const TOKEN = process.env.DETAIL_INGEST_TOKEN;
const COMPETITIONS = (process.env.API_FOOTBALL_COMPETITIONS ?? "PL:2026")
  .split(",")
  .map((pair) => pair.split(":")[0].trim())
  .filter(Boolean);

const LINEUP_LEAD_MS = 70 * 60 * 1000;
const FULL_TIME_TAIL_MS = 3 * 60 * 60 * 1000;
const PACING_MS = 400;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function worthFeeding(match, now) {
  const kickoff = Date.parse(match.utcDate);
  if (!Number.isFinite(kickoff)) return false;
  if (match.status === "IN_PLAY" || match.status === "PAUSED") return true;
  if (match.status === "TIMED" || match.status === "SCHEDULED") {
    return kickoff - now <= LINEUP_LEAD_MS && kickoff - now > 0;
  }
  if (match.status === "FINISHED") return now - kickoff <= FULL_TIME_TAIL_MS;
  return false;
}

async function apiGet(path) {
  const response = await fetch(`${API}${path}`, { headers: { "x-apisports-key": KEY } });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  const payload = await response.json();
  const errors = payload?.errors;
  const hasErrors = Array.isArray(errors) ? errors.length : errors && Object.keys(errors).length;
  if (hasErrors) throw new Error(`${path}: ${JSON.stringify(errors)}`);
  return payload;
}

async function feedMatch(id) {
  const fixture = await apiGet(`/fixtures?id=${id}`);
  await sleep(PACING_MS);
  const lineups = await apiGet(`/fixtures/lineups?fixture=${id}`);
  await sleep(PACING_MS);
  const events = await apiGet(`/fixtures/events?fixture=${id}`);
  await sleep(PACING_MS);
  const players = await apiGet(`/fixtures/players?fixture=${id}`);
  const response = await fetch(`${WORKER_ORIGIN}/ingest/detail/${id}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fixture, lineups, events, players }),
  });
  const result = await response.json().catch(() => ({}));
  console.log(`match ${id}: ingest ${response.status} ${JSON.stringify(result)}`);
  if (!response.ok && response.status !== 200) throw new Error(`ingest ${id}: HTTP ${response.status}`);
}

async function main() {
  if (!KEY || !TOKEN) {
    console.log("feeder: API_FOOTBALL_KEY or DETAIL_INGEST_TOKEN not configured; nothing to do");
    return;
  }
  const now = Date.now();
  let fed = 0;
  for (const code of COMPETITIONS) {
    let live;
    try {
      const response = await fetch(`${WORKER_ORIGIN}/${encodeURIComponent(code)}/live`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      live = await response.json();
    } catch (error) {
      console.log(`feeder: could not read ${code} live feed (${error.message}); skipping`);
      continue;
    }
    const candidates = (live.matches ?? []).filter((match) => worthFeeding(match, now));
    console.log(`${code}: ${candidates.length} match(es) worth feeding`);
    for (const match of candidates) {
      try {
        await feedMatch(match.id);
        fed += 1;
      } catch (error) {
        // One broken match must not block the others; the next run retries.
        console.log(`match ${match.id}: ${error.message}`);
      }
      await sleep(PACING_MS);
    }
  }
  console.log(`feeder: done, ${fed} match(es) fed`);
}

await main();

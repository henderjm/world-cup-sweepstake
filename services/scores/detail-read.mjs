import { mapApiFootballMatchDetail, mapApiFootballMatchDetailFromSummary } from "../../src/mapApiFootball.js";
import { isLive } from "../../src/format.js";
import { detailCoverage, detailSubject, validateDetailManifest } from "./details.mjs";

const empty = { response: [] };
const family = name => name === "fixture" ? "/fixtures" : `/fixtures/${name}`;

export function storedMatchDetail(snapshot, row, stored, now) {
  const match = row.match;
  const { payloads = {}, ...manifest } = stored ?? {};
  if (stored) validateDetailManifest(manifest, snapshot.competition, snapshot.season, match.id, stored.version);
  const detail = payloads.fixture ? mapApiFootballMatchDetail(payloads.fixture, payloads.lineups ?? empty,
    payloads.events ?? empty, payloads.players ?? empty) : mapApiFootballMatchDetailFromSummary(match, empty, empty, empty);
  const coverage = detailCoverage(stored, match, now);
  for (const name of Object.keys(coverage)) {
    if (!payloads[name]) coverage[name] = { ...coverage[name], state: "missing" };
  }
  // Header refreshes and supplementary refreshes have independent observation
  // clocks. Reading a newer score must not make an older timeline look current.
  for (const name of ["fixture", "events", "players"]) {
    if (coverage[name].state === "complete" && stored.sections[name].subject !== detailSubject(match))
      coverage[name].state = "outdated-result";
  }
  for (const key of ["id", "status", "providerStatus", "utcDate", "stage", "group", "matchday", "venue", "city", "mapUrl", "minute"])
    detail[key] = match[key] ?? null;
  Object.assign(detail.score, { home: match.score?.home ?? null, away: match.score?.away ?? null,
    penHome: match.penalties?.home ?? null, penAway: match.penalties?.away ?? null });
  Object.assign(detail.home, { name: match.homeTeam, crest: match.homeCrest ?? detail.home.crest });
  Object.assign(detail.away, { name: match.awayTeam, crest: match.awayCrest ?? detail.away.crest });

  const statistics = new Map((payloads.players?.response ?? []).flatMap(team => team.players.map(entry =>
    [entry.player.id, entry.statistics[0]])));
  const participants = [...detail.home.lineup, ...detail.away.lineup].map(player => player.id);
  for (const substitution of detail.subs) participants.push(substitution.inId, substitution.outId);
  if (coverage.players.state === "complete" && participants.some(id =>
    id == null || !Number.isInteger(statistics.get(id)?.games?.minutes))) coverage.players.state = "partial";
  for (const player of detail.playerStats) {
    const raw = statistics.get(player.playerId);
    Object.assign(player, { minutes: raw?.games?.minutes ?? null, tackles: raw?.tackles?.total ?? null,
      blocks: raw?.tackles?.blocks ?? null, interceptions: raw?.tackles?.interceptions ?? null });
    if (player.minutes > 0 && [player.position, player.tackles, player.blocks, player.interceptions].some(value => value == null)
      && coverage.players.state === "complete") coverage.players.state = "partial";
  }
  const active = isLive(match.status) || (["TIMED", "SCHEDULED"].includes(match.status) && Date.parse(match.utcDate) <= now);
  const ageMs = Math.max(0, now - row.observedAt);
  const stale = row.observedAt > now || ageMs > (active ? 45000 : 6 * 3600000);
  const degraded = Object.entries(coverage).filter(([, section]) => section.state !== "complete").map(([name]) => family(name));
  if (stale && !degraded.includes("/fixtures")) degraded.push("/fixtures");
  return { ...detail, source: "stored-score-service", competition: snapshot.competition, season: snapshot.season,
    degraded, coverage, stale, staleAgeMs: ageMs, lastUpdated: new Date(row.observedAt).toISOString(),
    snapshot: { version: snapshot.version, collectorEpoch: snapshot.collectorEpoch, observedAt: row.observedAt,
      detailVersion: stored?.version ?? null, detailCollectorEpoch: stored?.collectorEpoch ?? null } };
}

export function createDetailReadApi({ store, seasons, now = Date.now }) {
  const headers = { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" };
  const json = (body, status = 200) => Response.json(body, { status, headers });
  return async request => {
    const route = new URL(request.url).pathname.match(/^\/(PL|CL)\/match\/([1-9]\d{0,14})$/);
    const code = route?.[1], id = Number(route?.[2]);
    if (!code || !seasons[code] || !Number.isSafeInteger(id)) return json({ error: "not found" }, 404);
    if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
    try {
      const season = String(seasons[code]), snapshot = await store.read(code, season);
      if (!snapshot) return json({ error: "scores not collected yet" }, 503);
      if (snapshot.competition !== code || snapshot.season !== season) throw Error("Stored identity mismatch");
      const row = snapshot.fixtures.find(row => row.match.id === id);
      if (!row) return json({ error: "unknown fixture" }, 404);
      const detail = await store.readDetail(code, season, id);
      return json(storedMatchDetail(snapshot, row, detail, now()));
    } catch { return json({ error: "stored match detail unavailable" }, 503); }
  };
}

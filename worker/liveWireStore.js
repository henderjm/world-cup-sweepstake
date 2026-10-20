// The Wire's storage, cron pass and read route. src/liveWire.js decides what
// happened; this persists it to D1 (`live_wire_items`, see schema.sql) and asks
// the model for a line under the moments that earn one.
//
// Everything the Worker owns is injected (the live feed, the match detail, the
// Anthropic client), so this file has no opinion about where scores come from:
// in stored mode they are the AWS read API, which is the only mode production
// runs, and the pass then costs no API-Football calls at all.
//
// Costs, bounded on purpose:
// - D1: one SELECT per watched match per tick, one batch only when something
//   changed. A quiet minute in a live match writes nothing.
// - Model: at most WIRE_AI_PER_TICK calls a tick, WIRE_AI_DAILY_CAP a day, each
//   a one-line structured reply from a small model. A call is claimed with a
//   guarded UPDATE first, so two overlapping cron ticks can never both pay for
//   the same line.

import {
  WIRE_AI_DAILY_CAP,
  WIRE_KINDS,
  reconcileWire,
  sortWireItems,
  wireAiEligible,
  wireItemsForMatch,
  wireMatchDay,
  wireTable,
  wireWatching,
} from "../src/liveWire.js";
import {
  WIRE_PROMPT_VERSION,
  WIRE_SCHEMA,
  WIRE_SYSTEM_PROMPT,
  buildWirePrompt,
  wireLineAcceptable,
} from "../src/liveWirePrompt.js";
import { isLive } from "../src/format.js";

export const WIRE_DEFAULT_MODEL = "claude-haiku-5-5";
export const WIRE_AI_PER_TICK = 6;
// A pending line older than this is news nobody needs any more: it is expired
// rather than written late, so a model outage cannot dump a backlog of stale
// "GOAL!" colour onto the timeline when it recovers.
export const WIRE_AI_MAX_AGE_MS = 10 * 60 * 1000;
export const WIRE_RETENTION_DAYS = 3;
const WIRE_READ_LIMIT = 300;

const iso = (ms) => new Date(ms).toISOString();

function parseFacts(row) {
  try {
    return JSON.parse(row.facts);
  } catch {
    return null;
  }
}

// One cron tick. `competitions` are the parsed "CODE:season" entries; getLive
// and fetchDetail are the Worker's own readers. Returns a small summary for
// logging and tests.
export async function runLiveWirePass({
  db,
  competitions,
  getLive,
  fetchDetail,
  isDetailTrusted,
  createClient = null,
  model = WIRE_DEFAULT_MODEL,
  now = Date.now(),
  log = console,
}) {
  const summary = { watched: 0, inserted: 0, updated: 0, retired: 0, ai: 0 };
  if (!db) return summary;

  const feeds = [];
  for (const comp of competitions) {
    try {
      const live = await getLive(comp);
      feeds.push({ comp, live, table: wireTable(live, comp.code) });
    } catch {
      // one competition down must not silence the other's commentary
    }
  }
  const allLive = feeds.flatMap(({ live }) => live.matches ?? []);
  const context = new Map(); // matchId -> { match, items }

  for (const { comp, live, table } of feeds) {
    for (const match of (live.matches ?? []).filter(item => wireWatching(item, now))) {
      summary.watched += 1;
      try {
        const changed = await syncMatch({ db, comp, match, table, fetchDetail, isDetailTrusted, now, context });
        summary.inserted += changed.inserted;
        summary.updated += changed.updated;
        summary.retired += changed.retired;
      } catch (error) {
        log.error?.(`wire: match ${match.id} failed: ${error?.message ?? error}`);
      }
    }
  }

  await db.prepare("DELETE FROM live_wire_items WHERE match_day < ?")
    .bind(iso(now - WIRE_RETENTION_DAYS * 86_400_000).slice(0, 10)).run();

  if (createClient) {
    summary.ai = await writeAiLines({ db, createClient, model, now, context, allLive, log });
  }
  return summary;
}

async function syncMatch({ db, comp, match, table, fetchDetail, isDetailTrusted, now, context }) {
  let detail = null;
  try {
    detail = await fetchDetail(match, comp);
  } catch {
    // Kick-off, half-time and full-time need no detail, so a failed read still
    // moves the timeline; it just cannot add or rule out goals this tick.
  }
  const detailTrusted = Boolean(detail) && isDetailTrusted(detail);
  const day = wireMatchDay(match);
  const rows = (await db.prepare("SELECT id, item_key, facts FROM live_wire_items WHERE match_id = ?")
    .bind(match.id).all()).results ?? [];
  const stored = rows.map(row => {
    const facts = parseFacts(row);
    return facts ? { ...facts, key: row.item_key, rowId: row.id } : null;
  }).filter(Boolean);

  // Goals the events have not confirmed yet would be dropped by the ordinal
  // rule anyway; with an untrusted read, only the status-derived items move.
  const current = wireItemsForMatch({ competition: comp.code, match, detail: detailTrusted ? detail : null, table })
    .filter(item => detailTrusted || [WIRE_KINDS.KICKOFF, WIRE_KINDS.HALF_TIME, WIRE_KINDS.FULL_TIME].includes(item.kind));
  const { inserts, updates, retire } = reconcileWire({
    stored: stored.filter(item => !item.overturned), current, match, detail, detailTrusted,
  });

  const watchedLive = stored.some(item => item.kind !== WIRE_KINDS.FULL_TIME);
  const stamp = iso(now);
  const statements = [];
  const storedByKey = new Map(stored.map(item => [item.key, item]));

  for (const key of retire) {
    const original = storedByKey.get(key);
    const renamed = `${key}#${original.rowId}`;
    statements.push(db.prepare("UPDATE live_wire_items SET item_key = ?, facts = ?, updated_at = ? WHERE id = ?")
      .bind(renamed, JSON.stringify({ ...original, key: renamed, rowId: undefined, overturned: true }), stamp, original.rowId));
  }
  for (const item of inserts) {
    // An overturned item's key carries the ruled-out row's id, so the same
    // ordinal being ruled out twice in one match is two items, not one.
    const key = item.kind === WIRE_KINDS.OVERTURNED
      ? `${item.key}#${storedByKey.get(item.key.slice(2))?.rowId ?? "0"}` : item.key;
    const eligible = wireAiEligible(item, match, { watchedLive });
    statements.push(db.prepare(`INSERT OR IGNORE INTO live_wire_items
        (item_key, match_id, competition, match_day, kind, facts, ai_state, ai_version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(key, match.id, comp.code, day, item.kind, JSON.stringify({ ...item, key }),
        eligible ? "pending" : null, eligible ? WIRE_PROMPT_VERSION : null, stamp, stamp));
  }
  for (const item of updates) {
    statements.push(db.prepare("UPDATE live_wire_items SET facts = ?, updated_at = ? WHERE id = ?")
      .bind(JSON.stringify({ ...item, rowId: undefined }), stamp, item.rowId));
  }
  if (statements.length) await db.batch(statements);

  context.set(match.id, {
    match,
    items: sortWireItems([...stored.filter(item => !retire.includes(item.key)), ...inserts]).reverse(),
  });
  return { inserted: inserts.length, updated: updates.length, retired: retire.length };
}

async function writeAiLines({ db, createClient, model, now, context, allLive, log }) {
  const cutoff = iso(now - WIRE_AI_MAX_AGE_MS);
  await db.prepare("UPDATE live_wire_items SET ai_state = 'expired', updated_at = ? WHERE ai_state IN ('pending', 'sending') AND created_at < ?")
    .bind(iso(now), cutoff).run();

  const day = iso(now).slice(0, 10);
  const spent = await db.prepare("SELECT COUNT(*) AS n FROM live_wire_items WHERE match_day >= ? AND ai_state IN ('sending', 'done', 'rejected', 'failed')")
    .bind(iso(now - 86_400_000).slice(0, 10)).first();
  const budget = Math.min(WIRE_AI_PER_TICK, WIRE_AI_DAILY_CAP - Number(spent?.n ?? 0));
  if (budget <= 0) return 0;

  const pending = (await db.prepare("SELECT id, match_id, facts FROM live_wire_items WHERE ai_state = 'pending' AND created_at >= ? ORDER BY id LIMIT ?")
    .bind(cutoff, budget).all()).results ?? [];
  if (!pending.length) return 0;

  const client = createClient();
  let written = 0;
  await Promise.all(pending.map(async row => {
    // The claim: only one tick may move a row from pending to sending.
    const claim = await db.prepare("UPDATE live_wire_items SET ai_state = 'sending' WHERE id = ? AND ai_state = 'pending'")
      .bind(row.id).run();
    if (!claim.meta?.changes) return;
    const item = parseFacts(row);
    const entry = context.get(row.match_id);
    let state = "failed";
    let line = null;
    try {
      if (!item || !entry) throw Error("match no longer watched");
      const payload = buildWirePrompt({
        item,
        match: entry.match,
        recent: entry.items.filter(other => other.key !== item.key && Date.parse(other.at) <= Date.parse(item.at)),
        elsewhere: allLive.filter(other => other.id !== entry.match.id && isLive(other.status)),
      });
      const response = await client.messages.create({
        model,
        max_tokens: 2000,
        output_config: { effort: "low", format: { type: "json_schema", schema: WIRE_SCHEMA } },
        system: WIRE_SYSTEM_PROMPT,
        messages: [{ role: "user", content: payload }],
      });
      if (response.stop_reason === "refusal") throw Error("refused");
      const text = response.content.find(block => block.type === "text")?.text ?? "";
      line = wireLineAcceptable(JSON.parse(text).line, payload);
      state = line ? "done" : "rejected";
      log.log?.(`wire: line ${state} for ${item.key} (in ${response.usage?.input_tokens ?? "?"}, out ${response.usage?.output_tokens ?? "?"})`);
    } catch (error) {
      log.error?.(`wire: line failed for row ${row.id}: ${error?.message ?? error}`);
    }
    await db.prepare("UPDATE live_wire_items SET ai_state = ?, ai_line = ?, updated_at = ? WHERE id = ?")
      .bind(state, line, iso(now), row.id).run();
    if (line) written += 1;
  }));
  return written;
}

// GET /wire?day=YYYY-MM-DD[&since=<cursor>]. Public: it is match commentary.
// The first read returns the newest WIRE_READ_LIMIT items; later polls pass the
// returned cursor and get only rows inserted or changed since (`>=`, so a row
// written in the same millisecond as the cursor is resent rather than missed;
// the client dedupes on key).
export async function handleLiveWire(request, env, cors, json, now = Date.now()) {
  if (!env.DB) return json({ error: "wire not configured" }, 501, cors);
  const url = new URL(request.url);
  const day = url.searchParams.get("day") ?? iso(now).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return json({ error: "bad day" }, 400, cors);
  const since = url.searchParams.get("since");
  if (since != null && !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(since)) return json({ error: "bad cursor" }, 400, cors);

  let rows;
  try {
    rows = since
      ? (await env.DB.prepare(`SELECT id, facts, ai_line, ai_state, created_at, updated_at FROM live_wire_items
          WHERE match_day = ? AND updated_at >= ? ORDER BY updated_at LIMIT ?`).bind(day, since, WIRE_READ_LIMIT).all()).results
      : (await env.DB.prepare(`SELECT id, facts, ai_line, ai_state, created_at, updated_at FROM live_wire_items
          WHERE match_day = ? ORDER BY id DESC LIMIT ?`).bind(day, WIRE_READ_LIMIT).all()).results;
  } catch (error) {
    // The table not existing yet (migration not applied) reads as an empty
    // wire, so the panel simply stays hidden instead of erroring.
    if (/no such table/i.test(String(error?.message))) return json({ day, items: [], cursor: since }, 200, cors);
    throw error;
  }
  const items = (rows ?? []).map(wireItemForClient).filter(Boolean);
  const cursor = (rows ?? []).reduce((max, row) => (row.updated_at > max ? row.updated_at : max), since ?? "");
  return json({ day, items, cursor: cursor || null }, 200, { ...cors, "Cache-Control": "public, max-age=10" });
}

export function wireItemForClient(row) {
  const facts = parseFacts(row);
  if (!facts) return null;
  return {
    ...facts,
    rowId: row.id,
    receivedAt: row.created_at,
    ai: row.ai_state === "done" ? row.ai_line : null,
    aiPending: row.ai_state === "pending" || row.ai_state === "sending",
  };
}

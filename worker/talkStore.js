// Talk (per-match banter) storage: posting with rate limits, reports and
// moderator actions, and the moderated read. Every visibility decision is
// src/talkModeration.js's viewOfMessage; this module only feeds it rows.
//
// Moderation tables arrive with worker/migrations/013-talk-moderation.sql.
// Until they exist banter keeps working exactly as before, unmoderated,
// rather than erroring on every read.

import { POST_REFUSALS, d1Instant, postDecision, viewOfMessage } from "../src/talkModeration.js";

export const MAX_BANTER_MESSAGES_PER_MATCH = 500;
export const TALK_ACTIONS = ["report", "hide", "unhide", "mute", "unmute"];

let talkTablesKnown = false;
export async function talkModerationReady(env) {
  if (talkTablesKnown) return true;
  try {
    await env.DB.prepare("SELECT 1 FROM talk_moderators LIMIT 1").first();
    await env.DB.prepare("SELECT 1 FROM banter_reports LIMIT 1").first();
    talkTablesKnown = true;
  } catch {
    // not migrated yet; asked again next request
  }
  return talkTablesKnown;
}

export function resetTalkTablesKnown() {
  talkTablesKnown = false;
}

export async function isTalkModerator(env, userId) {
  if (userId == null) return false;
  return Boolean(await env.DB.prepare("SELECT 1 AS ok FROM talk_moderators WHERE user_id = ?1").bind(userId).first());
}

// A message post or a moderation action. Returns {} on success, else
// { status, error, reason? } for the route to send.
export async function talkAction(env, matchId, user, body, cleanText) {
  const moderated = await talkModerationReady(env);
  if (body.action === "message") {
    const text = cleanText(body.text);
    if (!text) return { status: 400, error: "empty message" };
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM banter_messages WHERE match_id = ?1").bind(matchId).first();
    if ((count?.n ?? 0) >= MAX_BANTER_MESSAGES_PER_MATCH) return { status: 400, error: "banter is full for this match" };
    if (moderated) {
      const [last, mine] = await Promise.all([
        env.DB.prepare("SELECT created_at FROM banter_messages WHERE user_id = ?1 ORDER BY id DESC LIMIT 1").bind(user.id).first(),
        env.DB.prepare("SELECT COUNT(*) AS n FROM banter_messages WHERE match_id = ?1 AND user_id = ?2").bind(matchId, user.id).first(),
      ]);
      const decision = postDecision({ lastPostAt: d1Instant(last?.created_at), postsInMatch: mine?.n ?? 0 });
      if (POST_REFUSALS[decision]) return { status: 429, error: POST_REFUSALS[decision], reason: decision };
    }
    await env.DB.prepare("INSERT INTO banter_messages (match_id, user_id, text) VALUES (?1, ?2, ?3)").bind(matchId, user.id, text).run();
    return {};
  }

  if (!moderated) return { status: 501, error: "moderation not configured" };
  // The target is always a message on THIS match: ids are global, so an
  // unscoped id would let a report or a mute reach any comment anywhere.
  const target = await env.DB.prepare("SELECT id, user_id FROM banter_messages WHERE id = ?1 AND match_id = ?2")
    .bind(Number(body.messageId), matchId)
    .first();
  if (!target) return { status: 404, error: "unknown message" };
  if (body.action === "report") {
    if (target.user_id === user.id) return { status: 400, error: "cannot report your own comment" };
    await env.DB.prepare("INSERT OR IGNORE INTO banter_reports (message_id, reporter_user_id) VALUES (?1, ?2)").bind(target.id, user.id).run();
    return {};
  }
  if (!(await isTalkModerator(env, user.id))) return { status: 403, error: "moderators only" };
  const statements = {
    hide: ["INSERT OR IGNORE INTO talk_hidden (message_id, hidden_by_user_id) VALUES (?1, ?2)", target.id, user.id],
    unhide: ["DELETE FROM talk_hidden WHERE message_id = ?1", target.id],
    mute: ["INSERT OR IGNORE INTO talk_mutes (user_id, muted_by_user_id) VALUES (?1, ?2)", target.user_id, user.id],
    unmute: ["DELETE FROM talk_mutes WHERE user_id = ?1", target.user_id],
  };
  const [sql, ...args] = statements[body.action];
  await env.DB.prepare(sql).bind(...args).run();
  console.log(`talk moderation: ${body.action} message ${target.id} on match ${matchId}`);
  return {};
}

export async function readBanter(env, id, userId) {
  const moderated = await talkModerationReady(env);
  const messageSql = moderated
    ? `SELECT m.id, m.user_id, m.text, m.created_at, u.name, u.email,
         (SELECT COUNT(*) FROM banter_reports r WHERE r.message_id = m.id) AS reports,
         EXISTS (SELECT 1 FROM banter_reports r JOIN talk_moderators t ON t.user_id = r.reporter_user_id WHERE r.message_id = m.id) AS mod_reported,
         EXISTS (SELECT 1 FROM banter_reports r WHERE r.message_id = m.id AND r.reporter_user_id = ?2) AS reported_by_me,
         EXISTS (SELECT 1 FROM talk_hidden h WHERE h.message_id = m.id) AS hidden,
         EXISTS (SELECT 1 FROM talk_mutes x WHERE x.user_id = m.user_id) AS author_muted
       FROM banter_messages m JOIN users u ON u.id = m.user_id
       WHERE m.match_id = ?1 ORDER BY m.id DESC LIMIT 80`
    : `SELECT m.id, m.user_id, m.text, m.created_at, u.name, u.email FROM banter_messages m
       JOIN users u ON u.id = m.user_id
       WHERE m.match_id = ?1 ORDER BY m.id DESC LIMIT 50`;
  const [counts, mine, msgs, moderator] = await Promise.all([
    env.DB.prepare("SELECT emoji, COUNT(*) AS n FROM banter_reactions WHERE match_id = ?1 GROUP BY emoji").bind(id).all(),
    userId
      ? env.DB.prepare("SELECT emoji FROM banter_reactions WHERE match_id = ?1 AND user_id = ?2").bind(id, userId).all()
      : Promise.resolve({ results: [] }),
    (moderated ? env.DB.prepare(messageSql).bind(id, userId ?? 0) : env.DB.prepare(messageSql).bind(id)).all(),
    moderated ? isTalkModerator(env, userId) : Promise.resolve(false),
  ]);

  const countMap = {};
  (counts.results ?? []).forEach((row) => {
    countMap[row.emoji] = row.n;
  });
  // A comment a viewer may not see never leaves the Worker, so hiding
  // cannot be undone by reading the response.
  const messages = [];
  for (const row of (msgs.results ?? []).reverse()) {
    const view = viewOfMessage({
      userId: row.user_id,
      reports: row.reports ?? 0,
      moderatorReported: Boolean(row.mod_reported),
      hiddenAt: row.hidden ? "hidden" : null,
      authorMuted: Boolean(row.author_muted),
    }, { viewerId: userId, moderator });
    if (!view) continue;
    messages.push({
      id: row.id,
      name: row.name || String(row.email ?? "").split("@")[0] || "Someone",
      text: row.text,
      ts: row.created_at,
      mine: userId != null && row.user_id === userId,
      reported: Boolean(row.reported_by_me),
      state: view.state,
      ...(moderator ? { reports: row.reports ?? 0 } : {}),
    });
  }
  return {
    reactions: { counts: countMap, mine: (mine.results ?? []).map((row) => row.emoji) },
    messages: messages.slice(-50),
    signedIn: Boolean(userId),
    moderation: moderated,
    moderator,
  };
}

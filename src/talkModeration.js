// Talk (per-match banter) moderation rules, pure and shared by the Worker
// and the browser (docs/v2-prd.md section 7.3). Talk has to be safe before
// it is public, and every rule here errs towards hiding:
//
// - Anyone signed in can report a comment, once. Two reports, or one report
//   from a moderator, hide it from everyone but its author, pending review.
// - A moderator can hide a comment outright, or mute its author. A muted
//   account still sees its own posts as normal and nobody else sees them,
//   so muting does not invite a new account.
// - Posting is rate limited per account: one post per 10 seconds anywhere,
//   and 60 posts per match.
// - A moderator sees everything, labelled, so a review is possible at all.
//
// Moderators are user ids in the talk_moderators table (D1), set by hand;
// nothing in the client can make an account a moderator.

export const HIDE_AFTER_REPORTS = 2;
export const POST_INTERVAL_MS = 10_000;
export const POSTS_PER_MATCH = 60;

// Who sees a comment and how it is labelled for them.
// Returns null when the viewer must not see it, else { state } where state is
// "visible", "pending" (hidden pending review), "removed" (hidden by a
// moderator) or "muted" (the author is muted). The author sees their own
// "muted" comments as plain "visible": being muted is never announced to them.
export function viewOfMessage(message, { viewerId = null, moderator = false } = {}) {
  const own = viewerId != null && message.userId === viewerId;
  const state = message.hiddenAt ? "removed"
    : message.authorMuted ? "muted"
      : (message.reports >= HIDE_AFTER_REPORTS || message.moderatorReported) ? "pending"
        : "visible";
  if (moderator) return { state };
  if (state === "visible") return { state };
  if (!own) return null;
  return { state: state === "muted" ? "visible" : state };
}

// "ok", or why a post is refused right now.
export function postDecision({ lastPostAt = null, postsInMatch = 0, muted = false }, now = Date.now()) {
  if (postsInMatch >= POSTS_PER_MATCH) return "match-cap";
  const last = Date.parse(lastPostAt ?? "");
  if (Number.isFinite(last) && now - last < POST_INTERVAL_MS) return "too-fast";
  return muted ? "ok-muted" : "ok";
}

export const POST_REFUSALS = {
  "too-fast": "Slow down a moment: one comment every 10 seconds.",
  "match-cap": "You have reached 60 comments on this match.",
};

// D1 stores datetime('now') as "YYYY-MM-DD HH:MM:SS" in UTC with no zone.
export function d1Instant(value) {
  if (!value) return null;
  const iso = String(value).includes("T") ? String(value) : `${String(value).replace(" ", "T")}Z`;
  return Number.isFinite(Date.parse(iso)) ? iso : null;
}

// Which of a match's target fans (if any) a Wire line shouts out. Pure, so the
// rule is testable without D1.
//
// `fans` are the match's targets, picked once when its brief was built:
// [{ userId, name, team }], already shuffled. `item` is the wire moment
// ({ kind, team } where team is the side that scored or was carded), `match`
// gives homeTeam/awayTeam, `banter` is what the targets said in this match's
// chat ([{ user_id, text, created_at }], oldest first). Return one target or
// null; the caller attaches that fan's own messages for the follow-up.

import { WIRE_KINDS } from "./liveWire.js";

// A plain name-drop (no chat to follow up on) is used this often, so a busy
// evening does not name somebody under every goal. A fan who has posted is
// always worth it: that line is a follow-up, not a name-drop.
export const NAME_DROP_RATE = 0.35;

// The side whose fan has the better story: the side that just conceded, lost
// a goal to VAR, had a man sent off, or lost the match. Null means either.
export function storySide(item, match) {
  const other = (team) => team === match?.homeTeam ? match?.awayTeam : team === match?.awayTeam ? match?.homeTeam : null;
  switch (item?.kind) {
    case WIRE_KINDS.GOAL:
      return other(item.team);
    case WIRE_KINDS.OVERTURNED:
    case WIRE_KINDS.CARD:
      return item.team ?? null;
    case WIRE_KINDS.FULL_TIME: {
      const home = Number(item.score?.home ?? match?.score?.home);
      const away = Number(item.score?.away ?? match?.score?.away);
      if (!Number.isFinite(home) || !Number.isFinite(away) || home === away) return null;
      return home < away ? match?.homeTeam : match?.awayTeam;
    }
    default:
      return undefined; // not a moment that names anyone
  }
}

export function pickShoutout(fans, item, match, banter = [], random = Math.random) {
  if (!Array.isArray(fans) || !fans.length || !item) return null;
  const side = storySide(item, match);
  if (side === undefined) return null;

  const posted = new Set((banter ?? []).map(row => row.user_id));
  const onSide = (fan) => side == null || fan.team === side;
  // Fans with something to follow up on first: story side, then either side.
  const withChat = fans.find(fan => posted.has(fan.userId) && onSide(fan))
    ?? fans.find(fan => posted.has(fan.userId));
  if (withChat) return withChat;
  if (random() >= NAME_DROP_RATE) return null;
  return fans.find(onSide) ?? null;
}

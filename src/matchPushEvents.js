import { isLive } from "./format.js";

// Pure diff behind the minute cron's match pushes: given the previous and
// current notify_state signatures, which pushes are due. Every goal-related
// push shares the `goals` pref, and sendMatchEvents tags by pref, so a
// "Goal ruled out" push REPLACES the stale goal alert on the device instead
// of stacking a second notification under it.
export function diffMatchEvents(prev, cur, match, lastRed, detailMinute, { stale = false } = {}) {
  const events = [];
  const score = `${cur.home ?? 0}-${cur.away ?? 0}`;
  const fixture = `${match.homeTeam} v ${match.awayTeam}`;
  const scoreline = `${match.homeTeam} ${score} ${match.awayTeam}`;
  const minute = detailMinute ?? match.minute;

  if (!isLive(prev.status) && isLive(cur.status)) {
    events.push({ pref: "kickoff", title: `Kick-off: ${fixture}`, body: "They're off." });
  }
  // A score going DOWN is VAR taking a goal back. A stale feed can also read
  // lower than the last tick, so only a fresh read may announce it.
  if (!stale && goalRuledOut(prev, cur)) {
    events.push({ pref: "goals", title: `Goal ruled out: ${scoreline}`, body: minute ? `${minute}'` : "VAR." });
  }
  if ((cur.home ?? 0) > (prev.home ?? 0) || (cur.away ?? 0) > (prev.away ?? 0)) {
    events.push({ pref: "goals", title: `⚽ ${scoreline}`, body: minute ? `${minute}'` : "Goal!" });
  }
  if ((cur.reds ?? 0) > (prev.reds ?? 0)) {
    events.push({
      pref: "red",
      title: `🟥 Red card in ${fixture}`,
      body: lastRed ? `${lastRed.player} (${lastRed.team}) is off.` : "Down to ten.",
    });
  }
  if (cur.status === "FINISHED" && prev.status !== "FINISHED") {
    events.push({ pref: "fulltime", title: `FT: ${scoreline}`, body: "Full time." });
  }
  return events;
}

function goalRuledOut(prev, cur) {
  // A missing score is an unreadable feed, not a goal taken back.
  if ([prev.home, prev.away, cur.home, cur.away].some((n) => !Number.isInteger(n))) return false;
  return cur.home < prev.home || cur.away < prev.away;
}

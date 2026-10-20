// The Wire: one live commentary timeline across every match being played.
//
// Pure module shared by the Worker (which diffs and stores the timeline in D1
// from its minute cron) and the browser (which renders it). No fetch, no DOM,
// no Anthropic client: the Worker owns the model call, src/liveWirePrompt.js
// owns what it says, and this owns WHAT HAPPENED.
//
// Three rules shape everything here, and each one is there because the obvious
// version gets a live commentary wrong in public:
//
// 1. Every item has a STABLE KEY derived from the event, never from array
//    position, so the cron can re-derive the whole match every tick and insert
//    only what is new. Goals are keyed by the scoring side's ordinal (its 1st,
//    2nd... goal) rather than by scorer and minute: providers routinely correct
//    a scorer, an assist or a minute after the fact, and a key built from those
//    would turn every correction into a second "GOAL!" for the same goal. An
//    ordinal survives a correction (the facts are rewritten under the same key,
//    see reconcileWire) and is retired when a goal is ruled out, which frees the
//    slot for the next real goal.
//
// 2. A goal is only believed when the SCORE agrees. The detail's events and the
//    fixture's score arrive by different paths and can briefly disagree; the
//    mapped goals list can also carry penalty-shootout kicks (they arrive as
//    "Goal / Penalty" events and the mapper does not read the comment that marks
//    them). So a side's nth goal is emitted only once the summary score for that
//    side has reached n, and is declared OVERTURNED only when both signals have
//    dropped below n. Either signal alone is a blip; both together is VAR.
//
// 3. Wording is produced at READ time (describeWireItem), from stored facts,
//    exactly like the league feed's describeChatEvent: a copy change never leaves
//    old rows speaking an older dialect. The AI line is the only stored prose,
//    and it is decoration over facts this module already states, never the only
//    place a fact lives.

import { isFinished, isLive } from "./format.js";
import { canonicalizeStandingsOrder, mapStandings, normalizeTeamName } from "./domain.js";
import { applyLiveResults } from "./liveTable.js";
import { competitionFor, zoneFor } from "./competitions.js";

export const WIRE_KINDS = Object.freeze({
  KICKOFF: "kickoff",
  GOAL: "goal",
  CARD: "card",
  SUB: "sub",
  HALF_TIME: "halftime",
  FULL_TIME: "fulltime",
  OVERTURNED: "overturned",
});

// Moments worth a Claude line. Yellows, subs, kick-off and half-time are real
// commentary but are told perfectly well by the template, and they are most of
// any evening's events: spending a model call on each would multiply the cost
// for prose nobody needs.
const BIG_KINDS = new Set([WIRE_KINDS.GOAL, WIRE_KINDS.OVERTURNED, WIRE_KINDS.FULL_TIME]);

// An event this many match minutes behind the clock when the cron first sees it
// is history, not news: it is stored (so the timeline is complete) but never
// sent to the model, so a deploy mid-evening or a recovered outage backfills
// quietly instead of bursting a dozen stale "GOAL!" lines and their cost.
export const WIRE_FRESH_MINUTES = 6;

// The per-day cap on model calls. A Champions League night is eighteen matches
// and roughly fifty goals, reds and full-times; the cap sits well above that so
// it only ever bites on something pathological (a feed replaying a whole day as
// new), where silently falling back to templates is exactly right.
export const WIRE_AI_DAILY_CAP = 250;

// How long after kick-off a match stays on the wire's watch list. Covers extra
// time, a shootout and a provider that is slow to post full time.
export const WIRE_MATCH_WINDOW_MS = 4 * 60 * 60 * 1000;

const KIND_ORDER = {
  kickoff: 0, goal: 2, overturned: 3, card: 4, sub: 5, halftime: 6, fulltime: 7,
};

// The UTC day a match belongs to on the wire, from its kickoff. One day per
// match, so a 23:00 UTC kickoff in extra time does not split across two days.
export function wireMatchDay(match) {
  const kickoff = Date.parse(match?.utcDate ?? "");
  return Number.isFinite(kickoff) ? new Date(kickoff).toISOString().slice(0, 10) : null;
}

// Whether the cron should be watching this match right now.
export function wireWatching(match, now = Date.now()) {
  if (isLive(match?.status)) return true;
  if (!isFinished(match?.status)) return false;
  const kickoff = Date.parse(match?.utcDate ?? "");
  return Number.isFinite(kickoff) && now - kickoff >= 0 && now - kickoff < WIRE_MATCH_WINDOW_MS;
}

// An estimated wall-clock instant for a match minute, used ONLY to interleave
// several matches on one timeline. The 15 minutes of half-time and the break
// before extra time are added so a 46th-minute goal sorts after a different
// match's 45+3; it is an ordering key, never shown as a time.
export function eventInstant(kickoffIso, minute, injury = 0) {
  const kickoff = Date.parse(kickoffIso ?? "");
  if (!Number.isFinite(kickoff)) return null;
  const m = Number(minute) || 0;
  const breaks = (m > 45 ? 15 : 0) + (m > 90 ? 5 : 0);
  return new Date(kickoff + (m + breaks + (Number(injury) || 0)) * 60_000).toISOString();
}

function sideOf(match, team) {
  const name = normalizeTeamName(team);
  if (name === match.homeTeam) return "home";
  if (name === match.awayTeam) return "away";
  return null;
}

function base(competition, match, kind, key, extra = {}) {
  return {
    key,
    matchId: match.id,
    competition,
    kind,
    homeTeam: match.homeTeam,
    awayTeam: match.awayTeam,
    ...extra,
  };
}

function scoreOf(match) {
  const home = Number(match?.score?.home);
  const away = Number(match?.score?.away);
  return Number.isFinite(home) && Number.isFinite(away) ? { home, away } : null;
}

// Goals the score backs up, in match order, each with the running score after
// it and its story tags. Exported for tests.
export function confirmedGoals(match, detail) {
  const score = scoreOf(match);
  if (!score) return [];
  const goals = [...(detail?.goals ?? [])]
    .map((goal, index) => ({ goal, index }))
    .sort((a, b) => (a.goal.minute ?? 0) - (b.goal.minute ?? 0)
      || (a.goal.injuryTime ?? 0) - (b.goal.injuryTime ?? 0) || a.index - b.index)
    .map(({ goal }) => goal);

  const counts = { home: 0, away: 0 };
  const trailed = { home: false, away: false };
  const byScorer = new Map();
  const out = [];
  for (const goal of goals) {
    const side = sideOf(match, goal.team);
    if (!side) continue;
    const ordinal = counts[side] + 1;
    // Rule 2 in the header: the score has to have reached this goal.
    if (ordinal > score[side]) continue;
    const other = side === "home" ? "away" : "home";
    const before = { ...counts };
    counts[side] = ordinal;
    const after = { ...counts };

    const tags = [];
    if (before.home === 0 && before.away === 0) tags.push("opener");
    else if (after[side] === after[other]) tags.push("equaliser");
    else if (before[side] === before[other] && after[side] > after[other]) {
      tags.push(trailed[side] ? "comeback" : "lead");
    }
    if (goal.type === "PENALTY") tags.push("penalty");
    if (goal.type === "OWN") tags.push("own-goal");
    if ((goal.minute ?? 0) >= 85) tags.push("late");
    if ((goal.minute ?? 0) >= 90 && (goal.injuryTime ?? 0) > 0) tags.push("stoppage-time");
    if (goal.type !== "OWN" && goal.scorer) {
      const scorerKey = goal.scorerId ?? goal.scorer;
      const tally = (byScorer.get(scorerKey) ?? 0) + 1;
      byScorer.set(scorerKey, tally);
      if (tally === 2) tags.push("brace");
      if (tally === 3) tags.push("hat-trick");
      if (tally > 3) tags.push("haul");
    }
    if (after[side] - after[other] >= 3) tags.push("rout");
    if (after[side] < after[other]) tags.push("consolation");

    out.push({ goal, side, ordinal, score: after, tags });
    if (after.home < after.away) trailed.home = true;
    if (after.away < after.home) trailed.away = true;
  }
  return out;
}

// Every item the match's current state supports. The cron calls this every
// tick and lets reconcileWire decide what is new; calling it twice on the same
// inputs returns the same keys.
export function wireItemsForMatch({ competition, match, detail = null, table = null } = {}) {
  if (!match?.id || !match.utcDate) return [];
  const started = isLive(match.status) || isFinished(match.status);
  if (!started) return [];
  const kickoff = match.utcDate;
  const items = [];

  items.push(base(competition, match, WIRE_KINDS.KICKOFF, `ko:${match.id}`, {
    minute: 0, at: eventInstant(kickoff, 0),
  }));

  const goals = confirmedGoals(match, detail);
  const latestGoal = goals[goals.length - 1] ?? null;
  for (const entry of goals) {
    const { goal, side, ordinal, score, tags } = entry;
    items.push(base(competition, match, WIRE_KINDS.GOAL, `g:${match.id}:${side}:${ordinal}`, {
      minute: goal.minute ?? null,
      injury: goal.injuryTime ?? null,
      at: eventInstant(kickoff, goal.minute, goal.injuryTime),
      side,
      team: side === "home" ? match.homeTeam : match.awayTeam,
      player: goal.scorer || null,
      playerId: goal.scorerId ?? null,
      assist: goal.assist || null,
      goalType: goal.type ?? "REGULAR",
      score,
      tags,
      // Table consequences are only honest for the goal that produced the
      // CURRENT score: an older goal's "as it stands" would be computed against
      // a later scoreline. A backfilled goal simply carries none.
      impact: entry === latestGoal && isLive(match.status) && table
        ? goalImpact(table, match, side) : null,
    }));
  }

  const reds = { home: 0, away: 0 };
  for (const card of [...(detail?.cards ?? [])].sort((a, b) => (a.minute ?? 0) - (b.minute ?? 0))) {
    const side = sideOf(match, card.team);
    if (!side || !card.card) continue;
    const red = card.card === "RED" || card.card === "YELLOW_RED";
    if (red) reds[side] += 1;
    items.push(base(competition, match, WIRE_KINDS.CARD,
      `c:${match.id}:${card.playerId ?? card.player}:${card.card}`, {
        minute: card.minute ?? null,
        at: eventInstant(kickoff, card.minute),
        side,
        team: side === "home" ? match.homeTeam : match.awayTeam,
        player: card.player || null,
        playerId: card.playerId ?? null,
        card: card.card,
        // Players left on the pitch after this card, so the copy can say "down
        // to ten" without the reader counting.
        players: red ? 11 - reds[side] : null,
      }));
  }

  for (const sub of detail?.subs ?? []) {
    const side = sideOf(match, sub.team);
    if (!side) continue;
    items.push(base(competition, match, WIRE_KINDS.SUB,
      `s:${match.id}:${sub.inId ?? sub.in}:${sub.outId ?? sub.out}`, {
        minute: sub.minute ?? null,
        at: eventInstant(kickoff, sub.minute),
        side,
        team: side === "home" ? match.homeTeam : match.awayTeam,
        playerIn: sub.in || null,
        playerOut: sub.out || null,
      }));
  }

  const halfTime = halfTimeScore(match, detail);
  if (halfTime) {
    items.push(base(competition, match, WIRE_KINDS.HALF_TIME, `ht:${match.id}`, {
      minute: 45, at: eventInstant(kickoff, 45, 3), score: halfTime,
    }));
  }

  if (isFinished(match.status)) {
    const final = scoreOf(match);
    if (final) {
      items.push(base(competition, match, WIRE_KINDS.FULL_TIME, `ft:${match.id}`, {
        minute: match.minute ?? 90,
        at: eventInstant(kickoff, Math.max(90, Number(match.minute) || 90), 5),
        score: final,
        pens: match.penalties ?? null,
        tags: fullTimeTags(match, goals, table),
        impact: table ? fullTimeImpact(table, match) : null,
      }));
    }
  }
  return items;
}

// Half-time is not an event in the feed, so it is inferred: the provider says
// HT now, or the match is already past it and the detail carries the half-time
// score. A match first seen in the second half with no half-time score gets no
// item rather than an invented one.
function halfTimeScore(match, detail) {
  const ht = Number.isFinite(detail?.score?.htHome) && Number.isFinite(detail?.score?.htAway)
    ? { home: detail.score.htHome, away: detail.score.htAway } : null;
  if (match.providerStatus === "HT") return ht ?? scoreOf(match);
  const past = isFinished(match.status) || ["2H", "ET", "BT", "P"].includes(match.providerStatus);
  return past ? ht : null;
}

function fullTimeTags(match, goals, table) {
  const final = scoreOf(match);
  if (!final) return [];
  const tags = [];
  const winner = final.home > final.away ? "home" : final.away > final.home ? "away" : null;
  const margin = Math.abs(final.home - final.away);
  if (!winner) {
    const last = goals[goals.length - 1];
    if (last?.tags.includes("equaliser") && (last.goal.minute ?? 0) >= 85) tags.push("late-leveller");
    if (final.home === 0) tags.push("goalless");
    return tags;
  }
  if (goals.some(entry => entry.score[winner] < entry.score[winner === "home" ? "away" : "home"])) {
    tags.push("comeback-win");
  }
  const decider = [...goals].reverse().find(entry => entry.side === winner);
  if (margin === 1 && decider && (decider.goal.minute ?? 0) >= 85) tags.push("late-winner");
  if (margin >= 4) tags.push("thrashing");
  // An upset needs a table that means something: ten places apart in a table
  // where both sides have played. Never inferred from reputation.
  const rows = table?.rows;
  const loser = winner === "home" ? match.awayTeam : match.homeTeam;
  const winnerRow = rows?.find(row => row.team === (winner === "home" ? match.homeTeam : match.awayTeam));
  const loserRow = rows?.find(row => row.team === loser);
  if (winnerRow?.played && loserRow?.played && winnerRow.position - loserRow.position >= 10) tags.push("upset");
  return tags;
}

// The league table this module reasons over, built from a raw live payload the
// way analysisPrompt.js builds its context. Null when there is no table worth
// trusting (no standings, or the provider's standings are known to be behind).
export function wireTable(live, competitionCode) {
  if (!live?.standings?.length || live.standingsDelayed) return null;
  const competition = competitionFor(competitionCode);
  const standings = mapStandings({ standings: canonicalizeStandingsOrder(live.standings) }, competition.zones);
  const rows = [...standings.values()];
  // Group tables (old-format cups) cannot be re-ranked as one league.
  if (!rows.length || rows.some(row => row.group && row.group !== rows[0].group)) return null;
  return { rows, matches: live.matches ?? [], zones: competition.zones, competitionCode };
}

function positionsWith(table, matches) {
  const { rows } = applyLiveResults({
    rows: table.rows, matches, zones: table.zones, competitionCode: table.competitionCode,
  });
  return new Map(rows.map(row => [row.team, row.position]));
}

function shift(table, team, before, after) {
  const from = before.get(team);
  const to = after.get(team);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  const zoneFrom = zoneFor(from, table.zones);
  const zoneTo = zoneFor(to, table.zones);
  return {
    team, from, to,
    zone: zoneTo?.label ?? null,
    zoneChanged: (zoneFrom?.label ?? null) !== (zoneTo?.label ?? null),
  };
}

// Where the scoring side sits as it stands, against where it sat before the
// goal. Computed with the same applyLiveResults the live table uses, so the
// wire can never claim a position the table on screen contradicts.
function goalImpact(table, match, side) {
  const current = scoreOf(match);
  if (!current || current[side] < 1) return null;
  const withScore = (score) => table.matches.map(item => item.id === match.id ? { ...match, score } : item);
  const after = positionsWith(table, withScore(current));
  const before = positionsWith(table, withScore({ ...current, [side]: current[side] - 1 }));
  const team = side === "home" ? match.homeTeam : match.awayTeam;
  const moved = shift(table, team, before, after);
  return moved && moved.from !== moved.to ? moved : null;
}

// Full time against the table before kick-off, for the side that moved most.
// The match is folded in as if still live: when the provider has already
// counted it, applyLiveResults' own played-count guard leaves both versions
// identical and this returns null, which is the honest answer.
function fullTimeImpact(table, match) {
  const final = scoreOf(match);
  if (!final) return null;
  const others = table.matches.filter(item => item.id !== match.id);
  const before = positionsWith(table, others);
  const after = positionsWith(table, [...others, { ...match, status: "IN_PLAY", score: final }]);
  const moves = [match.homeTeam, match.awayTeam]
    .map(team => shift(table, team, before, after))
    .filter(move => move && move.from !== move.to)
    .sort((a, b) => Math.abs(b.from - b.to) - Math.abs(a.from - a.to));
  return moves[0] ?? null;
}

// Compares what is stored for a match with what the current state supports.
//
// Returns:
//   inserts  - items whose key has never been stored
//   updates  - stored goals whose facts the provider has since corrected (same
//              key, different scorer/assist/minute/type), to rewrite in place
//   retire   - stored goal keys ruled out (both the score and the events have
//              dropped below that ordinal); the caller renames the key so the
//              slot is free for the next real goal, and inserts the matching
//              OVERTURNED item from `inserts`
//
// `stored` is the list of facts payloads already persisted for this match.
// `detailTrusted` must be false for a degraded or substanceless detail read:
// an empty events section is a failed read, not a goal being disallowed, so
// nothing is ever retired on its evidence.
export function reconcileWire({ stored = [], current = [], match, detail = null, detailTrusted = false } = {}) {
  const storedByKey = new Map(stored.map(item => [item.key, item]));
  const currentByKey = new Map(current.map(item => [item.key, item]));
  const inserts = [];
  const updates = [];
  const retire = [];

  for (const item of current) {
    const previous = storedByKey.get(item.key);
    if (!previous) {
      inserts.push(item);
    } else if (item.kind === WIRE_KINDS.GOAL && goalFactsChanged(previous, item)) {
      // A correction keeps the original's story and table impact: those were
      // computed when it happened and a later score would make them wrong.
      updates.push({ ...previous, player: item.player, playerId: item.playerId, assist: item.assist,
        minute: item.minute, injury: item.injury, goalType: item.goalType, at: item.at });
    }
  }

  const score = scoreOf(match);
  if (score && detailTrusted) {
    const eventGoals = { home: 0, away: 0 };
    for (const goal of detail?.goals ?? []) {
      const side = sideOf(match, goal.team);
      if (side) eventGoals[side] += 1;
    }
    for (const item of stored) {
      if (item.kind !== WIRE_KINDS.GOAL || currentByKey.has(item.key)) continue;
      const ordinal = Number(item.key.split(":").pop());
      const side = item.side;
      if (!Number.isFinite(ordinal) || !side) continue;
      if (score[side] < ordinal && eventGoals[side] < ordinal) {
        retire.push(item.key);
        inserts.push(base(item.competition, match, WIRE_KINDS.OVERTURNED, `x:${item.key}`, {
          minute: item.minute,
          at: eventInstant(match.utcDate, match.minute ?? item.minute),
          side,
          team: item.team,
          player: item.player,
          originalMinute: item.minute,
          score,
        }));
      }
    }
  }
  return { inserts, updates, retire };
}

function goalFactsChanged(previous, item) {
  return ["player", "assist", "minute", "injury", "goalType"]
    .some(field => (previous[field] ?? null) !== (item[field] ?? null));
}

// Whether a freshly inserted item should be sent to the model. Old news never
// is (see WIRE_FRESH_MINUTES); full time only when the wire watched the match
// live (`watchedLive`), so a backfilled evening does not write a dozen
// full-time reads at once.
export function wireAiEligible(item, match, { watchedLive = false } = {}) {
  if (!BIG_KINDS.has(item.kind) && !(item.kind === WIRE_KINDS.CARD && isRedCard(item))) return false;
  if (item.kind === WIRE_KINDS.FULL_TIME) return watchedLive;
  if (!isLive(match?.status)) return false;
  const now = Number(match.minute);
  const then = Number(item.minute);
  return Number.isFinite(now) && Number.isFinite(then) && now - then <= WIRE_FRESH_MINUTES;
}

export function isRedCard(item) {
  return item?.card === "RED" || item?.card === "YELLOW_RED";
}

export function isBigMoment(item) {
  return BIG_KINDS.has(item?.kind) || isRedCard(item);
}

// Newest first: the panel reads top-down like every live blog. Ties (one
// minute, two events) fall back to football order, then the key so the order
// is total and cannot flicker between polls.
export function sortWireItems(items) {
  return [...items].sort((a, b) => {
    const at = Date.parse(b.at ?? "") - Date.parse(a.at ?? "");
    if (at) return at;
    const kind = (KIND_ORDER[b.kind] ?? 9) - (KIND_ORDER[a.kind] ?? 9);
    if (kind) return kind;
    return String(b.key).localeCompare(String(a.key));
  });
}

const PLAYER_WORDS = { 10: "ten", 9: "nine", 8: "eight", 7: "seven" };

export function ordinalSuffix(n) {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  return `${n}${{ 1: "st", 2: "nd", 3: "rd" }[n % 10] ?? "th"}`;
}

export function minuteLabel(item) {
  if (!Number.isFinite(item?.minute)) return "";
  return item.injury ? `${item.minute}+${item.injury}'` : `${item.minute}'`;
}

function scoreline(item, score = item.score) {
  return score ? `${item.homeTeam} ${score.home}–${score.away} ${item.awayTeam}` : `${item.homeTeam} v ${item.awayTeam}`;
}

const GOAL_HEADLINES = {
  "hat-trick": "HAT-TRICK!",
  comeback: "GOAL! Turned around!",
  equaliser: "GOAL! Level!",
  lead: "GOAL! In front!",
  opener: "GOAL!",
};

// The template commentary: a headline (the shout) and a line (the facts). Every
// figure here comes from stored facts, which is what lets the AI line sit
// underneath without ever being the only place a number is stated.
export function describeWireItem(item) {
  switch (item?.kind) {
    case WIRE_KINDS.KICKOFF:
      return { headline: "Kick-off", line: `${item.homeTeam} v ${item.awayTeam} is under way.` };
    case WIRE_KINDS.GOAL: {
      const tags = item.tags ?? [];
      const shout = tags.includes("hat-trick") ? GOAL_HEADLINES["hat-trick"]
        : ["comeback", "equaliser", "lead"].map(tag => tags.includes(tag) && GOAL_HEADLINES[tag]).find(Boolean)
          ?? "GOAL!";
      const how = item.goalType === "OWN" ? " (own goal)" : item.goalType === "PENALTY" ? " from the spot" : "";
      const who = item.player ? `${item.player}${how} for ${item.team}` : `${item.team}${how}`;
      const assist = item.assist && item.goalType !== "OWN" ? `, assisted by ${item.assist}` : "";
      const brace = tags.includes("brace") && item.player ? ` That's two for ${item.player}.` : "";
      return { headline: shout, line: `${who}${assist}. ${scoreline(item)}.${brace}` };
    }
    case WIRE_KINDS.OVERTURNED:
      return {
        headline: "Goal ruled out",
        line: `${item.player ? `${item.player}'s` : `${item.team}'s`} goal no longer stands. ${scoreline(item)}.`,
      };
    case WIRE_KINDS.CARD: {
      if (isRedCard(item)) {
        const who = item.player || "A player";
        const off = item.card === "YELLOW_RED" ? `Second yellow for ${who}, who is off (${item.team}).`
          : `${who} is sent off (${item.team}).`;
        const left = PLAYER_WORDS[item.players] ? ` ${item.team} are down to ${PLAYER_WORDS[item.players]}.` : "";
        return { headline: "Red card", line: `${off}${left}` };
      }
      return { headline: "Yellow card", line: `${item.player || "A player"} is booked (${item.team}).` };
    }
    case WIRE_KINDS.SUB:
      return {
        headline: `Change for ${item.team}`,
        line: item.playerIn && item.playerOut ? `${item.playerIn} on, ${item.playerOut} off.`
          : `${item.playerIn ?? "A substitute"} comes on.`,
      };
    case WIRE_KINDS.HALF_TIME:
      return { headline: "Half-time", line: `${scoreline(item)}.` };
    case WIRE_KINDS.FULL_TIME: {
      const pens = item.pens ? ` ${item.pens.home}–${item.pens.away} on penalties.` : "";
      return { headline: "Full-time", line: `${scoreline(item)}.${pens}` };
    }
    default:
      return { headline: "", line: "" };
  }
}

// The table consequence as a short chip: "Liverpool up to 8th · Round of 16".
// "as it stands" is the honest qualifier for a live match; full time states it.
export function describeImpact(item) {
  const impact = item?.impact;
  if (!impact) return null;
  const direction = impact.to < impact.from ? "up to" : "down to";
  const zone = impact.zoneChanged && impact.zone ? ` · ${impact.zone}` : "";
  const qualifier = item.kind === WIRE_KINDS.FULL_TIME ? "" : " as it stands";
  return `${impact.team} ${direction} ${ordinalSuffix(impact.to)}${zone}${qualifier}`;
}

// "Watch now": the match most worth switching to, from the live state plus the
// wire's own recent events. Deterministic and explained, never a black box: the
// reason shown is the biggest contributor to the score. Returns null when no
// match clears the bar, because a pulse on a dull night is noise.
export function wirePulse(matches, items, now = Date.now()) {
  const recentWindow = 12 * 60_000;
  let best = null;
  for (const match of matches ?? []) {
    if (!isLive(match.status) || match.status === "PAUSED") continue;
    const score = scoreOf(match);
    if (!score) continue;
    const minute = Number(match.minute) || 0;
    // receivedAt is when the wire actually saw the event (the stored row's
    // insert time); `at` is only an ordering estimate, so it is the fallback.
    const recent = (items ?? []).filter(item => item.matchId === match.id
      && now - Date.parse(item.receivedAt ?? item.at ?? "") <= recentWindow);
    const recentGoals = recent.filter(item => item.kind === WIRE_KINDS.GOAL).length;
    const recentRed = recent.some(isRedCard);
    const margin = Math.abs(score.home - score.away);
    const reasons = [];
    if (recentGoals >= 2) reasons.push([4, `${recentGoals} goals in the last few minutes`]);
    else if (recentGoals === 1) reasons.push([2, "Just scored"]);
    if (recentRed) reasons.push([2, "Down to ten"]);
    if (minute >= 75 && margin === 0) reasons.push([3, `Level at ${minute}'`]);
    else if (minute >= 75 && margin === 1) reasons.push([2, `One goal in it, ${minute}'`]);
    else if (margin <= 1 && score.home + score.away >= 3) reasons.push([2, "End to end"]);
    const heat = reasons.reduce((sum, [weight]) => sum + weight, 0);
    if (heat < 3) continue;
    const reason = [...reasons].sort((a, b) => b[0] - a[0])[0][1];
    if (!best || heat > best.heat || (heat === best.heat && minute > best.minute)) {
      best = { matchId: match.id, homeTeam: match.homeTeam, awayTeam: match.awayTeam, score, minute, heat, reason };
    }
  }
  return best;
}

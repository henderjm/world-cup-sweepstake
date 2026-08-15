// Upcoming-fixture outlook for a transfer decision: which opponents a club
// faces over the next few gameweeks, and how tough each of those fixtures
// looks. Built for the add/claim confirm step (renderFantasyClaimFlow), where
// a manager choosing who to drop needs "Robertson has Arsenal and City next,
// van Dijk has Bournemouth" in front of them, not in their head.
//
// Pure: arrays/Maps in, plain data out. No DOM, no fetch. The gameweek
// grouping is fantasyCalendar.js's (so a double gameweek shows two fixtures
// and a blank shows none, never a guess), and the strength signal is
// fantasyDemoFixtures.js's deriveClubStrength - the one club-strength
// definition in the app, NOT a second competing one. This module only turns
// that signal into a coarse per-fixture difficulty label, and refuses to when
// the signal cannot actually rank clubs (see hasStrengthSignal).

import { gameweekFixtures } from "./fantasyCalendar.js";
import { normalizeTeamName } from "./domain.js";

// How many gameweeks ahead the outlook covers. Three is enough to catch "two
// tough away games coming up" without pretending fixture difficulty two
// months out is knowable in any useful way.
export const OUTLOOK_GAMEWEEKS = 3;

// Difficulty buckets over deriveClubStrength's (0, 1] scale, where 1 is the
// strongest club. Rank-based strengths for a 20-club league land on
// 1.0, 0.95, ... 0.05, so these cuts put roughly the top third of the league
// in "hard" and the bottom third in "easy" rather than pretending a
// mid-table trip is either.
export const HARD_STRENGTH_MIN = 0.7;
export const EASY_STRENGTH_MAX = 0.35;

// A strength map can only rank fixtures if it actually ranks clubs. The
// neutral fallback (every club NEUTRAL_CLUB_STRENGTH) is deliberately
// indistinguishable from a genuinely mid-table club by value, so the honest
// test is distinctness across the whole map: fewer than two distinct values
// means the model has no ordering, and every difficulty comes back null
// rather than a confident "fair" invented from nothing.
export function hasStrengthSignal(strength) {
  if (!(strength instanceof Map) || strength.size < 2) return false;
  const values = new Set();
  for (const value of strength.values()) {
    if (Number.isFinite(value)) values.add(value);
    if (values.size >= 2) return true;
  }
  return false;
}

// "easy" | "fair" | "hard" for one opponent, or null when the strength map
// cannot say (no signal, or this opponent simply is not in it - a promoted
// club missing from a prior-season pool must degrade to unlabelled, never to
// "easy" by absence).
export function difficultyFor(strength, opponent, signal = hasStrengthSignal(strength)) {
  if (!signal) return null;
  const value = strength.get(normalizeTeamName(opponent));
  if (!Number.isFinite(value)) return null;
  if (value >= HARD_STRENGTH_MIN) return "hard";
  if (value <= EASY_STRENGTH_MAX) return "easy";
  return "fair";
}

// One club's outlook from `fromGameweek` for up to `gameweeks` windows:
// [{ gameweek, fixtures: [{ opponent, isHome, difficulty }] }]. An empty
// fixtures array is a real blank gameweek and worth saying out loud; a
// gameweek with no fixtures for ANYONE is the schedule running out (or a feed
// that does not reach that far) and is dropped instead, because "blank" would
// be a claim about the fixture list rather than about this club.
//
// Returns null - no outlook at all, rather than an empty one - when there is
// no feed or no anchoring gameweek, matching how the free-agent rows omit a
// figure they cannot stand behind instead of substituting one.
export function fixtureOutlook({ matches, team, fromGameweek, gameweeks = OUTLOOK_GAMEWEEKS, strength } = {}) {
  if (!matches?.length || !team || !Number.isFinite(fromGameweek)) return null;
  const signal = hasStrengthSignal(strength);
  // The club is matched by canonical name on BOTH sides (the same reason
  // buildFixtureIndex normalizes): a pool entry spelling a club differently
  // from the feed must degrade to a correct join, never to a fabricated
  // "blank gameweek" - the one wrong answer this card exists to prevent.
  const key = normalizeTeamName(team);
  const outlook = [];
  for (let gameweek = fromGameweek; gameweek < fromGameweek + gameweeks; gameweek += 1) {
    const all = gameweekFixtures(matches, gameweek);
    if (!all.length) break;
    const fixtures = all
      .filter((match) => normalizeTeamName(match.homeTeam) === key || normalizeTeamName(match.awayTeam) === key)
      .map((match) => {
        const isHome = normalizeTeamName(match.homeTeam) === key;
        const opponent = isHome ? match.awayTeam : match.homeTeam;
        return { opponent, isHome, difficulty: difficultyFor(strength, opponent, signal) };
      });
    outlook.push({ gameweek, fixtures });
  }
  return outlook.length ? outlook : null;
}

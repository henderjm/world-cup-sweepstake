// The Home briefing: "what happened since you were last here, and what you
// need to know for the week ahead". Pure, shared by the Worker (GET /briefing
// assembles it) and the browser (renders it and decides whether to land on
// Home). Every figure here is computed from data the app already stores; the
// only prose is an optional one-line model note added by a later cron pass,
// which never reaches these functions.
//
// "Since" is the server-side users.last_briefed_at, so a phone and a laptop
// agree on what has already been seen. A first visit, or one after a long
// absence, looks back a bounded window rather than dumping a season on the
// screen.

import { isFinished, isLive } from "./format.js";
import { standingsFromFixtures } from "./fantasyGameweek.js";
import { followsTeam } from "./teamFollows.js";

export const BRIEFING_CARDS = ["fantasyNext", "fantasyLast", "clubs", "headlines"];

// The account prefs that switch each card, and landing, off. Stored with the
// notification prefs (POST /prefs); a missing key reads as on, matching the
// Worker's DEFAULT_PREFS, so an account from before the briefing sees it all.
export const BRIEFING_PREFS = {
  landing: "homeLanding",
  fantasyNext: "homeFantasyNext",
  fantasyLast: "homeFantasyLast",
  clubs: "homeClubs",
  headlines: "homeHeadlines",
};
export const briefingPref = (prefs, key) => prefs?.[BRIEFING_PREFS[key]] !== false;

// Whether the app should open on Home this visit: something changed while
// you were away, and you have not switched landing off.
export function shouldLand(briefing, prefs) {
  return briefingPref(prefs, "landing") && hasNews(briefing);
}
export const DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;
export const HEADLINE_LIMIT = 5;

// A match is attributed to the window by kickoff. A match that kicked off just
// before the last visit was still being played then, so its RESULT is new:
// the window opens this much earlier than `since` for finished matches.
export const RESULT_GRACE_MS = 2.5 * 60 * 60 * 1000;

const kickoffMs = (match) => {
  const value = Date.parse(match?.utcDate ?? "");
  return Number.isFinite(value) ? value : null;
};

// The instant the briefing looks back to. An unreadable or future timestamp is
// treated as "never briefed" rather than trusted.
export function briefingSince(lastBriefedAt, now) {
  const floor = now - MAX_LOOKBACK_MS;
  const parsed = Date.parse(lastBriefedAt ?? "");
  if (!Number.isFinite(parsed) || parsed > now) return now - DEFAULT_LOOKBACK_MS;
  return Math.max(parsed, floor);
}

// D1 stores datetime('now') as "YYYY-MM-DD HH:MM:SS" in UTC with no zone, which
// Date.parse reads as LOCAL time. Normalise before anything compares it.
export function d1TimeToIso(value) {
  if (!value) return null;
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) return `${text.replace(" ", "T")}Z`;
  return text;
}

function finishedSince(match, since) {
  const kickoff = kickoffMs(match);
  return isFinished(match.status) && kickoff != null && kickoff >= since - RESULT_GRACE_MS;
}

function resultRow(match, competition, extra = {}) {
  return {
    matchId: match.id,
    competition,
    homeTeam: match.homeTeam,
    awayTeam: match.awayTeam,
    score: { home: match.score?.home ?? null, away: match.score?.away ?? null },
    utcDate: match.utcDate ?? null,
    ...extra,
  };
}

const byKickoffDesc = (a, b) => (Date.parse(b.utcDate ?? "") || 0) - (Date.parse(a.utcDate ?? "") || 0);

// `feeds` is [{ competition: "PL", matches: [...] }]. Results for followed
// clubs, newest first. `analysisFor(matchId)` returns a stored analysis
// headline or null; it is passed in so this stays pure.
export function clubResults({ feeds, follows, since, analysisFor = () => null }) {
  const rows = [];
  for (const feed of feeds ?? []) {
    for (const match of feed.matches ?? []) {
      const followed = followsTeam(follows ?? [], feed.competition, match.homeTeam)
        || followsTeam(follows ?? [], feed.competition, match.awayTeam);
      if (!followed || !finishedSince(match, since)) continue;
      rows.push(resultRow(match, feed.competition, { headline: analysisFor(match.id) ?? null }));
    }
  }
  return rows.sort(byKickoffDesc);
}

// Results across every supported competition since the last visit, plus how
// many matches are live right now. Ranked: followed clubs first, then the
// matches with the most goals (a 4-3 is a headline, a 0-0 rarely is), newest
// breaking ties. Followed results also appear in the clubs card, which is
// fine: this card is the league-wide view.
export function headlines({ feeds, follows, since, limit = HEADLINE_LIMIT }) {
  let live = 0;
  const rows = [];
  for (const feed of feeds ?? []) {
    for (const match of feed.matches ?? []) {
      if (isLive(match.status)) live += 1;
      if (!finishedSince(match, since)) continue;
      const followed = followsTeam(follows ?? [], feed.competition, match.homeTeam)
        || followsTeam(follows ?? [], feed.competition, match.awayTeam);
      rows.push(resultRow(match, feed.competition, { followed }));
    }
  }
  const goals = (row) => (row.score.home ?? 0) + (row.score.away ?? 0);
  rows.sort((a, b) => Number(b.followed) - Number(a.followed) || goals(b) - goals(a) || byKickoffDesc(a, b));
  return { live, results: rows.slice(0, limit) };
}

// fixtures: [{ gameweek, homeUserId, awayUserId, homeScore, awayScore }].
// Rank is 1-based position in the H2H table, which only counts settled rows.
function rankAfter(fixtures, members, userId, throughGameweek) {
  const table = standingsFromFixtures(fixtures.filter((fixture) => fixture.gameweek <= throughGameweek), members);
  const index = table.findIndex((row) => row.userId === userId);
  return index === -1 ? null : index + 1;
}

function sideOf(fixture, userId) {
  if (!fixture) return null;
  const home = fixture.homeUserId === userId;
  return {
    opponentId: home ? fixture.awayUserId : fixture.homeUserId,
    mine: home ? fixture.homeScore : fixture.awayScore,
    theirs: home ? fixture.awayScore : fixture.homeScore,
  };
}

const outcome = (mine, theirs) => (mine > theirs ? "W" : mine < theirs ? "L" : "D");

// The caller's result in `gameweek`, with their table position before and
// after it. Null when that gameweek has not settled for them (no fixture, or
// scores not yet rolled up), because a briefing must never show a result
// that is still being counted.
export function fantasyResult({ fixtures, members, userId, gameweek, players = [] }) {
  const fixture = (fixtures ?? []).find((row) => row.gameweek === gameweek
    && (row.homeUserId === userId || row.awayUserId === userId));
  const side = sideOf(fixture, userId);
  if (!side || side.mine == null || side.theirs == null) return null;
  const opponent = (members ?? []).find((member) => member.userId === side.opponentId);
  const before = gameweek > 1 ? rankAfter(fixtures, members, userId, gameweek - 1) : null;
  const after = rankAfter(fixtures, members, userId, gameweek);
  return {
    gameweek,
    result: outcome(side.mine, side.theirs),
    score: { mine: side.mine, theirs: side.theirs },
    opponent: opponent ? { userId: opponent.userId, name: opponent.name, isBot: Boolean(opponent.isBot) } : null,
    rank: { before, after },
    ...topAndFlop(players),
  };
}

// players: [{ playerId, name, points, isCaptain }] for the caller's starters.
// Points are UNDOUBLED, like the My team pitch; the captain flag rides along
// so the client can explain a captain's flop without inventing a figure.
export function topAndFlop(players) {
  const scored = (players ?? []).filter((player) => Number.isFinite(player?.points));
  if (!scored.length) return { top: null, flop: null };
  const sorted = [...scored].sort((a, b) => b.points - a.points || String(a.name).localeCompare(String(b.name)));
  const top = sorted[0];
  const flop = sorted[sorted.length - 1];
  return { top, flop: flop === top ? null : flop };
}

// The opponent's last `count` settled results, newest first, as "W"/"D"/"L".
export function managerForm(fixtures, userId, beforeGameweek, count = 3) {
  return (fixtures ?? [])
    .filter((row) => row.gameweek < beforeGameweek && (row.homeUserId === userId || row.awayUserId === userId))
    .map((row) => ({ gameweek: row.gameweek, side: sideOf(row, userId) }))
    .filter(({ side }) => side.mine != null && side.theirs != null)
    .sort((a, b) => b.gameweek - a.gameweek)
    .slice(0, count)
    .map(({ side }) => outcome(side.mine, side.theirs));
}

// The week ahead: who the caller plays, that opponent's form, the squad
// deadline, and the squad's shape (starters whose club does not play, clubs
// that play twice). `starters` and `roster` are [{ playerId, name, team }];
// `clubCounts` is clubFixtureCounts(matches, gameweek). An unpaired manager
// in an odd league faces Average, which has no form to show.
export function fantasyPreview({ fixtures, members, userId, gameweek, deadline = null, locked = false, starters = [], roster = [], clubCounts = null }) {
  const fixture = (fixtures ?? []).find((row) => row.gameweek === gameweek
    && (row.homeUserId === userId || row.awayUserId === userId));
  const side = sideOf(fixture, userId);
  const opponent = side ? (members ?? []).find((member) => member.userId === side.opponentId) : null;
  const counts = clubCounts instanceof Map ? clubCounts : new Map(Object.entries(clubCounts ?? {}));
  const known = clubCounts != null;
  const blankStarters = known
    ? starters.filter((player) => (counts.get(player.team) ?? 0) === 0).map(({ playerId, name, team }) => ({ playerId, name, team }))
    : [];
  const doubleTeams = known
    ? [...new Set(roster.map((player) => player.team).filter((team) => (counts.get(team) ?? 0) > 1))].sort()
    : [];
  return {
    gameweek,
    deadline,
    locked: Boolean(locked),
    opponent: opponent
      ? {
          userId: opponent.userId,
          name: opponent.name,
          isBot: Boolean(opponent.isBot),
          form: managerForm(fixtures, opponent.userId, gameweek),
        }
      : null,
    blankStarters,
    doubleTeams,
  };
}

// Whether this briefing is worth LANDING on (the app opens on Home instead of
// Live). A false here never hides Home; it only stops the app sending you
// there. `briefing` is the GET /briefing body:
//   { clubs: [...], headlines: { live, results: [...] },
//     fantasy: [{ league, last: {...}|null, next: { deadline, locked, opponent, blankStarters, doubleTeams } }] }
// Notification-centre rule: land on Home only when something CHANGED while
// the person was away. A followed club's result is new by construction (the
// clubs card is already filtered to the window); a fantasy result counts only
// when its gameweek settled after the last visit (`last.isNew`). Headlines and
// live counts never land you: they are almost always non-empty, so they would
// send everyone to Home every time.
export function hasNews(briefing) {
  if ((briefing?.clubs ?? []).length > 0) return true;
  return (briefing?.fantasy ?? []).some((entry) => entry?.last?.isNew === true);
}

// Whether a gameweek whose last kickoff was `lastKickoff` (ms) finished after
// `since`. Same grace as club results: a match kicking off just before the
// last visit was still being played then, so its result is new.
export function settledSince(lastKickoff, since) {
  return Number.isFinite(lastKickoff) && lastKickoff >= since - RESULT_GRACE_MS;
}

// The signed-out Home: REAL results (league-wide, plus any clubs followed on
// this device) from the feeds the page already polls, with the fantasy cards
// filled by a fixed sample, so a visitor sees the actual screen they would
// get. `matches` is the combined V2 model (each carries competitionCode).
export const SAMPLE_FANTASY = [{
  league: { id: 0, name: "Sample league" },
  note: "Good win, but Mitoma has no match this week, so swap him out before the deadline.",
  last: {
    gameweek: 11, result: "W", score: { mine: 62, theirs: 48 },
    opponent: { userId: 2, name: "Dan", isBot: false }, rank: { before: 5, after: 3 },
    top: { playerId: 1, name: "Haaland", points: 14 }, flop: { playerId: 2, name: "Rice", points: 1, isCaptain: true },
    isNew: true,
  },
  next: {
    gameweek: 12, deadline: null, locked: false,
    opponent: { userId: 3, name: "Sam", isBot: false, form: ["W", "W", "L"] },
    blankStarters: [{ playerId: 3, name: "Mitoma", team: "Brighton" }], doubleTeams: [],
  },
}];

export function previewBriefing({ matches, follows, now }) {
  const byCompetition = new Map();
  for (const match of matches ?? []) {
    const code = match?.competitionCode;
    if (!code) continue;
    if (!byCompetition.has(code)) byCompetition.set(code, []);
    byCompetition.get(code).push(match);
  }
  const feeds = [...byCompetition].map(([competition, list]) => ({ competition, matches: list }));
  const since = now - DEFAULT_LOOKBACK_MS;
  return {
    sample: true,
    since: new Date(since).toISOString(),
    clubs: clubResults({ feeds, follows, since }),
    headlines: headlines({ feeds, follows, since }),
    fantasy: SAMPLE_FANTASY,
  };
}

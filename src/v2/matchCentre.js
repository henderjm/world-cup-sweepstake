// Pure view logic for the V2 Live home and Match page. No DOM, no fetch: the
// Svelte components decide when to call these, this decides what they show.
// The one rule every function here keeps is the PRD's honest-data rule: a
// figure the provider has not returned is omitted, never drawn as zero.

import { isFinished, isLive } from "../format.js";
import { localDateKey } from "../scoreDates.js";
import { pitchRows, surname } from "../matchDetail.js";

const PENDING = new Set(["TIMED", "SCHEDULED"]);

// "pre" | "live" | "post" | "off" (postponed, cancelled, suspended).
export function matchPhase(match) {
  if (isLive(match?.status)) return "live";
  if (isFinished(match?.status)) return "post";
  if (PENDING.has(match?.status)) return "pre";
  return "off";
}

// Today when a tracked competition plays today, otherwise the nearest
// upcoming matchday, otherwise the most recent one (end of season).
export function defaultMatchDay(days, today = localDateKey()) {
  if (days.includes(today)) return today;
  return days.find(day => day > today) ?? days.at(-1) ?? today;
}

export function matchesOnDay(matches, day) {
  return matches.filter(match => match.utcDate && localDateKey(match.utcDate) === day);
}

// List sections in competition order, each sorted by kickoff then home team.
export function groupByCompetition(matches, order) {
  return order
    .map(code => ({
      code,
      matches: matches
        .filter(match => match.competitionCode === code)
        .sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate) || a.homeTeam.localeCompare(b.homeTeam)),
    }))
    .filter(group => group.matches.length);
}

// Row labels: a match row has room for "Forest", not "Nottingham Forest".
const SHORT_NAMES = new Map([
  ["Brighton Hove", "Brighton"], ["Brighton & Hove Albion", "Brighton"], ["Coventry City", "Coventry"],
  ["Crystal Palace", "Palace"], ["Hull City", "Hull"], ["Ipswich Town", "Ipswich"], ["Leeds United", "Leeds"],
  ["Leicester City", "Leicester"], ["Manchester City", "Man City"], ["Manchester United", "Man Utd"], ["Man United", "Man Utd"],
  ["Newcastle United", "Newcastle"], ["Nottingham Forest", "Forest"], ["Nottm Forest", "Forest"], ["Sheffield United", "Sheff Utd"],
  ["Tottenham Hotspur", "Tottenham"], ["West Ham United", "West Ham"], ["Wolverhampton Wanderers", "Wolves"],
]);

export function shortTeamName(name) {
  return SHORT_NAMES.get(name) ?? name;
}

export function hasScore(match) {
  return Number.isFinite(match?.score?.home) && Number.isFinite(match?.score?.away);
}

// "Palmer 23', 64'" per side, from the detail's goals. Own goals credit the
// side that benefited, which is how the provider already files them.
export function scorerLines(detail, homeTeam) {
  const sides = { home: new Map(), away: new Map() };
  for (const goal of detail?.goals ?? []) {
    const side = goal.team === homeTeam ? "home" : "away";
    const name = `${surname(goal.scorer) || "Goal"}${goal.type === "OWN" ? " (og)" : goal.type === "PENALTY" ? " (pen)" : ""}`;
    const minute = Number.isFinite(goal.minute) ? `${goal.minute}${goal.injuryTime ? `+${goal.injuryTime}` : ""}'` : "";
    const list = sides[side].get(name) ?? [];
    list.push(minute);
    sides[side].set(name, list);
  }
  const line = map => [...map].map(([name, minutes]) => `${name} ${minutes.filter(Boolean).join(", ")}`.trim());
  return { home: line(sides.home), away: line(sides.away) };
}

function isRed(card) {
  return card === "RED" || card === "YELLOW_RED";
}

export function redCards(detail, team) {
  return (detail?.cards ?? []).filter(card => card.team === team && isRed(card.card)).length;
}

// Every moment in match order, newest first. Kinds: goal, red, yellow, sub.
export function moments(detail, homeTeam) {
  const list = [
    ...(detail?.goals ?? []).map(goal => ({
      kind: "goal", minute: goal.minute, extra: goal.injuryTime ?? null, team: goal.team,
      player: goal.scorer, note: [goal.type === "OWN" ? "own goal" : goal.type === "PENALTY" ? "penalty" : "", goal.assist ? `assist ${goal.assist}` : ""].filter(Boolean).join(" · "),
      score: Number.isFinite(goal.home) ? `${goal.home} - ${goal.away}` : null,
    })),
    ...(detail?.cards ?? []).map(card => ({
      kind: isRed(card.card) ? "red" : "yellow", minute: card.minute, extra: null, team: card.team,
      player: card.player, note: card.card === "YELLOW_RED" ? "second yellow" : "", score: null,
    })),
    ...(detail?.subs ?? []).map(sub => ({
      kind: "sub", minute: sub.minute, extra: null, team: sub.team,
      player: sub.in, note: sub.out ? `on for ${sub.out}` : "", score: null,
    })),
  ];
  return list
    .map((item, index) => ({ ...item, index, side: item.team === homeTeam ? "home" : "away" }))
    .sort((a, b) => (b.minute ?? 0) - (a.minute ?? 0) || (b.extra ?? 0) - (a.extra ?? 0) || b.index - a.index);
}

// The latest key moment for a spotlight card: goals and red cards only.
export function latestKeyMoment(detail, homeTeam) {
  return moments(detail, homeTeam).find(item => item.kind === "goal" || item.kind === "red") ?? null;
}

function sumStat(players, team, field) {
  const values = players.filter(player => player.team === team).map(player => player[field]);
  return values.some(Number.isFinite) ? values.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0) : null;
}

// Stat bars, home v away. Team statistics from the provider win when the
// detail carries them (detail.teamStats, wired later); until then shots and
// shots on target are summed from player statistics, and cards from events.
// A row is dropped unless both sides have a number.
export function statRows(detail, homeTeam, awayTeam, { full = false } = {}) {
  const team = detail?.teamStats;
  const players = detail?.playerStats ?? [];
  const pick = (key, field) => {
    const home = team?.home?.[key] ?? sumStat(players, homeTeam, field);
    const away = team?.away?.[key] ?? sumStat(players, awayTeam, field);
    return [home, away];
  };
  const cards = side => {
    const list = (detail?.cards ?? []).filter(card => card.team === side);
    return { total: list.length, reds: list.filter(card => isRed(card.card)).length };
  };
  const rows = [
    { key: "xg", label: "xG", values: [team?.home?.xg ?? null, team?.away?.xg ?? null], format: value => value.toFixed(2) },
    { key: "shots", label: "Shots", values: pick("shots", "shots") },
    { key: "onTarget", label: "On target", values: pick("shotsOnTarget", "shotsOnTarget") },
    { key: "bigChances", label: "Big chances", values: [team?.home?.bigChances ?? null, team?.away?.bigChances ?? null] },
    { key: "woodwork", label: "Hit the woodwork", values: [team?.home?.woodwork ?? null, team?.away?.woodwork ?? null], hideZero: true },
    { key: "possession", label: "Possession", values: [team?.home?.possession ?? null, team?.away?.possession ?? null], format: value => `${value}%` },
    { key: "corners", label: "Corners", values: [team?.home?.corners ?? null, team?.away?.corners ?? null] },
    ...(full ? [
      { key: "passes", label: "Passes", values: [team?.home?.passes ?? null, team?.away?.passes ?? null] },
      { key: "fouls", label: "Fouls", values: [team?.home?.fouls ?? null, team?.away?.fouls ?? null] },
    ] : []),
  ];
  if (detail?.cards) {
    const home = cards(homeTeam);
    const away = cards(awayTeam);
    rows.push({ key: "cards", label: "Cards", values: [home.total, away.total], reds: [home.reds, away.reds] });
  }
  return rows
    .filter(row => row.values.every(Number.isFinite) && !(row.hideZero && row.values[0] + row.values[1] === 0))
    .map(row => {
      const [home, away] = row.values;
      const total = home + away;
      return {
        ...row,
        text: row.values.map(row.format ?? String),
        share: total > 0 ? home / total : 0.5,
        leader: home === away ? null : home > away ? "home" : "away",
      };
    });
}

// The XI on the formation grid, each player carrying his rating when the
// provider has one. Null when the grid is incomplete (pitchRows' rule).
export function ratedPitch(detail, side) {
  const team = detail?.[side];
  const rows = pitchRows(team?.lineup);
  if (!rows) return null;
  const ratings = ratingIndex(detail);
  const best = topRating(detail, team?.name);
  return rows.map(line => line.map(player => {
    const rating = ratings.get(player.id) ?? null;
    return { id: player.id, name: surname(player.name), num: player.num, rating, top: rating !== null && rating === best };
  }));
}

function ratingIndex(detail) {
  return new Map((detail?.playerStats ?? [])
    .filter(player => player.playerId && Number.isFinite(player.rating))
    .map(player => [player.playerId, player.rating]));
}

function topRating(detail, team) {
  const ratings = (detail?.playerStats ?? []).filter(player => player.team === team && Number.isFinite(player.rating)).map(player => player.rating);
  return ratings.length ? Math.max(...ratings) : null;
}

// Highest-rated player of the match, with the line beneath his name built
// from the same stats (goals from events, key passes, saves). Null unrated.
export function playerOfMatch(detail) {
  const rated = (detail?.playerStats ?? []).filter(player => Number.isFinite(player.rating));
  if (!rated.length) return null;
  const best = rated.reduce((top, player) => (player.rating > top.rating ? player : top));
  const goals = (detail?.goals ?? []).filter(goal => goal.type !== "OWN" && (goal.scorerId ? goal.scorerId === best.playerId : goal.scorer === best.player)).length;
  const bits = [
    goals ? `${goals} goal${goals === 1 ? "" : "s"}` : "",
    best.keyPasses ? `${best.keyPasses} key pass${best.keyPasses === 1 ? "" : "es"}` : "",
    best.saves ? `${best.saves} save${best.saves === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  return { name: best.player, team: best.team, rating: best.rating, line: bits.join(" · ") };
}

// Club form as the table carries it ("W"/"D"/"L", oldest first) plus position.
export function clubForm(tables, team) {
  for (const table of tables ?? []) {
    const row = table.rows?.find(entry => entry.team === team);
    if (row) return { position: row.position, points: row.points, played: row.played, form: row.form ?? [] };
  }
  return null;
}

// "Updated 8s ago" from the data's own age. Live data more than two minutes
// old, or a feed the server marked stale, is "Delayed" and names its age.
export function freshness({ lastUpdated, stale = false, staleAgeMs = null, live = false }, now = Date.now()) {
  const updated = Date.parse(lastUpdated ?? "");
  if (!Number.isFinite(updated)) return { text: "Loading", delayed: false };
  const age = Math.max(0, now - updated, Number.isFinite(staleAgeMs) ? staleAgeMs : 0);
  const delayed = stale || (live && age > 120_000);
  const text = age < 5_000 ? "just now" : age < 60_000 ? `${Math.round(age / 1000)}s ago`
    : age < 3_600_000 ? `${Math.floor(age / 60_000)}m ago` : `${Math.floor(age / 3_600_000)}h ago`;
  return { text: delayed ? `Delayed, ${text}` : `Updated ${text}`, delayed };
}

export function minuteText(item) {
  if (!Number.isFinite(item?.minute)) return "";
  return item.extra ? `${item.minute}+${item.extra}'` : `${item.minute}'`;
}

// "in 3h 38m", "in 2 days" for a countdown under a kickoff time.
export function untilKickoff(utcDate, now = Date.now()) {
  const ms = Date.parse(utcDate ?? "") - now;
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `in ${mins}m`;
  if (mins < 24 * 60) return `in ${Math.floor(mins / 60)}h ${mins % 60}m`;
  const days = Math.round(mins / (24 * 60));
  return `in ${days} day${days === 1 ? "" : "s"}`;
}

// The momentum strip: one bar per minute, home pressure up and away down,
// scaled to the match's own peak so a quiet game still reads. Empty input
// (pre-match, or no pressure feed) gives null and the section is omitted.
export function momentumBars(pressure, { width = 358, height = 64 } = {}) {
  if (!pressure?.length) return null;
  const peak = Math.max(...pressure.map(row => Math.max(row.home, row.away)), 1);
  const last = Math.max(90, ...pressure.map(row => row.minute));
  const step = width / last;
  const mid = height / 2;
  return {
    width, height, mid,
    bars: pressure.map(row => ({
      minute: row.minute,
      x: (row.minute - 1) * step,
      w: Math.max(1, step - 1),
      home: (row.home / peak) * (mid - 2),
      away: (row.away / peak) * (mid - 2),
    })),
  };
}

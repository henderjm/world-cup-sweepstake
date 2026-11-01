// A player's figures for the V2 player sheet: this match (Sportmonks
// lineups.details, carried on the match centre) and this season (Sportmonks
// player statistics, GET /player/:id/season/:season). Pure and shared by the
// Worker (compaction) and the browser (rows). A figure Sportmonks did not
// send is left out; nothing is drawn as 0 unless Sportmonks said 0.

// Match detail values are plain numbers; season values are objects
// ({ total }, { average }), compacted to one number per type before they
// leave the Worker.
export function compactDetails(details) {
  const out = {};
  for (const detail of details ?? []) {
    const raw = detail.data?.value ?? detail.value;
    const value = typeof raw === "object" && raw !== null ? raw.total ?? raw.average ?? null : raw;
    // Flags (captain: true) are not figures.
    if (typeof value !== "number" && typeof value !== "string") continue;
    const number = Number(value);
    if (value !== "" && Number.isFinite(number)) out[detail.type_id] = number;
  }
  return out;
}

const T = {
  rating: 118, minutes: 119, goals: 52, assists: 79, xg: 5304, shots: 42, onTarget: 86, bigChances: 580,
  keyPasses: 117, dribbles: 109, dribbleAttempts: 108, passes: 80, accuratePasses: 116, finalThird: 27269,
  crosses: 98, accurateCrosses: 99, longBalls: 122, longBallsWon: 123, tackles: 78, tacklesWon: 27267,
  interceptions: 100, clearances: 101, recoveries: 27271, duels: 105, duelsWon: 106, aerials: 27274,
  aerialsWon: 107, fouls: 56, fouled: 96, possessionLost: 27273, saves: 57, savesInBox: 104, conceded: 88,
  yellow: 84, red: 85, appearances: 321, starts: 322, cleanSheets: 194,
};

const one = (label, key, format) => stats => (Number.isFinite(stats[T[key]]) ? { label, value: format ? format(stats[T[key]]) : String(stats[T[key]]) } : null);
const pair = (label, made, tried) => stats => {
  const a = stats[T[made]];
  const b = stats[T[tried]];
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return { label, value: b > 0 ? `${a}/${b} (${Math.round((a / b) * 100)}%)` : `${a}/${b}` };
};
const xg = value => value.toFixed(2);

const MATCH_GROUPS = [
  ["Attack", [one("Goals", "goals"), one("Assists", "assists"), one("xG", "xg", xg), pair("Shots on target", "onTarget", "shots"), one("Big chances created", "bigChances"), one("Key passes", "keyPasses"), pair("Dribbles", "dribbles", "dribbleAttempts")]],
  ["Passing", [pair("Passes", "accuratePasses", "passes"), one("Final third passes", "finalThird"), pair("Crosses", "accurateCrosses", "crosses"), pair("Long balls", "longBallsWon", "longBalls")]],
  ["Defending", [pair("Tackles won", "tacklesWon", "tackles"), one("Interceptions", "interceptions"), one("Clearances", "clearances"), one("Recoveries", "recoveries"), pair("Duels won", "duelsWon", "duels"), pair("Aerials won", "aerialsWon", "aerials")]],
  ["Goalkeeping", [one("Saves", "saves"), one("Saves inside the box", "savesInBox"), one("Goals conceded", "conceded")]],
  ["Other", [one("Fouls", "fouls"), one("Fouled", "fouled"), one("Possession lost", "possessionLost")]],
];

const SEASON_ROWS = [
  one("Appearances", "appearances"), one("Starts", "starts"), one("Minutes", "minutes"), one("Goals", "goals"),
  one("Assists", "assists"), one("Average rating", "rating", value => value.toFixed(2)),
  pair("Shots on target", "onTarget", "shots"), one("Key passes", "keyPasses"), pair("Passes", "accuratePasses", "passes"),
  pair("Dribbles", "dribbles", "dribbleAttempts"), one("Tackles", "tackles"), one("Interceptions", "interceptions"),
  one("Saves", "saves"), one("Clean sheets", "cleanSheets"), one("Yellow cards", "yellow"), one("Red cards", "red"),
];

// [{ title, rows: [{ label, value }] }], empty groups dropped. Goalkeeping
// only for a keeper, so an outfielder's "Goals conceded" (his team's) does
// not read as his own.
export function matchStatGroups(stats, { keeper = false } = {}) {
  if (!stats) return [];
  return MATCH_GROUPS
    .filter(([title]) => title !== "Goalkeeping" || keeper)
    .map(([title, rows]) => ({ title, rows: rows.map(row => row(stats)).filter(Boolean) }))
    .filter(group => group.rows.length);
}

export function seasonStatRows(stats, { keeper = false } = {}) {
  if (!stats) return [];
  return SEASON_ROWS.map(row => row(stats)).filter(Boolean)
    .filter(row => keeper || (row.label !== "Saves" && row.label !== "Clean sheets"));
}

export function matchHeadline(stats) {
  if (!stats) return { rating: null, minutes: null };
  return {
    rating: Number.isFinite(stats[T.rating]) ? stats[T.rating] : null,
    minutes: Number.isFinite(stats[T.minutes]) ? stats[T.minutes] : null,
  };
}

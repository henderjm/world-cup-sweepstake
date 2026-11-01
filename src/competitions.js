// Per-competition display config. Zones drive the coloured bands on league tables:
// data, not hardcoded position checks, so a 20-team league and a 36-team league
// phase can share one renderer. `from`/`to` are 1-based table positions, inclusive.
export const COMPETITIONS = {
  PL: {
    code: "PL",
    apiFootballLeagueId: 39,
    name: "Premier League",
    shortName: "Premier League",
    zones: [
      { from: 1, to: 5, tone: "safe", label: "European places" },
      { from: 18, to: 20, tone: "out", label: "Relegation" },
    ],
  },
  CL: {
    code: "CL",
    apiFootballLeagueId: 2,
    name: "UEFA Champions League",
    shortName: "Champions League",
    standingsStages: ["LEAGUE_STAGE", "GROUP_STAGE"],
    zones: [
      { from: 1, to: 8, tone: "safe", label: "Round of 16" },
      { from: 9, to: 24, tone: "edge", label: "Knockout play-offs" },
      { from: 25, to: 36, tone: "out", label: "Eliminated" },
    ],
  },
  // Served by Sportmonks end to end (src/sportmonksFeed.js,
  // worker/sportmonksLive.js), not API-Football: adding them to the
  // API-Football collector would have cost about two more Premier Leagues of
  // calls a weekend against a 7,500 daily cap that the Premier League and
  // fantasy depend on. Their match ids are offset (SPORTMONKS_ID_OFFSET).
  SA: {
    code: "SA",
    provider: "sportmonks",
    sportmonksLeagueId: 384,
    name: "Serie A",
    shortName: "Serie A",
    zones: [
      { from: 1, to: 4, tone: "safe", label: "Champions League" },
      { from: 5, to: 6, tone: "edge", label: "Europa and Conference League" },
      { from: 18, to: 20, tone: "out", label: "Relegation" },
    ],
  },
  PD: {
    code: "PD",
    provider: "sportmonks",
    sportmonksLeagueId: 564,
    name: "La Liga",
    shortName: "La Liga",
    zones: [
      { from: 1, to: 4, tone: "safe", label: "Champions League" },
      { from: 5, to: 6, tone: "edge", label: "Europa and Conference League" },
      { from: 18, to: 20, tone: "out", label: "Relegation" },
    ],
  },
};

// The competitions Sportmonks serves on its own, in display order.
export const SPORTMONKS_COMPETITION_CODES = Object.keys(COMPETITIONS).filter(code => COMPETITIONS[code].provider === "sportmonks");

// The competitions the switcher offers, in display order. The first is the default
// for new visitors and for legacy unprefixed data paths.
export const COMPETITION_CODES = Object.keys(COMPETITIONS);
export const DEFAULT_COMPETITION_CODE = COMPETITION_CODES[0];

const DEFAULT_COMPETITION = { code: "", name: "League", shortName: "League", zones: [] };

export function competitionFor(code) {
  return COMPETITIONS[code] ?? { ...DEFAULT_COMPETITION, code: code ?? "" };
}

export function zoneFor(position, zones) {
  if (!Number.isFinite(position)) return null;
  return (zones ?? []).find((zone) => position >= zone.from && position <= zone.to) ?? null;
}

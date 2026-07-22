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
    zones: [
      { from: 1, to: 8, tone: "safe", label: "Round of 16" },
      { from: 9, to: 24, tone: "edge", label: "Knockout play-offs" },
      { from: 25, to: 36, tone: "out", label: "Eliminated" },
    ],
  },
};

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

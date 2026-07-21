// Per-competition display config. Zones drive the coloured bands on league tables:
// data, not hardcoded position checks, so a 20-team league and a 36-team league
// phase can share one renderer. `from`/`to` are 1-based table positions, inclusive.
export const COMPETITIONS = {
  PL: {
    code: "PL",
    name: "Premier League",
    zones: [
      { from: 1, to: 5, tone: "safe", label: "European places" },
      { from: 18, to: 20, tone: "out", label: "Relegation" },
    ],
  },
};

const DEFAULT_COMPETITION = { code: "", name: "League", zones: [] };

export function competitionFor(code) {
  return COMPETITIONS[code] ?? { ...DEFAULT_COMPETITION, code: code ?? "" };
}

export function zoneFor(position, zones) {
  if (!Number.isFinite(position)) return null;
  return (zones ?? []).find((zone) => position >= zone.from && position <= zone.to) ?? null;
}

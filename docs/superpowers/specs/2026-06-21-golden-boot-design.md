# Golden Boot: design

Date: 2026-06-21
Status: approved, ready to plan

## Goal

Add a Golden Boot tab to the World Cup sweepstake hub: a ranked board of the
tournament's top scorers, each tagged with their team and the team's sweepstake owner,
consistent with the owner-tagging used across the rest of the app. The board ranks by
goal involvements (goals + assists) by default, with a toggle to rank by pure goals.

## Key constraint that drives the design

Goalscorer data is not in the main feed. The live payload (`data/live.json` and the
Worker's `/live`) carries only match scores. Scorer and assist names exist only in the
per-match detail files (`data/matches/<id>.json`, produced by `mapMatchDetail`), which
today are fetched lazily, one at a time, when a match drawer is opened. A Golden Boot
board needs goals aggregated across every match, so the aggregation has to happen
somewhere new.

Decision: aggregate at build time. The fetch script already pulls every relevant
match's detail in a throttled loop, so it can tally all detail on disk and emit a small
`data/scorers.json` with zero extra football-data calls. The browser loads that one
file alongside the live feed. The tradeoff is cadence: the board refreshes on the
5-minute GitHub Action schedule, not instantly. During a live match the score updates
within ~30s via the Worker, but a newly scored goal appears on the board up to 5 minutes
later. That is acceptable for a top-scorer race.

Rejected alternatives: client-side aggregation (fetch every finished match's detail on
tab open, up to ~104 requests per visit, slow load) and a Worker `/scorers` endpoint
(would hit football-data ~100 times per cache miss, blowing the 30/min plan limit).

## Counting rules

- A goal counts toward a player when the goal `type` is `REGULAR` or `PENALTY` (an
  in-play penalty kick).
- Own goals (`type === "OWN"`) credit nobody: excluded from both goals and assists.
- Penalty-shootout kicks do not count. football-data records shootouts in
  `score.penalties`, not as `goals[]` events, so they are naturally absent. The
  aggregator also drops any goal whose `type` indicates a shootout (for example
  `PENALTY_SHOOTOUT`) so a future knockout payload cannot leak shootout kicks in.
- An assist counts when a counted goal carries a non-null `assist`.
- Ranking metric is points = goals + assists. Default sort: points desc, then goals
  desc, then player name asc. The Goals toggle sorts: goals desc, then assists desc,
  then player name asc.
- Every WC 2026 team (48) is owned in the sweepstake, so every scorer resolves to an
  owner. Owner resolution is defensive (falls back to "Unowned") but should not trigger.

## Components

### `src/scorers.js` (new, pure, no DOM, no entrant config)

`aggregateScorers(matchDetails)` takes an array of mapped match-detail objects (the
shape `mapMatchDetail` produces) and returns a sorted array:

```
[{ player, team, goals, assists, points }]
```

- Iterate each detail's `goals[]`. For each counted goal: add 1 goal to the scorer and,
  if an assist is present, add 1 assist to the assister. Both are credited to the
  goal's `team`.
- Players are keyed by `player name + team` so a name collision across teams never
  merges. Team names pass through `normalizeTeamName`. Player names are kept exact and
  only whitespace-trimmed (unlike team names, they are not diacritic-folded), so
  "Julian Quinones" and "Kylian Mbappe" display with their real spelling.
- `points = goals + assists`. The function returns the array sorted in the default G+A
  order; the view re-sorts in place for the Goals toggle. Keep owner and flag lookups
  out of this module; the view layer adds them.

This mirrors how `domain.js` and `mapDetail.js` are shared between the Node fetch
script and the browser.

### Build step: `scripts/fetch-live-data.mjs`

After the existing per-match detail loop, read all `data/matches/*.json` from disk (so
the tally covers the whole tournament, not just the matches refreshed this run), call
`aggregateScorers`, and write `data/scorers.json`:

```json
{ "source": "football-data.org", "lastUpdated": "<iso>", "scorers": [ { "player": "", "team": "", "goals": 0, "assists": 0, "points": 0 } ] }
```

Written next to `live.json` each run and deployed with the site by the Pages workflow.
An initial `data/scorers.json`, generated from the current detail files, is committed so
the board works on the next deploy before the Action regenerates it.

### Client load: `src/data.js`

- `loadModel` runs `Promise.all([loadLiveData(), loadScorers()])`. `loadScorers()`
  fetches static `./data/scorers.json` (cache-busted); the Worker has no scorers
  endpoint, so this always reads the baked file.
- `buildModel` attaches `model.scorers` (the array, defaulting to `[]`).
- On fetch failure, `model.scorers = []`; the board shows an empty state and the rest of
  the app is unaffected.
- Existing polling re-runs `loadModel`, so the board refreshes on the current cadence.
  No new timer.

### UI: new Golden Boot tab

- `index.html`: add a `data-tab="goldenboot"` button labelled "Golden Boot" to the tab
  nav (after Fixtures).
- `src/app.js`: add `"goldenboot"` to `TABS`; `renderPanel` routes it to
  `renderGoldenBoot`. Add `goldenBootSort` to `state` (default `"ga"`), wired through
  the existing `[data-sort]`-style panel control handling with a distinct attribute so
  it does not collide with the leaderboard sort.
- `src/views.js`: `renderGoldenBoot(model, sortKey)` renders a ranked table: rank,
  player (team flag + player name + owner chip), G, A, and an emphasized G+A. A
  segmented G+A / Goals toggle reuses the `.seg-group` / `.seg` pattern. Empty state
  ("No goals yet.") when `model.scorers` is empty, plus a one-line note that penalties
  count and own goals and shootouts do not, and that the board updates every few
  minutes.
- `src/styles.css`: reuse `.table-wrap` and leaderboard table styling; add minimal
  Golden-Boot-specific rules only as needed.

No per-owner rollup: the board is the individual scorer list with per-row owner chips.

## Error handling and edge cases

- `data/scorers.json` missing or unparseable: empty board, app unaffected.
- Own goals: excluded from goals and assists.
- Penalty shootouts: excluded by type and naturally absent from `goals[]`.
- Accented player names: rendered as-is and HTML-escaped via the existing `esc` helper.
- A scorer on an unowned team (should not occur in WC 2026): owner chip falls back to
  "Unowned".

## Testing and verification

The repo has no test runner, so verify by:

- `node --check` on every edited module.
- Run `aggregateScorers` against the real `data/matches/*.json` and confirm the top of
  the board matches a hand count (for example Messi 3 goals in the current snapshot).
- Render `renderGoldenBoot` against a built model and confirm ranking, the Goals toggle
  re-sort, and owner chips.
- Confirm the app still boots and the other tabs render when `data/scorers.json` is
  absent.

## Out of scope

- Live (sub-5-minute) scorer updates.
- Per-owner goal rollups or aggregate-contribution framing.
- Assist-only or minutes-played tiebreakers beyond the goals/assists/name ordering
  above.
- Any change to the existing match-detail drawer.

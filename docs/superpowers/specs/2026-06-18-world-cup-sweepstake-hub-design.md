# World Cup Sweepstake Hub: design

Date: 2026-06-18
Status: approved, building

## Goal

Turn the sweepstake app into a FotMob / livescore-style hub: the single place the
group checks for everything World Cup, with the money race as the centerpiece. The
existing data pipeline and scoring logic are sound; this is a presentation and
forecasting overhaul, not a rewrite of the domain rules.

## The key reframe

The payouts are tied to specific tournament outcomes, not the points leaderboard:

- EUR 100 to the owner of the team that wins the final.
- EUR 30 to the owner of the losing finalist.
- EUR 30 to the owner of the worst team confirmed last in its group (all three group
  games played), chosen by the existing wooden-spoon comparator.

So "who is on for winning" means "whose team is on track to lift the trophy", not who
tops the points table. The points score stays as a live bragging-rights ranking.

## Aesthetic

FotMob-clean: dark, crisp cards, calm and data-dense, flag emoji on every team
(offline-safe, no broken crest images). No serif masthead, no fake-pitch graphic.

## Structure (single page, multi-section depth)

Always on screen at the top:

1. Live match ticker ribbon (owner-tagged scores).
2. The Race hero: who is on for the EUR 100, with the EUR 30 runner-up and EUR 30
   spoon races beside it.

Below, a segmented tab bar swaps a detail panel without leaving the hero:
Live & Today / Leaderboard / Group tables / Knockout bracket / Fixtures.

## The forecast (Monte Carlo)

Runs in-browser on load, ~5000 simulations, seeded RNG (seed derived from the data
timestamp) so percentages are stable between reloads.

1. Simulate remaining group matches as Poisson scorelines from a team-strength rating
   (seeded favorite prior, adjusted by tournament goal data so far).
2. Build final group tables, pick the 32 qualifiers (top 2 per group + 8 best thirds).
3. Simulate the knockout to a champion and runner-up, applying the existing stage
   bonuses to the points projection.
4. Aggregate per entrant: P(win EUR 100), P(runner-up EUR 30), P(spoon EUR 30),
   projected final points, expected winnings, and a momentum signal.

Honesty: the 2026 knockout pairings are not in the data feed (all knockout slots are
"Unknown"), so the sim uses a strength-seeded generic bracket and the UI labels these
numbers as a projection, with a short "how this works" note.

## Extras

- Live match ticker (top ribbon).
- Owner head-to-head: pick two entrants, compare teams, points, win/spoon odds,
  remaining fixtures.
- Celebration moments: confetti when an owned team scores live or a final is decided,
  plus a "biggest mover" callout.
- Knockout bracket: 32-to-final, owner-tagged, fills in as results land.

## Code shape

Keep the static, no-build setup and `domain.js` scoring. Preserve the Sentry
instrumentation already added. Split the work into focused modules:

- `domain.js` (kept; export stage bonuses + small helpers for reuse)
- `flags.js` team to flag emoji
- `format.js` money, dates, signed, stage and status labels
- `forecast.js` the Monte Carlo sim (pure, node-testable)
- `data.js` load and normalize live.json, owner maps, current standings and leaderboard
- `views.js` pure render-to-markup functions per section
- `interactions.js` tab nav, head-to-head modal, confetti
- `app.js` thin orchestrator: load, simulate, render, wire

## Verification

- Node sanity-check `forecast.js`: probabilities per prize sum to ~100 percent across
  entrants, output deterministic for a fixed seed, every tournament team owned.
- `node --check` every module. Serve locally and confirm the page renders with the
  committed `data/live.json`.

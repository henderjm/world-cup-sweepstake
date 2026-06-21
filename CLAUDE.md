# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A static, no-build World Cup sweepstake hub (FotMob-style live scores, group tables, knockout bracket, fixtures) where the centerpiece is a Monte Carlo projection of who is on for the prize money. Hosted on GitHub Pages. `index.html` is the entry point and the app also runs from any static host or by opening the file directly. Plain ES modules and vanilla DOM, no framework, no bundler, no TypeScript.

See `README.md` for hosting/deploy steps and `docs/superpowers/specs/2026-06-18-world-cup-sweepstake-hub-design.md` for the full design and projection methodology.

## Commands

- `npm run fetch:live` runs `scripts/fetch-live-data.mjs`: pulls football-data.org and writes `data/live.json` plus per-match detail under `data/matches/`. Needs `FOOTBALL_DATA_TOKEN` in the environment (no-ops without it). Optional `FOOTBALL_DATA_COMPETITION` (default `WC`), `FOOTBALL_DATA_SEASON` (default `2026`).
- Worker (in `worker/`): `npx wrangler login`, `npx wrangler secret put FOOTBALL_DATA_TOKEN`, `npx wrangler deploy`. Needs Wrangler 4.36.0+ for the `unsafe.bindings` rate-limit syntax.
- No build, lint, or test setup. The `test/` directory is empty and `package.json` has no test script. To preview locally, serve the root over http (the worker CORS allowlist includes `http://localhost:8731` / `http://127.0.0.1:8731`) so `fetch` of `data/live.json` works.

## Data flow

`index.html` loads `src/app.js`, which calls `loadModel()` (`src/data.js`). That fetches raw data, then `buildModel(raw)` turns it into the single `model` object every view reads. Render functions in `src/views.js` return HTML strings that `app.js` assigns via `innerHTML`. This is the rendering convention throughout: build a string, set `innerHTML`, then wire event listeners with delegation on the container.

Two delivery paths for the same raw shape (`{ source, lastUpdated, matches, standings }`):

1. Cloudflare Worker (`worker/worker.js`) proxies football-data.org with the API token kept server-side and edge-caches each upstream call, so many pollers collapse into roughly one upstream call per window (the 30/min plan limit). The site polls it live.
2. GitHub Action (`.github/workflows/pages.yml`, cron `*/5`) bakes `data/live.json` into each deploy as the static fallback.

`src/data.js` picks the source: it tries the `DATA_API` Worker origin first and falls back to static `data/live.json` if `DATA_API` is empty or the Worker is unreachable. `DATA_API` is a hardcoded constant at the top of `src/data.js`; point it at your deployed Worker or set it to `""` to use only the baked data.

Live updates without a deploy: `app.js` re-runs `loadModel()` on a timer (20s while a match is live, 60s otherwise) and only re-renders when a match signature (id/status/score/minute) actually changes.

## Architecture invariants (read before editing scoring, forecast, or teams)

- **The team-score formula is duplicated and must stay in sync.** `calculateTeamScore` in `src/domain.js` (`points*10 + goalDifference*2 + goalsFor + stageBonus`) and the projected-score line in `src/forecast.js` (`record.points*10 + goalDifference*2 + goalsFor + bonus`) must match, or the live leaderboard and the projection diverge. `STAGE_BONUSES` lives in `domain.js` and is imported by `forecast.js`; keep it the single source of bonus values.

- **Team names flow through `normalizeTeamName` (`src/domain.js`) everywhere.** It strips diacritics and maps aliases (`TEAM_ALIASES`) to one canonical name. The canonical name is the join key across `ENTRANTS` (`src/data.js`), `FLAGS` (`src/flags.js`), and `RATINGS` (`src/forecast.js`). Adding or renaming a team means updating all of these to the same canonical string, plus an alias entry if the feed spells it differently.

- **`ENTRANTS`, the pot, and the payout split are hardcoded in `src/data.js`** (16 entrants x EUR 10 = EUR 160 pot; EUR 100 winner / EUR 30 runner-up / EUR 30 wooden spoon). `OWNER_BY_TEAM` / `ownerOf` derive from `ENTRANTS`.

- **Prizes track outcomes, not the points table.** The winner/runner-up come from the actual `FINAL` result; the wooden spoon only resolves once a team is confirmed last in its group with all three group games finished (`isConfirmedGroupLast` in `data.js`). The points leaderboard is bragging rights only.

- **The forecast is a projection, not the real draw.** The feed never carries real 2026 knockout pairings (every knockout slot is "Unknown"), so `runForecast` simulates remaining group games into final tables, takes the 32 qualifiers, and runs a generic strength-seeded bracket. It is seeded from `lastUpdated` (`seedFrom`) so the odds are stable across reloads of the same data. Surface it as a projection in the UI.

- **`mapFootballDataMatches` (`src/domain.js`) and `mapMatchDetail` (`src/mapDetail.js`) are a cross-environment contract.** Both the Worker and the Node fetch script import them from `../src/`, so the Worker and the baked JSON produce identical shapes. Edits affect both runtimes. football-data.org provides no xG on any tier, so match detail has lineups/scorers/subs/cards but never xG.

## Module map (`src/`)

- `app.js` orchestration: boot, tab routing via hash, polling, event delegation, Sentry telemetry helpers.
- `data.js` data loading, `buildModel`, entrants/pot config, prize and wooden-spoon resolution.
- `domain.js` pure scoring/standings logic, team-name normalization, stage bonuses.
- `forecast.js` Monte Carlo projection (seeded RNG, Poisson scorelines, seeded bracket).
- `views.js` HTML-string renderers (ticker, hero, leaderboard, tables, bracket, fixtures, footer).
- `format.js` pure formatters and live/finished status helpers (no DOM).
- `flags.js` flag emoji by canonical team name (emoji, not crest images, so nothing renders broken offline).
- `interactions.js` head-to-head modal, confetti, celebration banner.
- `matchDetail.js` match drawer; fetches per-match detail on open (Worker `/match/:id` or static `data/matches/<id>.json`).
- `background.js` ambient bunting/embers layer (DOM + CSS only).

## Telemetry and the Sentry tunnel

Sentry is vendored first-party (`vendor/sentry.min.js`) and events are tunnelled through the Worker's `/tunnel` route so tracker blockers that block the Sentry ingest domain cannot drop them. The DSN/host/project in `index.html`, the `SENTRY_HOST`/`SENTRY_PROJECT` allow-check in `worker/worker.js`, and the `tunnel:` URL must all reference the same deployed Worker and Sentry project. All telemetry calls in `app.js` are wrapped so a blocked or absent Sentry never throws.

When changing the deployed origins, keep `ALLOWED_ORIGINS` (worker CORS) and the GitHub Pages URL aligned.

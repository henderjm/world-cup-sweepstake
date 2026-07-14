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

- **The forecast is a projection, not the real draw.** The feed never carries the knockout *pairings* (every slot is "Unknown"), so `runForecast` simulates remaining group games into final tables, takes the 32 qualifiers, and slots them into the real fixed 2026 knockout bracket encoded in `src/bracket.js` (`seedR32`, `R16`/`QF`/`SF`/`FINAL`, FIFA match numbers 73 to 104). It is seeded from `lastUpdated` (`seedFrom`) so the odds are stable across reloads of the same data. Surface it as a projection in the UI.

- **`mapFootballDataMatches` (`src/domain.js`) and `mapMatchDetail` (`src/mapDetail.js`) are a cross-environment contract.** Both the Worker and the Node fetch script import them from `../src/`, so the Worker and the baked JSON produce identical shapes. Edits affect both runtimes. football-data.org provides no xG on any tier, so match detail has lineups/scorers/subs/cards but never xG.

- **AI match analysis is cron-generated in the Worker, never on user visits.** A 10-minute cron trigger (`[triggers]` in wrangler.toml, `scheduled` handler in worker/worker.js) checks the feed and writes one Claude analysis per live match, plus a full-time read within 48 hours of the whistle, into the `ANALYSIS_CACHE` KV under `analysis:latest:<id>`. `analysisCacheSignature` (score/status/pens/10-minute clock bucket) decides whether a tick regenerates. `GET /analysis/:id` is a pure KV read; the prompt is built server-side via the pure shared module `src/analysisPrompt.js` (owners, leaderboard, prizes, knockout context), so browsers can never trigger an Anthropic call. Requires the `ANTHROPIC_API_KEY` secret and the `ANALYSIS_CACHE` KV binding; missing either means no analyses and `matchDetail.js` hides the card. Model comes from the `ANTHROPIC_MODEL` var (default `claude-sonnet-5`; overrides must support adaptive thinking and structured outputs). The Worker depends on `@anthropic-ai/sdk` (the repo's only npm dependency) and `wrangler.toml` needs `compatibility_flags = ["nodejs_compat"]` for it.

- **Scorer data is not in the live feed; the Golden Boot is aggregated at build time.** Goals and assists exist only in per-match detail (`data/matches/<id>.json`). `scripts/fetch-live-data.mjs` tallies every detail file on disk through the shared pure `aggregateScorers` (`src/scorers.js`) into `data/scorers.json`, which the client loads separately from the live feed (`loadModel` fetches both in parallel; the Worker has no scorers endpoint). It refreshes on the 5-min Action cadence, not live. General pattern: when the live feed lacks a datum that match detail carries, aggregate it at build time into its own static JSON and load it client-side in parallel.

## Module map (`src/`)

- `app.js` orchestration: boot, tab routing via hash, polling, event delegation, Sentry telemetry helpers.
- `data.js` data loading (`loadModel` fetches the live feed and `data/scorers.json` in parallel), `buildModel(raw, scorerData)`, entrants/pot config, prize and wooden-spoon resolution.
- `domain.js` pure scoring/standings logic, team-name normalization, stage bonuses.
- `forecast.js` Monte Carlo projection (seeded RNG, Poisson scorelines). Runs off the main thread via `forecast.worker.js` for the What-if explorer, with an inline fallback.
- `forecast.worker.js` ES-module Web Worker that runs `runForecast` off-thread (What-if recompute on each pin change); `app.js` falls back to inline if module workers are unavailable.
- `bracket.js` the real fixed 2026 knockout structure (R32 to final, group-position feeds), encoded so the forecast seeds the real bracket instead of a generic one.
- `scorers.js` pure Golden Boot aggregation (`aggregateScorers`, `compareByInvolvements`, `compareByGoals`); shared by the fetch script and the browser.
- `analysisPrompt.js` pure AI-analysis prompt builder (system prompt, JSON schema, per-match payload with sweepstake context); imported by the Worker only, same cross-environment contract as `mapFootballDataMatches`.
- `views.js` HTML-string renderers (ticker, hero, leaderboard, tables, bracket, what-if, fixtures, Golden Boot, footer).
- `format.js` pure formatters and live/finished status helpers (no DOM).
- `flags.js` flag emoji by canonical team name (emoji, not crest images, so nothing renders broken offline).
- `interactions.js` head-to-head modal, confetti, celebration banner.
- `matchDetail.js` match drawer; fetches per-match detail on open (Worker `/match/:id` or static `data/matches/<id>.json`).
- `background.js` ambient bunting/embers layer (DOM + CSS only).

## Adding a tab or panel control

- **New tab:** add a `<button data-tab="x">` to the nav in `index.html`, add `"x"` to `TABS` in `src/app.js`, add a `case "x"` to `renderPanel`, and write `renderX` in `src/views.js`. Tabs route via the URL hash.
- **New in-panel control** (sort toggle, filter): give it a unique `data-*` attribute (not a shared one), keep its state in the `state` object in `app.js`, read it in the renderer, and handle it in `wirePanelControls` (click delegation with an early `return` per handler; `change` for a `<select>`). Reuse the `.seg-group` / `.seg` segmented-toggle markup; see `data-sort` (leaderboard), `data-fixture-view` (fixtures), `data-gb-sort` (Golden Boot).

## Telemetry and the Sentry tunnel

Sentry is vendored first-party (`vendor/sentry.min.js`) and events are tunnelled through the Worker's `/tunnel` route so tracker blockers that block the Sentry ingest domain cannot drop them. The DSN/host/project in `index.html`, the `SENTRY_HOST`/`SENTRY_PROJECT` allow-check in `worker/worker.js`, and the `tunnel:` URL must all reference the same deployed Worker and Sentry project. All telemetry calls in `app.js` are wrapped so a blocked or absent Sentry never throws.

When changing the deployed origins, keep `ALLOWED_ORIGINS` (worker CORS) and the GitHub Pages URL aligned.

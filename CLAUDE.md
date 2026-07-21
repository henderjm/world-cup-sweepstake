# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A static, no-build football tracker (FotMob-style live scores, league table, fixtures, Golden Boot) currently covering the Premier League, with Champions League and the other European cups on the roadmap, followed by user sign-up, push notifications and a fantasy draft. Hosted on GitHub Pages. `index.html` is the entry point and the app also runs from any static host or by opening the file directly. Plain ES modules and vanilla DOM, no framework, no bundler, no TypeScript.

The app began as a World Cup 2026 sweepstake hub; the sweepstake (entrants, pot, prizes, Monte Carlo projection) was removed after the tournament. See `README.md` for hosting/deploy steps.

## Commands

- `npm run fetch:live` runs `scripts/fetch-live-data.mjs`: pulls football-data.org and writes `data/live.json` plus per-match detail under `data/matches/`. Needs `FOOTBALL_DATA_TOKEN` in the environment (no-ops without it). Optional `FOOTBALL_DATA_COMPETITION` (default `PL`), `FOOTBALL_DATA_SEASON` (default `2026`; football-data's starting year, so 2026 = the 2026-27 season).
- Worker (in `worker/`): `npx wrangler login`, `npx wrangler secret put FOOTBALL_DATA_TOKEN`, `npx wrangler deploy`. Needs Wrangler 4.36.0+ for the `unsafe.bindings` rate-limit syntax.
- Tests: `node --test test/`. No build or lint setup. To preview locally, serve the root over http (the worker CORS allowlist includes `http://localhost:8731` / `http://127.0.0.1:8731`) so `fetch` of `data/live.json` works.

## Data flow

`index.html` loads `src/app.js`, which calls `loadModel()` (`src/data.js`). That fetches raw data, then `buildModel(raw)` turns it into the single `model` object every view reads. Render functions in `src/views.js` return HTML strings that `app.js` assigns via `innerHTML`. This is the rendering convention throughout: build a string, set `innerHTML`, then wire event listeners with delegation on the container.

Two delivery paths for the same raw shape (`{ source, lastUpdated, competition, season, matches, standings }`):

1. Cloudflare Worker (`worker/worker.js`) proxies football-data.org with the API token kept server-side and edge-caches each upstream call, so many pollers collapse into roughly one upstream call per window. The site polls it live.
2. GitHub Action (`.github/workflows/pages.yml`, cron `*/5`) bakes `data/live.json` into each deploy as the static fallback.

`src/data.js` picks the source: it tries the `DATA_API` Worker origin first and falls back to static `data/live.json` if `DATA_API` is empty or the Worker is unreachable. `DATA_API` is a hardcoded constant at the top of `src/data.js`; point it at your deployed Worker or set it to `""` to use only the baked data.

Live updates without a deploy: `app.js` re-runs `loadModel()` on a timer (20s while a match is live, 60s otherwise) and only re-renders when a match signature (id/status/score/minute) actually changes.

## Architecture invariants (read before editing mapping, standings, or teams)

- **The canonical team name is the feed's `shortName`, via `normalizeTeamName` (`src/domain.js`).** Both match mappers prefer `shortName` over `name`, and `mapMatchDetail` resolves event team names (goals/cards/subs carry only the legal name) through the two sides so every event matches the join key. The canonical name is the join key across standings, the crest registry (`src/badges.js`), and the Golden Boot. `TEAM_ALIASES` in `domain.js` exists for sources that spell a club differently.

- **Team badges are feed-served crest images, not emoji.** `mapFootballDataMatches` and `mapFootballDataStandings` carry `crest` URLs; `buildModel` registers them in `src/badges.js` (`registerCrests`), and `badgeFor(team)` returns an `<img class="crest">` or a neutral-ball fallback. Never hardcode team images.

- **Table zones are per-competition config, not hardcoded positions.** `src/competitions.js` maps competition code → `{ name, zones: [{ from, to, tone, label }] }` (PL: 1–5 European places, 18–20 relegation). `zoneFor(position, zones)` stamps standings rows and table rows; renderers colour by `zone.tone` (`safe`/`edge`/`out`). Adding a competition means adding its config entry here, not touching renderers. The feed's `competition` field (baked into `live.json` by both delivery paths) selects the config in `buildModel`.

- **`mapFootballDataMatches` (`src/domain.js`) and `mapMatchDetail` (`src/mapDetail.js`) are a cross-environment contract.** The Worker, the Node fetch script, and the browser all import them from `src/`, so the Worker and the baked JSON produce identical shapes. Edits affect all three runtimes. football-data.org provides no xG on any tier, so match detail has lineups/scorers/subs/cards but never xG.

- **AI match analysis is cron-generated in the Worker, never on user visits.** A one-minute cron trigger (`[triggers]` in wrangler.toml, `scheduled` handler in worker/worker.js) checks the feed and writes one Claude analysis per live match, plus a full-time read within 48 hours of the whistle, into the `ANALYSIS_CACHE` KV under `analysis:latest:<id>`. `analysisCacheSignature` plus `analysisEventSignature` (red cards, from match detail) decide which ticks regenerate: goal, red card, penalty and status changes immediately, otherwise 10-minute clock buckets in normal play, 5-minute buckets in extra time, and penalty-score changes during a shootout. `GET /analysis/:id` is a pure KV read; the prompt is built server-side via the pure shared module `src/analysisPrompt.js` (league table context, zones, form), so browsers can never trigger an Anthropic call. The schema fields are `{ headline, match, context }`; bump `ANALYSIS_PROMPT_VERSION` when the prompt or shape changes meaningfully. Requires the `ANTHROPIC_API_KEY` secret and the `ANALYSIS_CACHE` KV binding; missing either means no analyses and `matchDetail.js` hides the card. Model comes from the `ANTHROPIC_MODEL` var (default `claude-sonnet-5`; overrides must support adaptive thinking and structured outputs). The Worker depends on `@anthropic-ai/sdk` (the repo's only npm dependency) and `wrangler.toml` needs `compatibility_flags = ["nodejs_compat"]` for it.

- **Scorer data is not in the live feed; the Golden Boot is aggregated at build time.** Goals and assists exist only in per-match detail (`data/matches/<id>.json`). `scripts/fetch-live-data.mjs` tallies every detail file on disk through the shared pure `aggregateScorers` (`src/scorers.js`) into `data/scorers.json`, which the client loads separately from the live feed (`loadModel` fetches both in parallel; the Worker has no scorers endpoint). It refreshes on the 5-min Action cadence, not live. Because the tally scans the whole `data/matches/` directory, that directory must only ever hold one competition+season's files; changing competition or season means clearing it (and the Action's cache key, `pl-2026-match-detail-`). General pattern: when the live feed lacks a datum that match detail carries, aggregate it at build time into its own static JSON and load it client-side in parallel.

## Module map (`src/`)

- `app.js` orchestration: boot, tab routing via hash, polling, event delegation, Sentry telemetry helpers.
- `data.js` data loading (`loadModel` fetches the live feed and `data/scorers.json` in parallel), `buildModel(raw, scorerData)` (league tables, standings, crest registration).
- `domain.js` pure mapping/standings logic, team-name normalization, per-team performance/form.
- `competitions.js` per-competition config (name, table zone bands) and `zoneFor`.
- `badges.js` club crest registry (`registerCrests`, `badgeFor`); crest URLs come from the feed.
- `scorers.js` pure Golden Boot aggregation (`aggregateScorers`, `compareByInvolvements`, `compareByGoals`); shared by the fetch script and the browser.
- `analysisPrompt.js` pure AI-analysis prompt builder (system prompt, JSON schema, per-match payload with league context); imported by the Worker only, same cross-environment contract as `mapFootballDataMatches`.
- `views.js` HTML-string renderers (ticker, hero header, league table, fixtures, Golden Boot, footer).
- `format.js` pure formatters and live/finished status helpers (no DOM).
- `interactions.js` `confettiBurst` (currently unwired; kept for celebration moments).
- `matchDetail.js` match drawer; fetches per-match detail on open (Worker `/match/:id` or static `data/matches/<id>.json`); Table tab shows both sides' position, form, and the league table.
- `banter.js` shared per-match reactions and messages (Worker KV backed).
- `paperRun*.js` the Paper Run daily mini-game (model, API, view, game loop).
- `background.js` ambient bunting/embers layer (DOM + CSS only).
- `locations.js` venue → city/map-link lookup; `mapDetail.js` match-detail mapping.

## Adding a tab or panel control

- **New tab:** add a `<button data-tab="x">` to the nav in `index.html`, add `"x"` to `TABS` in `src/app.js`, add a `case "x"` to `renderPanel`, and write `renderX` in `src/views.js`. Tabs route via the URL hash.
- **New in-panel control** (sort toggle, filter): give it a unique `data-*` attribute (not a shared one), keep its state in the `state` object in `app.js`, read it in the renderer, and handle it in `wirePanelControls` (click delegation with an early `return` per handler; `change` for a `<select>`). Reuse the `.seg-group` / `.seg` segmented-toggle markup; see `data-fixture-view` (fixtures), `data-gb-sort` (Golden Boot).

## Telemetry and the Sentry tunnel

Sentry is vendored first-party (`vendor/sentry.min.js`) and events are tunnelled through the Worker's `/tunnel` route so tracker blockers that block the Sentry ingest domain cannot drop them. The DSN/host/project in `index.html`, the `SENTRY_HOST`/`SENTRY_PROJECT` allow-check in `worker/worker.js`, and the `tunnel:` URL must all reference the same deployed Worker and Sentry project. All telemetry calls in `app.js` are wrapped so a blocked or absent Sentry never throws.

When changing the deployed origins, keep `ALLOWED_ORIGINS` (worker CORS) and the GitHub Pages URL aligned.

## Roadmap (agreed phases)

1. ~~Phase 0: strip the sweepstake, single-competition PL tracker~~ (done)
2. Phase 1: multi-competition (namespace data/routes by competition code, competition switcher, Champions League league-phase config + display-only knockout bracket)
3. Phase 2: Google OAuth accounts on Cloudflare D1 (users, follows)
4. Phase 3: Web Push notifications (service worker + VAPID from the Worker cron)
5. Phase 4: fantasy H2H draft league; Europa/Conference (needs football-data €49 tier)

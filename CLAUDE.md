# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Squad Goals**: a static, no-build football tracker (FotMob-style live scores, league table, fixtures, player stats) covering the Premier League and the Champions League with a competition switcher, with the other European cups on the roadmap, followed by user sign-up, push notifications and a fantasy draft. Hosted on GitHub Pages. `index.html` is the entry point and the app also runs from any static host or by opening the file directly. Plain ES modules and vanilla DOM, no framework, no bundler, no TypeScript.

The UI implements the "Squad Goals" design (source of record: `docs/design/squad-goals.dc.html`, exported from the Claude Design project): navy `#0A0E14` background, lime `#C8F542` accent, Archivo with italic-uppercase display type, card surfaces `#12181F`. Sections are Scores and Paper Run (Play), with Fantasy and Profile present in the nav as inert "Soon" entries until their phases ship. Design tokens live at the top of `src/styles.css` and keep the pre-reskin custom-property names so carried-over components restyle automatically.

The app began as a World Cup 2026 sweepstake hub; the sweepstake (entrants, pot, prizes, Monte Carlo projection) was removed after the tournament. See `README.md` for hosting/deploy steps.

## Commands

- `npm run fetch:live` runs `scripts/fetch-live-data.mjs`: pulls football-data.org and writes `data/<comp>/live.json`, per-match detail under `data/<comp>/matches/`, and `data/<comp>/scorers.json`, for each configured competition. Needs `FOOTBALL_DATA_TOKEN` in the environment (no-ops without it). `FOOTBALL_DATA_COMPETITIONS` is a comma list of `CODE:season` pairs (default `PL:2026`; the season is football-data's starting year, so 2026 = the 2026-27 season). The first competition is the default and is also written to the legacy unnamespaced `data/live.json`/`data/scorers.json` for cached clients.
- Worker (in `worker/`): `npx wrangler login`, `npx wrangler secret put FOOTBALL_DATA_TOKEN`, `npx wrangler deploy`. Needs Wrangler 4.36.0+ for the `unsafe.bindings` rate-limit syntax.
- Tests: `node --test test/`. No build or lint setup. To preview locally, serve the root over http (the worker CORS allowlist includes `http://localhost:8731` / `http://127.0.0.1:8731`) so `fetch` of `data/live.json` works.

## Data flow

`index.html` loads `src/app.js`, which calls `loadModel()` (`src/data.js`). That fetches raw data, then `buildModel(raw)` turns it into the single `model` object every view reads. Render functions in `src/views.js` return HTML strings that `app.js` assigns via `innerHTML`. This is the rendering convention throughout: build a string, set `innerHTML`, then wire event listeners with delegation on the container.

Two delivery paths for the same raw shape (`{ source, lastUpdated, competition, season, matches, standings }`):

1. Cloudflare Worker (`worker/worker.js`) proxies football-data.org with the API token kept server-side and edge-caches each upstream call, so many pollers collapse into roughly one upstream call per window. The site polls it live.
2. GitHub Action (`.github/workflows/pages.yml`, cron `*/5`) bakes `data/live.json` into each deploy as the static fallback.

`src/data.js` picks the source: `loadModel(comp)` tries the `DATA_API` Worker origin first (`/:comp/live`) and falls back to static `data/<comp>/live.json` if `DATA_API` is empty or the Worker is unreachable. `DATA_API` is a hardcoded constant at the top of `src/data.js`; point it at your deployed Worker or set it to `""` to use only the baked data. The active competition is chosen by the hero switcher and persisted in localStorage (`gs-competition`); match-scoped routes (`/match/:id`, `/analysis/:id`, `/banter/:id`) carry no competition segment because football-data match ids are globally unique, and the Worker validates them against the union of configured competitions.

Live updates without a deploy: `app.js` re-runs `loadModel()` on a timer (20s while a match is live, 60s otherwise) and only re-renders when a match signature (id/status/score/minute) actually changes.

## Architecture invariants (read before editing mapping, standings, or teams)

- **The canonical team name is the feed's `shortName`, via `normalizeTeamName` (`src/domain.js`).** Both match mappers prefer `shortName` over `name`, and `mapMatchDetail` resolves event team names (goals/cards/subs carry only the legal name) through the two sides so every event matches the join key. The canonical name is the join key across standings, the crest registry (`src/badges.js`), and the Golden Boot. `TEAM_ALIASES` in `domain.js` exists for sources that spell a club differently.

- **Team badges prefer a self-hosted crest, then the feed's crest, then a TLA ring.** `badgeFor(team, size)` in `src/badges.js` checks `LOCAL_CRESTS` (a hardcoded canonical-name → `assets/crests/*.png` map) first, then the feed-registered crest from `registerTeams`, then falls back to the club's TLA on a name-hashed colour ring. `abbrFor(team)` is the text form (ticker, drawer timeline sides) and is never hardcoded. `LOCAL_CRESTS` is a deliberate, narrow exception, added to swap in LiveScore's crest artwork (`storage.livescore.com`, "high" tier, 64×64 — note this is *lower* native resolution than football-data's own 200×200 crests already in the feed, so this was a style choice, not a quality upgrade) for the current 20 Premier League teams. LiveScore has no per-team API, so those crests were downloaded once and committed to `assets/crests/` rather than hotlinked at runtime. Anything not in `LOCAL_CRESTS` (new promotions, other competitions) still flows entirely from the feed with no code change; keep it that way rather than growing this map by hand as competitions expand.

- **Table zones are per-competition config, not hardcoded positions.** `src/competitions.js` maps competition code → `{ name, shortName, zones: [{ from, to, tone, label }] }` (PL: 1–5 European places, 18–20 relegation; CL league phase: 1–8 direct, 9–24 play-offs, 25–36 out). `zoneFor(position, zones)` stamps standings rows and table rows; renderers colour by `zone.tone` (`safe`/`edge`/`out`). Adding a competition means adding its config entry here (plus the Worker/Action `FOOTBALL_DATA_COMPETITIONS` lists), not touching renderers. The feed's `competition` field (baked into `live.json` by both delivery paths) selects the config in `buildModel`. The Knockout tab exists only when a competition has non-league-stage matches (`knockoutMatches` in `views.js`); it is a display-only, stage-grouped list of real fixtures, no seeding.

- **`mapFootballDataMatches` (`src/domain.js`) and `mapMatchDetail` (`src/mapDetail.js`) are a cross-environment contract.** The Worker, the Node fetch script, and the browser all import them from `src/`, so the Worker and the baked JSON produce identical shapes. Edits affect all three runtimes. football-data.org provides no xG on any tier, so match detail has lineups/scorers/subs/cards but never xG.

- **AI match analysis is cron-generated in the Worker, never on user visits.** A one-minute cron trigger (`[triggers]` in wrangler.toml, `scheduled` handler in worker/worker.js) checks the feed and writes one Claude analysis per live match, plus a full-time read within 48 hours of the whistle, into the `ANALYSIS_CACHE` KV under `analysis:latest:<id>`. `analysisCacheSignature` plus `analysisEventSignature` (red cards, from match detail) decide which ticks regenerate: goal, red card, penalty and status changes immediately, otherwise 10-minute clock buckets in normal play, 5-minute buckets in extra time, and penalty-score changes during a shootout. `GET /analysis/:id` is a pure KV read; the prompt is built server-side via the pure shared module `src/analysisPrompt.js` (league table context, zones, form), so browsers can never trigger an Anthropic call. The schema fields are `{ headline, match, context }`; bump `ANALYSIS_PROMPT_VERSION` when the prompt or shape changes meaningfully. Requires the `ANTHROPIC_API_KEY` secret and the `ANALYSIS_CACHE` KV binding; missing either means no analyses and `matchDetail.js` hides the card. Model comes from the `ANTHROPIC_MODEL` var (default `claude-sonnet-5`; overrides must support adaptive thinking and structured outputs). The Worker depends on `@anthropic-ai/sdk` and `@pushforge/builder` (the repo's only npm dependencies, both Worker-side) and `wrangler.toml` needs `compatibility_flags = ["nodejs_compat"]`. `wrangler.toml` pins `account_id`: the wrangler login sees two accounts and unpinned commands can silently target the wrong one.

- **Accounts are D1-backed opaque bearer sessions; Google is only the identity check.** `POST /auth/google` verifies a Google Identity Services ID token via Google's tokeninfo endpoint, then checks `aud`/`iss`/`email_verified` itself, upserts `users`, and returns a random session token whose SHA-256 (never the token) is stored in `sessions` (30-day TTL). The client keeps the token in localStorage (`gs-session`) and sends `Authorization: Bearer`; there are no cookies, so the cross-origin Pages↔Worker split just works. `GET /me`, `POST /follows/toggle` (competition+team, capped), `POST /prefs` (notification prefs stored now, delivered in Phase 3), `POST /auth/logout`. Missing `DB` binding or `GOOGLE_CLIENT_ID` → 501 and the You section explains itself instead of erroring. The Google client id is public config, set in TWO places: `GOOGLE_CLIENT_ID` in `wrangler.toml` and the constant in `src/account.js`; both empty ships the UI with sign-in dormant. Schema lives in `worker/schema.sql` (idempotent; applied with `wrangler d1 execute`).

- **Push notifications are cron-diffed server state, never client polling.** The minute cron (`runScheduledNotifications`) diffs each live/recent match against `notify_state` in D1 and fans out VAPID Web Push (encrypted by `@pushforge/builder`) for kickoff, goals, red cards (from the same match detail the analysis pass fetches, riding the edge cache) and full-time, plus "analysis ready" only for the full-time read. Targeting is `follows` × `push_subscriptions`, filtered per user by `users.prefs` with `DEFAULT_PREFS` fallbacks; a first sighting of a match only baselines `notify_state` so a deploy mid-match never bursts catch-up pushes; 404/410 from a push service prunes the subscription. The VAPID public key is set in TWO places (`VAPID_PUBLIC_KEY` in wrangler.toml and the constant in `src/push.js`); the private half is the `VAPID_PRIVATE_JWK` secret. `sw.js` at the repo root shows the payloads; `POST /push/test` sends to the caller's devices so delivery is verifiable without waiting for a goal. Device state (`pushState` in `src/push.js`) is always read from the browser's real permission + subscription, never a stored flag.

- **Scorer data is not in the live feed; the Golden Boot is aggregated at build time.** Goals and assists exist only in per-match detail (`data/<comp>/matches/<id>.json`). `scripts/fetch-live-data.mjs` tallies each competition's detail directory through the shared pure `aggregateScorers` (`src/scorers.js`) into `data/<comp>/scorers.json`, which the client loads separately from the live feed (`loadModel` fetches both in parallel; the Worker has no scorers endpoint). It refreshes on the 5-min Action cadence, not live. Each competition's tally scans only its own `data/<comp>/matches/` directory; changing a season means clearing that directory (and the Action's cache key, `match-detail-2026-`). General pattern: when the live feed lacks a datum that match detail carries, aggregate it at build time into its own static JSON and load it client-side in parallel.

## Module map (`src/`)

- `app.js` orchestration: sections (Scores/Play) + scores tabs, hash routing (`#live/#tables/#knockout/#fixtures/#stats/#play`, legacy aliases kept), polling, desktop/mobile re-render on the 760px matchMedia crossing, event delegation on `#layout`, Sentry telemetry helpers.
- `data.js` data loading (`loadModel(comp)` fetches the live feed and scorers in parallel), `buildModel(raw, scorerData)` (league tables with form, standings, team registration).
- `domain.js` pure mapping/standings logic, team-name normalization, per-team performance/form.
- `competitions.js` per-competition config (name, table zone bands) and `zoneFor`.
- `badges.js` team badge registry (`registerTeams`, `badgeFor`, `abbrFor`); crest/TLA come from the feed.
- `account.js` accounts client: GIS lazy-load, bearer session in localStorage, `/me` restore, follows + prefs API, account-change listeners. The `GOOGLE_CLIENT_ID` constant lives at its top.
- `push.js` device push client: service-worker registration, `pushState`/`enablePush`/`disablePush`/`sendTestPush`. The `VAPID_PUBLIC_KEY` constant lives at its top; `sw.js` (repo root, outside `src/`) is the service worker itself.
- `scorers.js` pure scorer aggregation (`aggregateScorers`, `compareByInvolvements`, `compareByGoals`); shared by the fetch script and the browser.
- `analysisPrompt.js` pure AI-analysis prompt builder (system prompt, JSON schema, per-match payload with league context); imported by the Worker only, same cross-environment contract as `mapFootballDataMatches`.
- `views.js` HTML-string renderers (ticker marquee, competitions sidebar/chips, hero, scores tab bar, live cards, match lines, league table, mini-table aside, knockout board, fixtures, player stats, footer).
- `format.js` pure formatters and live/finished status helpers (no DOM).
- `interactions.js` `confettiBurst` (currently unwired; kept for celebration moments).
- `matchDetail.js` match drawer: right slide-in with score header, then AI analysis, timeline (goals/cards/subs merged in match order), line-ups and banter in one scroll; fetches per-match detail on open (Worker `/match/:id` or static `data/<comp>/matches/<id>.json`).
- `banter.js` shared per-match reactions and messages, D1-backed. Reading is public; posting requires a signed-in session (names come from the account, no client-supplied identity). POST responses are strongly consistent, so the optimistic UI reconciles against them without flicker; an `inflight` counter drops poll responses that would race a pending post.
- `paperRun*.js` the Paper Run daily mini-game (model, API, view, game loop); rendered as the Play section.
- `locations.js` venue → city/map-link lookup; `mapDetail.js` match-detail mapping.

## Adding a tab or panel control

- **New scores tab:** add it to `SCORES_TABS` in `src/views.js` (label + key) and to `SCORES_TABS` in `src/app.js`, add a `case` to `renderPanel` in `app.js`, and write the renderer in `views.js`. Tabs route via the URL hash; the Knockout tab demonstrates conditional presence (cups only).
- **New in-panel control** (sort toggle, filter): give it a unique `data-*` attribute (not a shared one), keep its state in the `state` object in `app.js`, read it in the renderer, and handle it in `wireLayoutControls` (click delegation with an early `return` per handler). Reuse the `.segrow`/`.seg` pill markup; see `data-fixture-view` (fixtures), `data-gb-sort` (player stats).

## Telemetry and the Sentry tunnel

Sentry is vendored first-party (`vendor/sentry.min.js`) and events are tunnelled through the Worker's `/tunnel` route so tracker blockers that block the Sentry ingest domain cannot drop them. The DSN/host/project in `index.html`, the `SENTRY_HOST`/`SENTRY_PROJECT` allow-check in `worker/worker.js`, and the `tunnel:` URL must all reference the same deployed Worker and Sentry project. All telemetry calls in `app.js` are wrapped so a blocked or absent Sentry never throws.

When changing the deployed origins, keep `ALLOWED_ORIGINS` (worker CORS) and the GitHub Pages URL aligned.

## Roadmap (agreed phases)

1. ~~Phase 0: strip the sweepstake, single-competition PL tracker~~ (done)
2. ~~Phase 1: multi-competition (namespaced data/routes, competition switcher, Champions League config + display-only knockout view)~~ (done)
3. ~~Phase 2: Google sign-in + follows + notification prefs on Cloudflare D1~~ (done)
4. ~~Phase 3: Web Push notifications (service worker + VAPID from the Worker cron; targeting = `follows`, preferences = `users.prefs`)~~ (done)
5. Phase 4: fantasy H2H draft league; Europa/Conference (needs football-data €49 tier)

Considered and skipped: pre-season friendlies (football-data.org has no club friendlies on any tier; would need a second data source such as API-Football).

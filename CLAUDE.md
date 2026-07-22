# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Squad Goals**: a Svelte/Vite football tracker (FotMob-style live scores, league table, fixtures, player stats) covering the Premier League and the Champions League with a competition switcher, with the other European cups on the roadmap, followed by user sign-up, push notifications and a fantasy draft. Hosted as a static build on GitHub Pages. `src/App.svelte` owns the application shell while the existing plain-JavaScript feature modules remain framework-independent.

The UI implements the "Squad Goals" design (source of record: `docs/design/squad-goals.dc.html`, exported from the Claude Design project): navy `#0A0E14` background, lime `#C8F542` accent, Archivo with italic-uppercase display type, card surfaces `#12181F`. Sections are Scores and Paper Run (Play), with Fantasy and Profile present in the nav as inert "Soon" entries until their phases ship. Design tokens live at the top of `src/styles.css` and keep the pre-reskin custom-property names so carried-over components restyle automatically.

The app began as a World Cup 2026 sweepstake hub; the sweepstake (entrants, pot, prizes, Monte Carlo projection) was removed after the tournament. See `README.md` for hosting/deploy steps.

## Commands

- `npm run fetch:live` runs `scripts/fetch-live-data.mjs`: the Go client in `cmd/api-football` pulls API-Football, then the shared JavaScript mapper writes `data/<comp>/live.json`, per-match detail under `data/<comp>/matches/`, and `data/<comp>/scorers.json`. It needs `API_FOOTBALL_KEY`; `API_FOOTBALL_COMPETITIONS` is a comma list of `CODE:season` pairs (default `PL:2026`).
- `npm run fetch:fantasy-players` bakes `data/PL/players.json` from `/players/squads`, with accumulated lineups as an explicit incomplete fallback. The Actions cache and a 24-hour freshness guard prevent five-minute squad refetches.
- Worker (in `worker/`): `npx wrangler login`, `npx wrangler secret put API_FOOTBALL_KEY`, `npx wrangler deploy`. Needs Wrangler 4.36.0+ for the `unsafe.bindings` rate-limit syntax.
- Tests: `npm test` and `go test ./...`. Preview/build: `npm run dev` and `npm run build`.

## Data flow

`index.html` loads `src/main.js`, which mounts `src/App.svelte`; the shell then starts `src/app.js`. `loadModel()` (`src/data.js`) turns raw feed data into the single `model` object every view reads. Existing feature renderers still return HTML strings and use delegated event listeners inside the Svelte-owned shell.

Two delivery paths for the same raw shape (`{ source, lastUpdated, competition, season, matches, standings }`):

1. Cloudflare Worker (`worker/worker.js`) proxies API-Football with the key kept server-side and edge-caches each upstream call, so many pollers collapse into roughly one upstream call per window. The site polls it live.
2. GitHub Action (`.github/workflows/pages.yml`, every five minutes from 11:00–22:55 UTC) bakes `data/live.json` into each deploy as the static fallback.

`src/data.js` picks the source: `loadModel(comp)` tries the `DATA_API` Worker origin first (`/:comp/live`) and falls back to static `data/<comp>/live.json` if the Worker is unreachable. Match-scoped routes carry no competition segment because API-Football fixture ids are globally unique; the Worker validates ids against configured competitions.

Live updates without a deploy: `app.js` re-runs `loadModel()` on a timer (20s while a match is live, 60s otherwise) and only re-renders when a match signature (id/status/score/minute) actually changes.

## Architecture invariants (read before editing mapping, standings, or teams)

- **The canonical team name is produced by `normalizeTeamName` (`src/domain.js`).** API-Football uses full club names, so `TEAM_ALIASES` maps provider spellings to the established app join keys used by standings, events, badges, fantasy and the Golden Boot.

- **Team badges prefer a self-hosted crest, then the feed's crest, then a TLA ring.** `LOCAL_CRESTS` is a narrow style override for the current Premier League clubs. Promotions and other competitions must continue to flow from API-Football rather than growing the hardcoded map.

- **Table zones are per-competition config, not hardcoded positions.** Adding a competition means adding its API-Football league id and zones in `src/competitions.js`, then including it in `API_FOOTBALL_COMPETITIONS`; renderers do not change.

- **`mapApiFootballMatches` and `mapApiFootballMatchDetail` (`src/mapApiFootball.js`) are the ingestion contract.** The Worker, build-time bake, and browser consume the same mapped shape. Keep status, round, team-name, card and penalty translation centralized there; the Go command deliberately transports raw payloads without duplicating mapping logic.

- **AI match analysis is cron-generated in the Worker, never on user visits.** A one-minute cron trigger (`[triggers]` in wrangler.toml, `scheduled` handler in worker/worker.js) checks the feed and writes one Claude analysis per live match, plus a full-time read within 48 hours of the whistle, into the `ANALYSIS_CACHE` KV under `analysis:latest:<id>`. `analysisCacheSignature` plus `analysisEventSignature` (red cards, from match detail) decide which ticks regenerate: goal, red card, penalty and status changes immediately, otherwise 10-minute clock buckets in normal play, 5-minute buckets in extra time, and penalty-score changes during a shootout. `GET /analysis/:id` is a pure KV read; the prompt is built server-side via the pure shared module `src/analysisPrompt.js` (league table context, zones, form), so browsers can never trigger an Anthropic call. The schema fields are `{ headline, match, context }`; bump `ANALYSIS_PROMPT_VERSION` when the prompt or shape changes meaningfully. Requires the `ANTHROPIC_API_KEY` secret and the `ANALYSIS_CACHE` KV binding; missing either means no analyses and `matchDetail.js` hides the card. Model comes from the `ANTHROPIC_MODEL` var (default `claude-sonnet-5`; overrides must support adaptive thinking and structured outputs). The Worker depends on `@anthropic-ai/sdk` and `@pushforge/builder` (the repo's only npm dependencies, both Worker-side) and `wrangler.toml` needs `compatibility_flags = ["nodejs_compat"]`. `wrangler.toml` pins `account_id`: the wrangler login sees two accounts and unpinned commands can silently target the wrong one.

- **Accounts are D1-backed opaque bearer sessions; Google is only the identity check.** `POST /auth/google` verifies a Google Identity Services ID token via Google's tokeninfo endpoint, then checks `aud`/`iss`/`email_verified` itself, upserts `users`, and returns a random session token whose SHA-256 (never the token) is stored in `sessions` (30-day TTL). The client keeps the token in localStorage (`gs-session`) and sends `Authorization: Bearer`; there are no cookies, so the cross-origin Pages↔Worker split just works. `GET /me`, `POST /follows/toggle` (competition+team, capped), `POST /prefs` (notification prefs stored now, delivered in Phase 3), `POST /auth/logout`. Missing `DB` binding or `GOOGLE_CLIENT_ID` → 501 and the You section explains itself instead of erroring. The Google client id is public config, set in TWO places: `GOOGLE_CLIENT_ID` in `wrangler.toml` and the constant in `src/account.js`; both empty ships the UI with sign-in dormant. Schema lives in `worker/schema.sql` (idempotent; applied with `wrangler d1 execute`).

- **Push notifications are cron-diffed server state, never client polling.** The minute cron (`runScheduledNotifications`) diffs each live/recent match against `notify_state` in D1 and fans out VAPID Web Push (encrypted by `@pushforge/builder`) for kickoff, goals, red cards (from the same match detail the analysis pass fetches, riding the edge cache) and full-time, plus "analysis ready" only for the full-time read. Targeting is `follows` × `push_subscriptions`, filtered per user by `users.prefs` with `DEFAULT_PREFS` fallbacks; a first sighting of a match only baselines `notify_state` so a deploy mid-match never bursts catch-up pushes; 404/410 from a push service prunes the subscription. The VAPID public key is set in TWO places (`VAPID_PUBLIC_KEY` in wrangler.toml and the constant in `src/push.js`); the private half is the `VAPID_PRIVATE_JWK` secret. `sw.js` at the repo root shows the payloads; `POST /push/test` sends to the caller's devices so delivery is verifiable without waiting for a goal. Device state (`pushState` in `src/push.js`) is always read from the browser's real permission + subscription, never a stored flag.

- **Scorer data is aggregated at build time.** `scripts/fetch-live-data.mjs` tallies cached match-detail files through `aggregateScorers` into `data/<comp>/scorers.json`. Changing a season means clearing the detail directory and changing the Action cache key (`api-football-data-2026-`).

## Module map (`src/`)

- `app.js` orchestration: sections (Scores/Play) + scores tabs, hash routing (`#live/#tables/#knockout/#fixtures/#stats/#play`, legacy aliases kept), polling, desktop/mobile re-render on the 760px matchMedia crossing, event delegation on `#layout`, Sentry telemetry helpers.
- `data.js` data loading (`loadModel(comp)` fetches the live feed and scorers in parallel), `buildModel(raw, scorerData)` (league tables with form, standings, team registration).
- `domain.js` pure mapping/standings logic, team-name normalization, per-team performance/form.
- `competitions.js` per-competition config (name, table zone bands) and `zoneFor`.
- `badges.js` team badge registry (`registerTeams`, `badgeFor`, `abbrFor`); crest/TLA come from the feed.
- `account.js` accounts client: GIS lazy-load, bearer session in localStorage, `/me` restore, follows + prefs API, account-change listeners. The `GOOGLE_CLIENT_ID` constant lives at its top.
- `push.js` device push client: service-worker registration, `pushState`/`enablePush`/`disablePush`/`sendTestPush`. The `VAPID_PUBLIC_KEY` constant lives at its top; `sw.js` (repo root, outside `src/`) is the service worker itself.
- `scorers.js` pure scorer aggregation (`aggregateScorers`, `compareByInvolvements`, `compareByGoals`); shared by the fetch script and the browser.
- `analysisPrompt.js` pure AI-analysis prompt builder (system prompt, JSON schema, per-match payload with league context); imported by the Worker only.
- `views.js` HTML-string renderers (ticker marquee, competitions sidebar/chips, hero, scores tab bar, live cards, match lines, league table, mini-table aside, knockout board, fixtures, player stats, footer).
- `format.js` pure formatters and live/finished status helpers (no DOM).
- `interactions.js` `confettiBurst` (currently unwired; kept for celebration moments).
- `matchDetail.js` match drawer: right slide-in with score header, then AI analysis, timeline (goals/cards/subs merged in match order), line-ups and banter in one scroll; fetches per-match detail on open (Worker `/match/:id` or static `data/<comp>/matches/<id>.json`).
- `banter.js` shared per-match reactions and messages, D1-backed. Reading is public; posting requires a signed-in session (names come from the account, no client-supplied identity). POST responses are strongly consistent, so the optimistic UI reconciles against them without flicker; an `inflight` counter drops poll responses that would race a pending post.
- `paperRun*.js` the Paper Run daily mini-game (model, API, view, game loop); rendered as the Play section.
- `locations.js` venue → city/map-link fallback; `mapApiFootball.js` provider mapping.

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
5. Phase 4: fantasy H2H draft league; Europa/Conference

Pre-season friendlies remain out of the configured competitions until their product behavior is designed.

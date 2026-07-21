# Squad Goals

Squad Goals: a static GitHub Pages app for following the Premier League and the Champions League:
FotMob-style live scores, tables with qualification and relegation zones, full
fixtures and results, and a Golden Boot scorer board, with a competition switcher.
The other European cups are on the roadmap, along with sign-up, push notifications
and a fantasy draft.

Sections (single page, tabbed): Live & today, Table, Knockout (cups only), Fixtures,
Golden Boot, and the Paper Run daily mini-game. Extras: a live score ticker, a match
drawer with lineups, goals, cards and substitutions, shared match banter, and an
optional AI-written match read.

## Host On GitHub Pages

1. Create a new personal GitHub repository.
2. Push these files to the repository.
3. In GitHub, go to `Settings` -> `Pages`.
4. Set `Source` to `GitHub Actions`.
5. Push to `main`; the included workflow publishes the app.

The app has no build step. `index.html` is the entry point, so it also works from any static host.

## Live Data

Data comes from football-data.org (the Premier League and Champions League are on
their free tier).

To enable it:

1. Get a football-data.org API token.
2. In your GitHub repo, go to `Settings` -> `Secrets and variables` -> `Actions`.
3. Add a repository secret named `FOOTBALL_DATA_TOKEN`.
4. Run the Pages workflow, or wait for the schedule.

The workflow fetches live data every few minutes and publishes `data/<competition>/live.json` per competition with the site. The API token never appears in the browser.

Workflow environment variables (set in the workflow file):

- `FOOTBALL_DATA_COMPETITIONS`, a comma list of `CODE:season` pairs, default `PL:2026` (the season is football-data's starting year, so 2026 = the 2026-27 season). The first competition is the default one.

## Live Data Without Deploys (Cloudflare Worker)

The GitHub Action bakes data into each deploy, so the static `data/live.json` only
refreshes as often as the site redeploys. For minute-by-minute live scores, deploy the
Worker in `worker/`: it proxies football-data with the token kept server-side, edge-
caches each upstream call briefly (so many pollers collapse into roughly one upstream
call per cache window, staying under the plan's per-minute limit), and serves `/live`
and `/match/:id` with CORS. The site then polls it (about every 20 seconds while a
game is live) and updates in place, no deploy involved.

1. `cd worker`
2. `npx wrangler login`
3. `npx wrangler secret put FOOTBALL_DATA_TOKEN` and paste your token.
4. `npx wrangler deploy`. Note the URL it prints, e.g.
   `https://goon-squad-data.<your-subdomain>.workers.dev`.
5. Set `DATA_API` in `src/data.js` to that URL and push.

The site falls back to the static `data/live.json` whenever the Worker is unset or
unreachable, so it keeps working either way. The token never reaches the browser.

Note: football-data.org does not provide expected goals (xG) on any tier, so the match
detail shows lineups, scorers, subs and cards, but not xG. Player-level match detail
may require football-data's deep data pack depending on your plan; without it the
Golden Boot and the events pane degrade gracefully to empty states.

### AI match analysis (optional)

The Worker can also serve a Claude-written summary of any live or finished match,
including what the result means for the table: the match drawer shows it as an
"AI analysis" card. Generation is cron-driven, not visit-driven: the Worker checks
the feed every minute and pre-generates into KV on an adaptive cadence, every 10
minutes of normal play, every 5 in extra time, kick by kick during a penalty
shootout, immediately on any goal, red card or status change, and once after
full time.
Opening the drawer only ever reads the stored copy, so browsers can never trigger
an API call and the cost is fixed per match (a few cents) no matter how many
people are watching. To enable it:

1. `cd worker`
2. `npx wrangler kv namespace create ANALYSIS_CACHE` and paste the printed id into
   the `ANALYSIS_CACHE` block in `wrangler.toml`.
3. `npx wrangler secret put ANTHROPIC_API_KEY` and paste an Anthropic API key
   (create one at https://platform.claude.com/).
4. `npx wrangler deploy`

Without the secret or the KV namespace nothing is generated and the site simply
hides the card. The prompt is built server-side from feed data only, so the endpoint
cannot be used as a general LLM proxy. The model defaults to `claude-sonnet-5`
(`ANTHROPIC_MODEL` in `wrangler.toml`).

## History

This app started life as a World Cup 2026 sweepstake hub (entrants, a prize pot and
a Monte Carlo projection of who wins the money). The sweepstake concept was removed
after the tournament; see the git history if you are curious.

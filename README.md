# World Cup Sweepstake HQ

A static GitHub Pages app that is the group's hub for everything World Cup, with the
sweepstake money race as the centerpiece. FotMob-style live scores, group tables, a
knockout bracket and full fixtures, every team tagged with its owner.

The hero answers one question: who is on for winning. The payouts are tied to
tournament outcomes, not the points table, so the app runs a Monte Carlo projection
(5,000 simulations on load, seeded from the data timestamp so the odds are stable) to
estimate each entrant's chance at the winner, runner-up and wooden-spoon prizes. See
`docs/superpowers/specs/` for the full design and the projection methodology.

Sections (single page, tabbed): Live & today, Leaderboard (current points plus
projected odds), Group tables, Knockout bracket, Fixtures. Extras: a live score
ticker, owner head-to-head compare, and confetti when a final is decided.

The pot is fixed at 16 entries x €10 = €160:

- World Cup winner owner: €100
- World Cup runner-up owner: €30
- Wooden spoon: €30, only after an owned team is confirmed last in its group with all three group matches finished

## Host On GitHub Pages

1. Create a new personal GitHub repository.
2. Push these files to the repository.
3. In GitHub, go to `Settings` -> `Pages`.
4. Set `Source` to `GitHub Actions`.
5. Push to `main`; the included workflow publishes the app.

The app has no build step. `index.html` is the entry point, so it also works from any static host.

## Live Data

This uses football-data.org because its API supports the World Cup code `WC`, the competition matches endpoint, and the current competition standings endpoint.

To enable it:

1. Get a football-data.org API token.
2. In your GitHub repo, go to `Settings` -> `Secrets and variables` -> `Actions`.
3. Add a repository secret named `FOOTBALL_DATA_TOKEN`.
4. Run the Pages workflow, or wait for the schedule.

The workflow fetches live data every 30 minutes and publishes `data/live.json` with the site. The API token never appears in the browser.

Optional workflow variables:

- `FOOTBALL_DATA_COMPETITION`, default `WC`
- `FOOTBALL_DATA_SEASON`, default `2026`

## Live Data Without Deploys (Cloudflare Worker)

The GitHub Action bakes data into each deploy, so the static `data/live.json` only
refreshes as often as the site redeploys. For minute-by-minute live scores, deploy the
Worker in `worker/`: it proxies football-data with the token kept server-side, edge-
caches each upstream call briefly (so many pollers collapse into roughly one upstream
call per cache window, staying under the 30/min plan limit), and serves `/live` and
`/match/:id` with CORS. The site then polls it (about every 30 seconds while a game is
live) and updates in place, no deploy involved.

1. `cd worker`
2. `npx wrangler login`
3. `npx wrangler secret put FOOTBALL_DATA_TOKEN` and paste your token.
4. `npx wrangler deploy`. Note the URL it prints, e.g.
   `https://goon-squad-data.<your-subdomain>.workers.dev`.
5. Set `DATA_API` in `src/data.js` to that URL and push.

The site falls back to the static `data/live.json` whenever the Worker is unset or
unreachable, so it keeps working either way. The token never reaches the browser.

Note: football-data.org does not provide expected goals (xG) on any tier, so the match
detail shows lineups, scorers, subs and cards, but not xG.

### AI match analysis (optional)

The Worker can also serve a Claude-written summary of any live or finished match,
including what the result means for the pot: the match drawer shows it as an
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

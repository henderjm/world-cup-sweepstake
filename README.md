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

The app is built with Svelte and Vite. Run `npm run dev` locally or `npm run build` to produce the static `dist/` site.

## Live Data

Data comes from API-Football. The paid Pro plan is required for the configured 2026 season.

To enable it:

1. Get an API-Football key.
2. In your GitHub repo, go to `Settings` -> `Secrets and variables` -> `Actions`.
3. Add a repository secret named `API_FOOTBALL_KEY`.
4. Run the Pages workflow, or wait for the schedule.

The workflow refreshes the static fallback hourly during its 12-hour UTC match window and publishes `data/<competition>/live.json` per competition. The API key never appears in the browser.

Workflow environment variables (set in the workflow file):

- `API_FOOTBALL_COMPETITIONS`, a comma list of `CODE:season` pairs, default `PL:2026`. Competition codes resolve to API-Football league ids in `src/competitions.js`.

## Live Data Without Deploys (Cloudflare Worker)

The GitHub Action bakes data into each deploy, so the static `data/live.json` only
refreshes as often as the site redeploys. For minute-by-minute live scores, deploy the
Worker in `worker/`: it proxies API-Football with the key kept server-side, edge-
caches each upstream call briefly (so many pollers collapse into roughly one upstream
call per cache window, staying under the plan's per-minute limit), and serves `/live`
and `/match/:id` with CORS. The site then polls it (about every 20 seconds while a
game is live) and updates in place, no deploy involved.

1. `cd worker`
2. `npx wrangler login`
3. `npx wrangler secret put API_FOOTBALL_KEY` and paste your key.
4. `npx wrangler deploy`. Note the URL it prints, e.g.
   `https://goon-squad-data.<your-subdomain>.workers.dev`.
5. Set `DATA_API` in `src/data.js` to that URL and push.

The site falls back to the static `data/live.json` whenever the Worker is unset or
unreachable, so it keeps working either way. The token never reaches the browser.

API-Football match detail supplies events, lineups, minutes and defensive player
statistics. The app still degrades to empty states when a competition does not publish
a particular coverage area.

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

## Accounts (Google sign-in, optional)

The You section lets visitors sign in with Google, follow clubs, and set
notification preferences (delivered by push in a later phase). Users, sessions and
follows live in Cloudflare D1 next to the Worker. To enable it:

1. `cd worker`
2. `npx wrangler d1 create squad-goals`, paste the printed id into the
   `[[d1_databases]]` block in `wrangler.toml`, then
   `npx wrangler d1 execute squad-goals --remote --file=schema.sql`
3. In Google Cloud Console → APIs & Services → Credentials, create an
   **OAuth client ID** of type Web application. Add your site origin
   (e.g. `https://<user>.github.io`) and `http://localhost:8731` as
   **Authorized JavaScript origins** (no redirect URIs needed).
4. Put the client id in **both** places: `GOOGLE_CLIENT_ID` in
   `worker/wrangler.toml` and the `GOOGLE_CLIENT_ID` constant in
   `src/account.js`.
5. `npx wrangler deploy` and push the site.

Until step 4 the You section shows sign-in as not configured and everything else
works. Sessions are opaque bearer tokens (only their hash is stored); Google is
used solely to verify identity at sign-in.

Match banter (reactions and messages in the match drawer) also lives in D1:
anyone can read, posting requires signing in, and names come from the account.

## Push notifications (optional)

Signed-in users can enable push on any device from the You section: kickoff,
goals, red cards and full-time for the clubs they follow, honouring their
notification switches. The Worker's minute cron diffs match state and delivers
via Web Push (VAPID); no polling, no third-party service. To enable it:

1. Generate a VAPID P-256 keypair. Put the private JWK in a secret:
   `npx wrangler secret put VAPID_PRIVATE_JWK`, and the public
   applicationServerKey in **both** `VAPID_PUBLIC_KEY` in `worker/wrangler.toml`
   and the constant in `src/push.js`. Set `PUSH_CONTACT` and `SITE_ORIGIN` too.
2. `npx wrangler deploy` and push the site (the service worker is `sw.js`).

Each signed-in user gets a "Send test" button to verify their device end to end.

## History

This app started life as a World Cup 2026 sweepstake hub (entrants, a prize pot and
a Monte Carlo projection of who wins the money). The sweepstake concept was removed
after the tournament; see the git history if you are curious.

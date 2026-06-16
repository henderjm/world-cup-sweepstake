# World Cup Sweepstake

A static GitHub Pages app for the sweepstake in the screenshot. It tracks the draw, ranks entrants from match and standings data, highlights teams in trouble of going out in the group stage, and uses fixed euro payouts.

The pot is fixed at 16 entries x €10 = €160:

- 1st: €100
- 2nd: €30
- Wooden spoon: €30

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

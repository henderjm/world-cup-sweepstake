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

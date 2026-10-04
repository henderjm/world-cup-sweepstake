# Browser checks

Run all browser QA headlessly. The user works on this laptop while checks run:
do not open Chrome, use a headed browser tool, or steal focus. This applies to
manual checks, competitor inspections and hourly task continuations too. Use
headless screenshots when visual inspection is needed.

The existing `.js` checks contain an async function accepting a Playwright page.
Run them with the shared runner, which explicitly launches headless Chromium
and closes it on success or failure:

```sh
node scripts/qa/run-headless.mjs scripts/qa/feeder-continuity.js
```

Playwright and its matching Chromium headless shell must already be installed.
If Playwright is installed outside this checkout, set `PLAYWRIGHT_MODULE_PATH`
to the absolute path of its `index.mjs`. The runner does not install packages,
download browsers or fall back to a visible browser. Only run trusted repository
checks: these scripts execute with Node access.

Start the local preview and any fixture server listed at the top of the selected
check first. For the feeder continuity check, use separate terminals:

```sh
npm run build
npm exec vite preview -- --host 127.0.0.1 --port 8732
```

```sh
node scripts/qa/feeder-browser-server.mjs "$PWD"
```

The check verifies mobile score updates, stale-data handling and desktop layout
against a simulated provider. It does not validate production delivery. Stop
both local servers afterwards. An assertion failure exits the runner nonzero.

To repeat the feeder check for Champions League, restart the fixture server
with `CL` as its second argument and set `QA_COMPETITION=CL` on the runner.
The default for both is Premier League (`PL`).

For a busy-matchday scheduling replay, first record the actual feeder's calls
against the simulated provider and clock (the credentials below are test-only):

```sh
FEEDER_TEST_SCENARIO=crowded-slow FEEDER_TEST_RESULT=/tmp/kickoff-feeder-trace.json \
  GITHUB_OUTPUT=/tmp/kickoff-feeder-rearm API_FOOTBALL_KEY=fixture \
  DETAIL_INGEST_TOKEN=fixture API_FOOTBALL_COMPETITIONS=PL:2026,CL:2026 \
  WORKER_ORIGIN=https://fixture.invalid \
  node --import ./test/fixtures/feeder-runtime.mjs scripts/feed-live-details.mjs
```

Start a fresh fixture server with `FEEDER_TRACE=/tmp/kickoff-feeder-trace.json`
and the desired competition argument. Run `feeder-scheduling.js` through the
headless runner with the same `QA_COMPETITION` value. The browser replays the
recorded score deliveries through local Worker ingestion and checks the visible
scores. Time is accelerated; this is not a measurement of production latency.

For the midnight journey, use `FEEDER_TEST_SCENARIO=overnight`,
`FEEDER_TEST_START=2026-09-19T23:58:00Z` and
`API_FOOTBALL_COMPETITIONS=CL:2026` when recording the trace. Run the same fixture
server and headless replay for CL. It checks that the ongoing match remains on
Today after midnight and that the overnight explanation appears. The browser
uses UTC for this reproducible boundary; unit tests cover the viewer's local day.

The proposed stored-score service has a separate replay on ports 8742 (site
preview) and 8743 (`node scripts/qa/score-service-server.mjs`). Run
`score-service.js` through this headless runner to check loading, unavailable,
empty, delayed and recovered scores, including new versions with mixed fixture
ages. The replay has no provider credentials or production storage; its scope
and remaining infrastructure work are documented in `services/scores/README.md`.

For the actual collector/database path, run DynamoDB Local on :18043 (instructions
in that service README) and `node scripts/qa/collector-server.mjs` on :8743, then
run `collector.js` through the same headless runner. It uses the stored read API,
real collector, budget, mapper and database with a synthetic local HTTP provider.
Stop the QA server before its database so it can delete its owned test tables.

## Stored score Worker migration

Serve a committed frontend preview on `127.0.0.1:8742`, then run
`node scripts/qa/stored-reader-server.mjs` in a separate terminal. Run
`node scripts/qa/run-headless.mjs scripts/qa/stored-reader.js` with the installed
Playwright module as described above. Start a fresh replay server for each run;
its Worker memo is deliberately retained throughout a journey. Stop the owned
server after the run. The harness blocks unexpected outbound requests and uses
a synthetic stored-service response; it does not exercise DynamoDB. Local
preview CORS is adapted in the browser route; unit tests separately verify the
Worker's production-origin CORS response.

Quiet matchdays: with Vite on port 8731, run `next-matchday.js` using
`run-headless.mjs`. Checks 390/1440px, CL/combined routes, Following, stale
schedule disclosure, 44px navigation target, match-detail return and Back. The
malformed fallback fixture must remain isolated without page errors.

Champions League shared positions: run `cl-shared-ranks.js` against Vite on 8731.
Synthetic simultaneous draws verify repeated rank 1, live/shared-rank disclosures,
no false incomplete-data warning, no overflow and no page errors at 390/1440px.

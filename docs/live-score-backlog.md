# Daily live-score product backlog

Updated: 2026-09-11. Owner: ongoing Codex task. Branch: `codex/live-score-quality`.
Starting revision: `bfaf0a66e03febeda47647789e275853155ef638`.

## Mandate and continuation

Make Kickoff Draft a compelling daily live-score destination. Prioritize scores
while preserving fantasy, predictions, Paper Run and existing accounts. Make
routine product and engineering decisions autonomously. Ask before spending,
destructive production changes or public deployment. Pushing to main can deploy
both the site and Worker, so local verification is not authorization to push.

Release authorization, September 10: the user approved deploying the completed
live-score improvements through `ff9b411`. This release excludes unfinished
knockout presentation and separate native-app changes. Future public deployments
still require approval.

An active hourly task automation, `improve-live-scores`, resumes this backlog.
Notify only for substantial completed improvements, meaningful blockers, or a
decision requiring user input. Read the working diff first and preserve it. Do
not redo the full competitor audit each hour: use the evidence below, take the
next bounded improvement, verify it and update this file.

## Initial browser benchmark

Inspected the running [app](https://kickoffdraft.com),
[LiveScore](https://www.livescore.com/en/) and
[FotMob](https://www.fotmob.com/) at 390 × 844 and 1440 × 1000 on September 10.
This was a targeted journey inspection, not an exhaustive parity or latency audit.

| Area | Observed gap | Acceptance criterion |
| --- | --- | --- |
| Find matches | Competitors start with today's multi-league list, date navigation and live filters. Our default PL screen was empty on a CL match night; there is no date selector on Scores. | Today's supported matches accessible immediately; previous/next date, Today and Live filters take one action each; selected date survives detail navigation. |
| Freshness and status | All three showed the same sampled CL scores. Competitors said HT; we said 45'. Our header measured downloads, including fallback downloads. | Distinguish HT, interruptions and unavailable updates. Never describe a fallback download as fresh live data. Recover after errors without reload; quantify event delay separately before making latency claims. |
| Champions League | AEK showed 6 points from 2 games despite the feed saying 3 from 1. Heading showed MD2 above MD1 live games. August qualifiers were labelled knockout play-offs. | Qualifiers/knockouts never affect league-phase points or form; live heading matches visible rounds; stages use correct labels; apply available UEFA ordering and explicitly disclose unavailable criteria. |
| Match detail | LiveScore exposes summary, stats, lineups, table and H2H navigation. Our drawer has a scroll of sections and fetches on open. | Open in one action, visible loading/error states, keyboard close and focus restoration; scores and events update while open; section navigation on long details. |
| Following teams | LiveScore exposes favourites on match rows. Our observed signed-out journey routes following through Google sign-in. | Follow a club locally without account creation, persist across reload, expose a useful followed-match view; keep authenticated follows and notification identity intact. |
| Visual hierarchy | FotMob fit six CL games on the mobile viewport; our fourth live card was clipped by bottom navigation. Several league controls advertise unavailable competitions. | Six sampled matches visible above bottom navigation at 390 × 844; no page overflow at 320, 390 or 1440; controls remain readable and keyboard accessible. |

No new third-party service or data subscription was purchased. The initial local
browser could not reach the external Worker (connection refused), although the
production page and a separate read of the public endpoint worked. Local browser
regressions therefore replay the captured public feed or explicit synthetic
failure/status variants, not a claim of production deployment or end-to-end latency.

## Completed and deployed September 10

1. Restricted CL table reconciliation and form to league/group-stage fixtures.
   Replayed the public CL feed captured at `2026-09-10T19:55:43.564Z`: AEK is
   back to 3 points / 1 played. Qualifying fixtures remain accessible.
2. Hero chooses the active live matchday; mixed live rounds use a neutral heading.
   Qualifying play-offs and knockout play-offs now have distinct labels/order.
3. Preserved provider status in mapping and detail data. Cards, ticker and drawer
   can show HT, Suspended or Interrupted. Older feeds without the new field show
   Paused rather than guessing HT. This requires the Worker/bake update as well
   as the frontend; both are included in the September 10 release below.
4. Compacted the mobile scores list. All six replayed matches fit before the
   bottom navigation at 390 × 844 (sixth row bottom: 783px). No page overflow at
   320, 390 or 1440. The date browser in item 10 supersedes the initial live cards.
5. Added initial loading UI and bounded feed requests (8 seconds per request;
   Worker plus static fallback may total 16 seconds). Distinguish an unavailable
   feed from a successfully loaded empty competition. Retry recovers in place.
6. Marked static fallback as delayed using its saved timestamp, with an unknown
   age when absent. Repaint on table or stale-state changes even if scores do
   not change; verified stale banner disappearance on recovery.
7. Champions League settled tables retain provider ranks. Live projections use
   the available UEFA criteria in order, including away goals and away wins;
   collective opponent totals apply only with a complete eight-match league
   phase. Missing criteria retain the published tied-group order and show a
   qualification note, rather than silently sorting clubs alphabetically.
   Primary rules verified against [2026/27 Article 18](https://documents.uefa.com/r/Regulations-of-the-UEFA-Champions-League-2026/27/Article-18-Equality-of-points-league-phase-Online).
   Disciplinary totals and coefficients are absent from this feed, so final
   decisions on those criteria remain the provider's responsibility. Browser
   replay confirmed the note and published tie order (Stuttgart before Sporting).
8. Open match drawers now refresh on every successful scoreboard poll, including
   polls with unchanged scores. Header, details and analysis update independently;
   the banter composer remains mounted. Failed detail refreshes preserve the last
   detail and offer retry. Requests are aborted on close/reopen so a response for
   an earlier opening cannot overwrite the current one. Keyboard focus stays in
   the dialog and returns to the match on close, including after a page repaint.
   The browser regression below verified consecutive goals, event-only changes,
   preserved scroll/focus, failure/retry and same-match reopen races.

9. Freshness now uses the saved feed timestamp. Live payloads older than two
   minutes are marked delayed even after an HTTP success. Total outages, empty
   fallbacks and older snapshots retain the last known scores; repeated failures
   do not reset their age. A newer healthy response clears the delay. These are
   feed-age checks, not a measurement of provider event latency.
10. Scores now has previous/next day, a calendar, Today and Live controls. Dates
    follow the viewer's timezone, including DST boundaries. Date/filter state
    survives reload, browser Back and opening/closing details. Each fixture
    appears once; empty days identify the next fixture with its date. Mobile
    rows show full team names. Deleted the superseded live-card rendering/CSS.
11. Moved the donation button to a footer link because the floating widget covered
    matches and navigation. Support remains available on the website and hidden
    in the existing native-app presentation. Other product areas remain intact.

12. The default Scores destination now shows PL and CL together, grouped by
    competition. Leagues with live games come first, followed by other matches
    on the chosen date, then quiet leagues.
    The stored league preference no longer hides other leagues on the home view;
    explicit league routes still open that league. Shared date and Live controls
    apply across both feeds. League tables, predictions and historical fixtures
    remain separate and reachable; their URLs now retain the competition.
13. Each feed loads, retries and retains its last good snapshot independently.
    Holding PL does not block CL's first paint or its next 20-second live poll.
    Each league shows its own age/loading/error state; refreshing one cannot
    erase another. Match drawer fallback paths use the match's competition.
    Removed the single-feed freshness globals in favour of the per-league store.
14. The overview has a simpler heading and six CL rows fit above mobile navigation
    (sixth row bottom: 714px; nav starts at 785px). Table links have 44px targets.
    Desktop league labels wrap instead of truncating. Removed disabled Europa
    and Conference League buttons because neither has a supported feed and they
    distracted from available matches; no working competition was removed.
15. Browser checks caught and fixed a Fantasy startup regression introduced by
    progressive loading: startup now runs after all module state is initialized.
    The offline regression verifies Fantasy, Play, Learn, Demo and Account entry
    screens. Date buttons and match-row focus survive polling repaints.

16. Teams can now be followed without signing in, through a searchable team
    picker or buttons in the match drawer. The Following filter works with date,
    Live and competition controls, survives reload and shows useful empty states.
    Device follows synchronize between tabs. A blocked storage write retains the
    choice for the visit and explicitly says it will not persist. Local follows
    use the existing exact competition/team pairs, with a 50-team device limit.
    Follows remain competition-specific: choose a club in each competition you
    want to follow; no team-name equivalence or new identity mapping is invented.
17. Device and account follows appear together. Signing in alone does not import
    local follows or change alert subscriptions. The picker offers an explicit
    Save to account action, with copy explaining that account alert settings apply.
    Import preserves existing account follows and notification preferences, and
    removes each local copy only after confirming its account follow. A fresh
    account read before a retry prevents a lost success response from toggling a
    team back off. No real account was used or notification sent during testing.
18. Follow requests and account verification have eight-second deadlines. A
    temporary verification outage preserves the known signed-in account. Late
    restore/toggle responses cannot replace another account's follows. Keyboard
    focus survives following in the drawer and typing in team search during polls.
19. Following controls retain the six-match mobile layout: sixth row ends at 766px
    with navigation starting at 785px at 390 × 844. The team picker is an explicit
    management view; its opening naturally moves matches below the picker.

## Prioritized remaining work

| Priority | Item | Definition of done |
| --- | --- | --- |
| P0 | Diagnose intermittent live request stalls | A production CL request exceeded 20 seconds, while subsequent calls took 21–23ms. The Worker reported a provider-limit cool-off with daily quota remaining. Correlate request timings with upstream/cache waits before assigning the cause; add a bounded upstream recovery path with tests. The frontend eight-second limit exposes the stall but increasing it alone is insufficient. |
| Ready for review | Show league tables on wider screens | At desktop widths (initial target: 1200px and above), show the relevant league table alongside Scores without a separate tab change. In All matches, make the table's competition explicit and selectable. Preserve date, Live and Following selections; tables use the same feed and disclose stale/unavailable data. Verify 1200px and 1440px layouts, keyboard access and no horizontal overflow; mobile scores remain usable at 320px and 390px. Requested by the user September 10. |
| P1 | Restore automatic Worker publishing | GitHub's Worker workflow currently skips deployment because `CLOUDFLARE_API_TOKEN` is unset. Configure an appropriately scoped deployment credential and verify the actual deploy step runs on the next approved release. A green skipped workflow is not deployment evidence. The September 10 release was deployed successfully using the existing local OAuth login. |
| P1 | Measure actual event latency | Compare timestamped provider events and observed delivery across live matches. Establish p50/p95 delay and update reliability; feed age alone does not prove event latency. |
| Ready for review | Qualifying versus main knockout presentation | Keep qualification history available, but avoid presenting a wall of July fixtures as the main knockout destination in September. Group two-leg ties with correct aggregate and penalty handling; never invent future draws. |
| P1 | Team identity and labels | The feed says Sabah FA while both benchmarks say Sabah FK. Verify provider team ID, crest and destination before changing display aliases; do not rewrite stored follow keys based on a name alone. |
| P1 | Match detail navigation/accessibility | Summary, events, lineups and stats affordances; partial-coverage wording. Retain verified focus trap/restoration and retries. Verify scheduled, live, finished and postponed states. |
| P2 | Product polish and performance | Align metadata/brand subtitle with score-first positioning, align the single-league hero with the selected date, check native calendar interaction through polling, and measure rendering/request budgets. Keep existing features reachable. |

## Verification ledger

- Targeted regressions: `test/champions-league.test.js`, `test/feed-loading.test.js`,
  `test/score-dates.test.js`, `test/score-feeds.test.js`, `test/team-follows.test.js`
  and `test/updated-label.test.js`; shared mapper/live-table
  coverage retained.
- Isolated export including team following: 1,458 JavaScript tests passed,
  0 failed; production build passed. The shared working tree also passed
  1,471 tests including separate native-app coverage. Browser checks are
  recorded separately below.
- Repeatable browser regression: `scripts/qa/live-match-drawer.js`, run with the
  Playwright tool's `browser_run_code_unsafe` filename argument while the local
  preview is running. It inherits the current browser viewport and creates and
  closes its own isolated browser context with synthetic fixtures,
  runs the actual 20-second app poll using the browser clock, and checks nine
  refresh/accessibility/race behaviours. Passed on 2026-09-10 at 390 × 844 and
  1440 × 1000. The desktop assertion uses the actual initial scroll offset,
  since a taller viewport can clamp the requested 180px offset.
- Repeatable date/freshness regression: `scripts/qa/score-dates-freshness.js`,
  invoked the same way, checks 14 navigation/outage/recovery behaviours. Passed
  at 320 × 844, 390 × 844 and 1440 × 1000. Browser contexts isolate test clocks
  so one regression cannot advance another tab's time.
- Repeatable overview regression: `scripts/qa/scores-overview.js` checks 17
  behaviours, including independent live polling while another request is held,
  partial outages, league-correct match fallback, table reload, browser Back,
  shared date controls and focus. Passed at 320 × 844, 390 × 844 and 1440 × 1000.
- `scripts/qa/scores-offline-sections.js` checks nine behaviours: all five existing
  non-score entry screens with unavailable feeds, both league failures, isolated
  retry to a healthy empty feed and absence of browser errors. Passed on desktop;
  the individual entry screens were also inspected on mobile.
- `scripts/qa/team-follows.js` covers 18 search/filter/persistence/account-save
  behaviours, including a lost response after the server has saved a follow.
  Passed at 320 × 844, 390 × 844 and 1440 × 1000. Every account endpoint was
  intercepted; these checks do not claim real Google sign-in or push delivery.
- `scripts/qa/follows-storage-and-accounts.js` covers blocked storage and both
  late account-restore and late follow-toggle responses during account changes.
  It uses simulated sign-in controls and intercepted endpoints; all three
  scenarios passed. Both following scripts also passed against the isolated
  production build on localhost, excluding the native-app edits. Existing
  drawer, date/freshness, overview and offline-section
  browser regressions also passed after these changes.
- Go tests passed with permission for temporary local HTTP test servers.
- Browser: desktop and mobile; captured-feed table/heading; 320px overflow;
  match drawer open/Escape close; signed-out following journey; held request shows
  loading; empty response shows No fixtures published; 503 on both paths shows
  Scores unavailable; Try again restores scores; delayed marker says 15m ago;
  foreground refresh removes the stale banner without changing scores; synthetic
  provider HT reaches the card and drawer.
- Browser limitations: feed replay as described above; fonts/analytics and
  third-party donation assets sometimes failed locally. No account was created,
  no push was sent and no deployment was performed.
- Local screenshots: [mobile before](live-score-evidence/mobile-before.png),
  [initial compact cards](live-score-evidence/mobile-after.png), and
  [league date browser](live-score-evidence/mobile-dates.png),
  [mobile overview](live-score-evidence/mobile-overview.png) and
  [desktop overview](live-score-evidence/desktop-overview.png),
  [follow controls](live-score-evidence/mobile-follow-controls.png),
  [Following filter](live-score-evidence/mobile-following.png) and
  [team search](live-score-evidence/mobile-team-search.png). After screenshots
  use an explicit HT variant of the captured CL feed. The overview uses a
  synthetic future PL fixture to exercise the quiet-league state; this is not
  a verified PL schedule. The mobile capture shows six rows above the bottom
  nav, full team names and no floating donation widget.

## Next run

The approved release is deployed; see the release record below. The knockout presentation is now verified locally and ready for review; see the September 11 completion record below.

After resolving the P0 live-request latency investigation, inspect the existing diff, then improve Champions League qualifying versus
main knockout presentation. Verify round/leg and aggregate data before grouping
ties; retain accessible qualifying history and do not invent future draws. The working tree also contains separate native-mobile work; preserve it
and keep this goal's commits scoped to live scores. Keep changes reviewable on
this branch. Do not mark the overall product goal complete because individual
slices pass tests.

## Release record — September 10

- Approved release: `b97448278456de39560e5dc1d31fd5dd0de4ce54`, including all six
  live-score improvement commits through `ff9b411` and the desktop-table backlog
  item. Pushed normally to main; unfinished knockout and native work excluded.
- Isolated release export: 1,458 tests passed, zero failures; build passed.
- [Pages deployment](https://github.com/henderjm/world-cup-sweepstake/actions/runs/34529646806)
  succeeded. The public page serves the expected `index-ClrKPMjB.js` asset.
- [Worker workflow](https://github.com/henderjm/world-cup-sweepstake/actions/runs/34529646834)
  skipped its deploy step because its token was absent. Deployed the same isolated
  revision with the existing local Cloudflare OAuth session instead: Worker
  `goon-squad-data`, version `0770b7a1-fe38-4b33-9cc0-932e042fce3b`.
  Verified the public CL endpoint returns `providerStatus` and 234 fixtures.
- Real production browser checks, without feed interception, passed at 390px and
  1440px: six CL matches, match detail opening/closing, local follow from the
  drawer, Following after reload, next-day/Today navigation and CL table. AEK
  shows one played and three points. No JavaScript errors or horizontal overflow
  in those journeys. Local follows used disposable browser contexts; no account
  writes or notifications. Earlier synthetic loading/error/stale tests remain
  recorded above; this live check does not measure end-to-end event latency.

## September 10 incident repair — scores reverted after reload

The user observed older matches after deployment. Reproduced on production: a
CL request was aborted by the frontend eight-second deadline and the bundled
fallback (18:16 UTC / 19:16 local time) showed two first-half games plus four pre-match fixtures,
although the live endpoint had final results. The in-memory monotonic guard did
not survive reload. Pages restored an older cached bake on code pushes.

Repair: preserve the newest dated public snapshot per competition in browser
storage for up to 24 hours, mark it delayed when used for recovery, and accept
newer provider corrections even if a score decreases. Blocked storage remains
non-fatal. Refresh the bundled scoreboard from the public Worker immediately
before each Pages build, with one bounded retry and a newer-timestamp guard;
this does not run the expensive full provider bake on code pushes.

Isolated repair: 1,464 tests passed and build passed.
`scripts/qa/score-reload-recovery.js` passes the exact browser sequence: final
score, reload with a held request exceeding eight seconds, old static fallback,
older successful live response, then a newer downward score correction. Final
scores survive both stale responses and the delayed marker clears on recovery.
The timing root cause remains under investigation: one longer browser probe
exceeded 20s, followed by CL responses in 21–23ms; the quota endpoint reported
5,249 of 7,500 daily requests remaining and a temporary provider-limit flag.
These are observations, not proof that a particular upstream request was throttled.

### Repair deployment and verification

User explicitly approved deploying the repair. Commit `63bad30` is on main.
[Code deployment](https://github.com/henderjm/world-cup-sweepstake/actions/runs/34530882329)
succeeded and its published JavaScript passed the synthetic timeout/reload
regression in a disposable browser context. Its Worker refresh got HTTP 502
for CL, so the old fallback survived that first build. Triggered the existing
manual data-refresh workflow for the same approved commit;
[data deployment](https://github.com/henderjm/world-cup-sweepstake/actions/runs/34531046761)
succeeded. The public CL fallback now has timestamp `2026-09-10T21:14:50.738Z`
and all six September 10 fixtures finished with the verified final scores.
A clean production browser with Worker requests blocked shows those final
results and a delayed marker; storage contains the dated snapshot.

The Worker executable was unchanged by this repair and was not redeployed.
Intermittent CL request stalls and GitHub-to-Worker HTTP 502s remain a P0
investigation; do not claim the snapshot repair fixes upstream latency. The
first combined browser attempt during propagation timed out; subsequent
clean-context checks and the public fallback JSON succeeded.

## September 11 — bounded provider reads, ready for review

The deployed recovery repair remains in place. A read-only production sample at
08:03 UTC returned CL in 130ms with 234 fixtures; the provider-limit flag was
clear. This quiet-period sample does not explain the earlier 20-second stalls.

Found a concrete recovery gap in the Worker: its shared API-Football fetch had
no deadline. Added a five-second abort covering response headers and body, so
stalled reads can reach the existing stale/ingested-data fallback and release
coalesced callers. This applies to provider reads used by live scores and other
Worker features; their existing failure handling and stale grace are retained.
It bounds each provider read, not a route's total duration across multiple reads
or time waiting in the request pacer/cache. Do not claim the P0 latency issue
is resolved or that this change has been deployed.

Verification on an isolated export excluding native and knockout work:
- 1,467 JavaScript tests passed; frontend build and Worker bundle dry run passed.
- New route tests hold headers and body separately, confirm two concurrent
  callers share one request and both receive a bounded failure, and prove the
  failed promise is removed so a later read succeeds. A separate route test
  preserves a 61-second-old score with its original timestamp on timeout and
  accepts a later score update.
- Browser plus actual local Worker implementation, with a simulated upstream:
  initial read 414ms, stalled read 5,002ms, recovered read 203ms. The known 1–0
  score remained visible with a delayed marker, then updated to 2–0 and cleared
  the marker after recovery. No JavaScript errors. This used the real five-second
  abort; unit tests shorten its timer.
- Reproduction: start `scripts/qa/stalled-provider-server.mjs` with the isolated
  export path (port 8733), preview that export's build on 8732, then run
  `scripts/qa/worker-provider-timeout.js`. Both local servers were stopped.

Next P0 step: correlate slow live requests with provider, cache and pacer timing,
and assess a total browser-route latency budget. The desktop table item is now implemented locally (see below); finishing the isolated knockout presentation work follows. Public
deployment of this new Worker change requires approval.

## September 11 — desktop standings, ready for review

Implemented the user's wider-screen table request. At 1200px and above, All
matches now includes a right-hand standings panel. Its independent competition
selector defaults to the league with relevant visible matches and honours an
explicit choice for the visit. It preserves the date, Live and Following
filters; full-table navigation opens the correct league and Back restores the
previous scores route. The panel uses the same feed snapshot as the matches.

Reused and improved the single-league mini table: native table semantics,
labelled position/club/played/points columns, full wrapping team names, league
identity, live-projection wording and per-feed age. Loading, missing standings,
initial failure and delayed updates have distinct states. Known rows survive a
feed outage and retry restores updates. The panel is hidden below 1200px; the
existing mobile Table entry remains available. Intermediate desktop widths
now use two columns rather than squeezing scores beside a third column.

Validation on an isolated export, excluding native and unfinished knockout work:
- 1,471 tests passed and production build passed.
- `scripts/qa/desktop-standings.js` passed independent table choice, preserved
  filters, polling updates and selector focus, delayed-data retention/retry,
  full-table/Back navigation, loading, initial failure/retry and empty standings.
- No horizontal overflow at 320, 390, 1024, 1200 or 1440px. The standings panel is
  visible at the two wider sizes and hidden at the other three.
- Inspected captured real-feed screenshots at
  [1440px](live-score-evidence/desktop-standings.png) and
  [1200px](live-score-evidence/desktop-standings-1200.png). At 1440px the scores
  column is 616px wide and the table is 300px; six September 10 CL matches remain
  readable beside it. These screenshots replay the September 10 feed, not current
  match results. Some externally hosted crests were unavailable during capture.

Not deployed. P0 latency correlation remains open; the bounded provider read
change is also local and requires deployment approval.

## September 11 — Champions League knockout presentation, ready for review

Separated qualifying history from the main knockout phase and replaced individual
match columns with round selection and grouped ties. September 10's captured
feed contains 90 qualifying matches: 14 first-round ties, 14 second-round ties,
10 third-round ties and seven qualifying play-offs. No main knockout fixtures
were published in that capture, so its main view has an explicit empty state.
The qualifying view opens at its latest completed round. Both legs remain
accessible through match-detail buttons. The heading no longer mixes in the
next league fixture or current league leader.

Aggregates orient both legs to the same teams, exclude shoot-out goals, and
confirm advancement only after completion. Live shoot-outs remain undecided.
The final is one match. Missing/repeated legs, invalid ordering, unavailable
scores and administrative/postponed/cancelled outcomes do not infer advancement.
The initial failing test exposed `AWARDED` being treated as a completed played
leg; the knockout calculation now requires `FINISHED` explicitly.

Rule references checked for the implementation: UEFA 2026/27
[qualifying format](https://documents.uefa.com/r/Regulations-of-the-UEFA-Champions-League-2026/27/Article-15-Match-system-qualifying-phase-and-play-offs-Online),
[knockout format](https://documents.uefa.com/r/Regulations-of-the-UEFA-Champions-League-2026/27/Article-20-Match-system-knockout-phase-Online) and
[tied scores and penalties](https://documents.uefa.com/r/Regulations-of-the-UEFA-Champions-League-2026/27/Article-21-Knockout-system-extra-time-and-penalty-shoot-outs-Online).
The feed lacks explicit tie/leg identifiers, so only two distinct reversed
home/away fixtures with ordered dates in a known CL round support a two-leg
aggregate. A missing return fixture is not assumed to be a special one-leg tie.

Validation on an isolated export excluding native work:
- 1,483 JavaScript tests and production build passed.
- `scripts/qa/knockout-rounds.js` checks all 45 captured ties and 90 leg links,
  phase/round selection, reload and Back, drawer focus restoration, live
  aggregate and penalty updates, a single-match final, loading and unpublished
  fixtures, retained results during feed failure and recovery. No overflow at
  320, 390 or 1440px. Historical inputs are stored in `scripts/qa/fixtures/`.
- Browser testing found and fixed a round-selection jump when a live tie finished.
  The selected/default round is now retained through score updates and keeps
  keyboard focus. The main scores overview's 17 browser regressions also passed
  after the route formatter changed to named options.
- Visual evidence: [mobile](live-score-evidence/mobile-qualifying-ties.png) and
  [desktop](live-score-evidence/desktop-qualifying-ties.png), replaying the captured
  September 10 feed rather than claiming current fixtures.

Not deployed. P0 latency correlation remains open; next product work is match
detail section navigation and coverage states. Preserve separate native edits.

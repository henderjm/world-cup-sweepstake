# Daily live-score product backlog

Updated: 2026-10-04. Owner: ongoing Codex task. Branch: `codex/live-score-quality`.
Starting revision: `bfaf0a66e03febeda47647789e275853155ef638`.

## Mandate and continuation

September 26 priority reset: the user requested a structural reassessment and
is open to AWS and a larger API plan. The next P0 is the dedicated collector and
stored-data read path proposed in `docs/live-score-architecture.md`, beginning
with local implementation and a priced infrastructure plan. Deprioritize further
GitHub-feeder refinements. No AWS resources, subscription upgrade or public
cutover has been approved or performed by this assessment. Current read-only
evidence: the quota endpoint reports 7,492/7,500 daily requests remaining; PL
responded successfully while a CL sample returned 502. Daily exhaustion alone
does not explain that sample. GitHub main and latest listed workflows remain on
September 14 revision `07867e6`; later local fixes are not production evidence.

September 26 release authorization: the user requested "push the fixes".
The release includes the completed score, fallback and feeder changes through
`996c6d4`. A read-only download of active Worker version
`a0860be8-13ad-4fd9-a05f-f63fd650582e` (September 19) exactly matches the release
bundle after normalizing build-directory paths, including the native sign-in
and notification backend. Those already deployed backend sources and Android
audience configuration are now included in the release to prevent a regression
on the next deployment. Separate mobile frontend/packaging work remains local.
The isolated release passes 1,563 JavaScript tests, the production build, Go
tests and Worker bundling. AWS infrastructure and API-plan changes remain
proposals; this release authorizes neither new spending nor that cutover.

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

Browser testing preference, September 19: all browser checks and competitor
inspections must run headlessly, including hourly continuations. Do not launch
visible Chrome or steal focus. Use `scripts/qa/run-headless.mjs`; setup and
fixture prerequisites are in `scripts/qa/README.md`. Capture screenshots from
the headless browser when visual review is needed.
Verified the headless runner against `feeder-continuity.js`: mobile scores
advanced 1–0, 2–0, 3–0, retained 3–0 with a 121-second stale age, then recovered
to 4–0; desktop overflow and page-error checks passed. This used an isolated
local build and simulated provider, with no public release.

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

New leagues are explicitly out of scope for now (user direction, September 19).
Continue competitor analysis and implementation within PL/CL.

## Prioritized remaining work

October 4 continuation: the previous goal turn was progress (the reliability
contract was committed as `936aa0d`). This turn implements the first bounded
baseline recorder; see the dated evidence section below. The wider reliability
goal is still unproven and active.

| Priority | Item | Definition of done |
| --- | --- | --- |
| P0 — first | Measured matchday reliability | Implement `docs/live-score-reliability.md`: establish an independent baseline, target 99.95% usable scoreboard availability and 99.9% collection freshness during active match windows, measure provider-to-screen delay separately, verify alert delivery and standby takeover, and retain per-competition/worst-fixture reports. These are targets, not achieved nines. Provider failures count against the user-facing result. No feature expansion ahead of this work. |
| P0 | Provider rate-limit failures and intermittent stalls | September 14 tagged production logs confirm a PL request was rejected by the provider per-minute limit with daily quota remaining. The five-second provider deadline is deployed. September 19: a one-second admission limit for the isolate's upstream queue is implemented and browser-verified locally; excess reads reach existing saved-data recovery without issuing another provider call. Global pacing across isolates/egress remains open. This does not establish the cause of the earlier CL request exceeding 20 seconds, followed by calls taking 21–23ms. Correlate request timings with upstream/cache waits before assigning the cause. A route can make several upstream reads, so these limits are not a total route deadline; the frontend eight-second limit alone is insufficient. |
| Deployed September 14 | Show league tables on wider screens | At desktop widths (initial target: 1200px and above), show the relevant league table alongside Scores without a separate tab change. In All matches, make the table's competition explicit and selectable. Preserve date, Live and Following selections; tables use the same feed and disclose stale/unavailable data. Verify 1200px and 1440px layouts, keyboard access and no horizontal overflow; mobile scores remain usable at 320px and 390px. Requested by the user September 10. |
| Ready for review | Preserve standings through partial feed responses | September 19: browser recovery and Worker saved-table metadata implemented. Retain each table's retrieval timestamp through memo/shared-cache reads, refusal, empty responses and reloads; mark saved tables separately without backdating fresh scores. Reject saved tables older than seven days. Validate concurrent callers, first visits, missing fallback, genuine unpublished states and recovery. All checks pass locally; not deployed. |
| Ready for review | Keep supplementary player stats from delaying scores | Bound the scorer-file wait to 1.5 seconds including body reads. With a healthy score feed and stalled stats, show scores within 3.5 seconds of local browser navigation at 390px and 1440px. Distinguish loading, unavailable/Retry, unpublished and recovered data; preserve fixture freshness and verify no page errors or overflow. September 19 checks pass. |
| P1 | Restore automatic Worker publishing | GitHub's Worker workflow currently skips deployment because `CLOUDFLARE_API_TOKEN` is unset. Configure an appropriately scoped deployment credential and verify the actual deploy step runs on the next approved release. A green skipped workflow is not deployment evidence. The September 10 release was deployed successfully using the existing local OAuth login. |
| P1 | Measure actual event latency | Compare timestamped provider events and observed delivery across live matches. Establish p50/p95 delay and update reliability; feed age alone does not prove event latency. |
| Deployed September 14 | Qualifying versus main knockout presentation | Keep qualification history available, but avoid presenting a wall of July fixtures as the main knockout destination in September. Group two-leg ties with correct aggregate and penalty handling; never invent future draws. |
| P1 | Referee profiles and match context | Open referee history from match detail within PL/CL. Verify identity mapping before grouping names; show competition, period, counted matches and missing coverage. Derive only supported card statistics from complete saved match data. Do not treat scored penalties as penalties awarded or claim foul averages without that feed. Reuse cached data; no new per-visit provider calls. |
| P1 | Team identity and labels | The feed says Sabah FA while both benchmarks say Sabah FK. Verify provider team ID, crest and destination before changing display aliases; do not rewrite stored follow keys based on a name alone. |
| Deployed September 14 | Match detail navigation/accessibility | Persistent Overview, Timeline, Line-ups and Banter shortcuts with 44px targets. Retain focus, reading position, score route and drafts through refreshes; distinguish loading, absent coverage, initial failure and delayed detail. Verify scheduled, live, finished, postponed and cancelled states at 320, 390 and 1440px. |
| P1 | Match statistics coverage | Audit completed September 14: team metrics are absent from the mapped payload and current fetch paths. Establish an endpoint/cache/request budget and preserve nulls before adding a Stats destination. Show supported metrics with source/coverage states; preserve per-player and fantasy contracts. Do not imply zero when a metric is absent. |
| Deployed September 14 | Recover either team's missing line-up | A started match with one published XI checks the static detail even when events and player stats are present. Recover only the missing side with its formation, coach and bench; keep fresh sections intact, and prefer the live XI when it returns. Missing saved coverage stays explicit. |
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


## September 11 — release approval gate

The user requested deployment. Release `2932bfa` was prepared from an isolated
committed export, with 1,483 tests, production build and Worker dry run passing.
Automatic approval review rejected publishing the Worker because it did not
accept the generic deployment instruction as approval for this exact release.
The user was asked to approve `2932bfa` explicitly for website and Worker.
Neither the Worker nor Pages was published, and main was not pushed. Do not
retry through a different deployment path while that gate remains unresolved.
The last verified published code remains `63bad30` (September 10).

## September 11 — match-detail sections, ready for review

Added persistent Overview, Timeline, Line-ups and Banter shortcuts with labelled
section targets, keyboard focus and 44px touch targets. The close button remains
visible while scrolling. Section navigation preserves the scoreboard route.
Banter stays mounted so polling does not discard an unfinished message.

Timeline and both teams' line-ups now have explicit loading and coverage states.
Postponed/cancelled fixtures show their status in the score header. Removed
unsupported promises that missing detail would return on the next refresh or
that a score necessarily remains live during a detail outage. Available venue
and referee information survives an otherwise empty response; one missing
line-up does not hide the other team's players. Known detail survives failed
refreshes, while coverage wording follows a match changing from scheduled to live.

Browser testing initially found a 145px line-up jump when five events arrived
above it. Refresh now preserves the visible/focused section's viewport position,
including when analysis or the detail error notice appears. It restores section
focus after replacing detail content and retains the banter input node and draft.

Validation on an isolated export excluding separate native-app changes:
- 1,491 JavaScript tests and production build passed.
- `scripts/qa/match-detail-sections.js` passes nine scenario groups: 320/390/1440px
  navigation through loading, stable line-ups and draft during event growth,
  failure-notice stability, retained detail/retry, focus restoration, unchanged
  route, touch-target size and no overflow; plus scheduled, live, finished,
  postponed, cancelled and initial-error coverage. The scheduled scenario also
  checks kickoff during an outage retains known metadata and updates the copy.
- Existing `live-match-drawer.js` regression passes all nine groups, including
  exact scroll retention with close focused, event-only updates, focus trapping,
  failed-refresh retention and closing/reopening during a held request.
- Inspected [mobile](live-score-evidence/mobile-match-sections.png) and
  [desktop](live-score-evidence/desktop-match-sections.png) screenshots. These use
  synthetic events to stress a long drawer, not current match results.

Not deployed. Next bounded product work: audit match statistics coverage before
adding metrics, or resolve the provider team identity mismatch. P0 production
latency correlation remains open; the provider timeout protection is still local.
Preserve the separate native work and the pending release approval boundary.


## September 14 — independent line-up recovery, ready for review

Completed the interrupted September 11 work. A Worker detail response could
contain events, player stats and one team's XI, score as fully populated, and
skip the static fallback. Even when another gap triggered the fallback, the
merge treated both teams as one section, so one present XI blocked the other's
recovery. The drawer now checks the saved detail for either missing XI in a
started match and merges each team independently. Formation, coach, starters
and bench move together; fresh players, events and stats remain authoritative.
An entirely absent side also recovers its team name and crest.

Validation:
- Isolated export excludes separate native work; 1,494 tests and build passed.
  September 14 verified source hashes and the served asset `index-CXVe7DPC.js`
  still match that tested build. No code changed between those checks.
- `scripts/qa/partial-lineups.js` passed three browser scenarios: missing home,
  missing away, and unavailable saved coverage. Fresh starters/bench/events stay
  intact; a later complete live response replaces saved players, stops redundant
  fallback reads and preserves the section focus and viewport position.
- `scripts/qa/match-detail-sections.js` passed all nine groups against this build
  on September 14, including 320/390/1440px navigation, loading, missing coverage,
  failure/retry, retained details, stable drafts and postponed/cancelled states.
  Earlier attempts were interrupted by the browser closing; those attempts are
  not counted as passes. Existing screenshots were retained without timestamp churn.

Statistics audit (repository evidence, not a live provider coverage claim):
- Worker, bake and feeder fetch lineups, events and player payloads, but no
  `/fixtures/statistics` payload. `mapApiFootballMatchDetail` transports no team
  possession, shots or expected-goals metrics.
- `mapPlayerStats` currently transports minutes, position and defensive counts
  used elsewhere, and defaults missing counts to zero. Those fields cannot safely
  stand in for team match statistics or distinguish absent defensive coverage.
- A statistics feature needs explicit nullable ingestion, coverage states and a
  bounded provider/cache budget. No new provider endpoint, purchase or request
  volume was introduced in this fix. Existing fantasy/statistics fields are unchanged.

Not deployed. Next bounded work: verify the Sabah provider identity before any
label change. P0 production latency correlation and the pending public-release
approval remain open. Preserve the unrelated native-app edits.


## September 14 — approved release deployed and verified

The user explicitly requested "deploy them" after the completed local fixes.
Published code `07867e6305df25456569113b757cf4cdc476aa21` from a clean committed
export, excluding all separate uncommitted native work. This supersedes the
September 11 release approval gate for these completed changes only.

- Pages deployment [34822635110](https://github.com/henderjm/world-cup-sweepstake/actions/runs/34822635110)
  succeeded. Production serves `index-CXVe7DPC.js`, matching the tested build.
- Worker `goon-squad-data` deployed with existing local OAuth, version
  `0f07f1fa-0f27-4407-88cd-1ccd6e203853`. Tagged runtime logs confirm that version
  handled the checked public requests. Its five-second deadline bounds each
  provider read; it is not a total route-latency guarantee.
- Automatic Worker workflow [34822635107](https://github.com/henderjm/world-cup-sweepstake/actions/runs/34822635107)
  still skipped publication because its repository token is unset. The explicit
  local deploy, not that green skipped workflow, is the Worker release evidence.
- The deployed static fallback refreshed PL to `2026-09-14T08:25:54.458Z` and CL
  to `2026-09-14T08:25:55.070Z`. PL contains 380 fixtures and 20 standings rows;
  CL contains 234 fixtures and 36 standings rows. September 12–13 PL matches are
  final, rather than reverting to the old committed seed.

Production browser checks (real live/static data, no clock override):
- Desktop All matches has the selectable standings panel; selecting CL displays
  all 36 league-phase rows. Champions League qualifying defaults to seven
  play-off ties with 14 leg links.
- At 390px, September 13's Man United–Man City fixture shows 0–1. Opening it
  loads events and both line-ups; section navigation works and Escape restores
  the match row focus and date route. No page or drawer overflow and no JS errors.
- With Worker requests deliberately blocked in an isolated browser context,
  production fallback still displays that final score and all 20 PL standings
  rows, labels both feeds/standings delayed and exposes retries. The test makes
  no changes to production data.

Unresolved provider problem observed during verification:
- Initial public checks returned 502 for both competitions. Later tagged CL
  returned 200 in 366ms, while tagged PL returned 502 in 182ms (54ms Worker wall
  time). The PL request log explicitly reports API-Football's per-minute rate
  limit rejection on `/fixtures`, delivered inside an upstream HTTP-200 error
  payload. This was not a five-second timeout. Quota diagnostics at the time
  showed 7,282 of 7,500 daily calls remaining and a temporary limited flag.
- Other checks and the deployment refresh successfully obtained both feeds.
  This is intermittent; successful fallback and deployment do not resolve it.
- One fresh PL browser response displayed "No standings published yet" while
  the deployed fallback had 20 rows. Added a P0 recovery item; avoid presenting
  missing upstream coverage as a genuinely unpublished league table.
- Tagged tail was stopped. Full request headers were kept only in temporary
  diagnostic output; this record contains the relevant status/version/error.

Next: prioritize provider refusal/pacing evidence and partial-standings recovery.
The previous 20-second CL stall still lacks correlated cause evidence. No new
spending or production data mutation occurred. Future public changes require
approval. This release record itself is a local documentation commit.


## September 19 — competitor refresh and standings recovery, ready for review

User direction: continue backlog, competitor analysis and implementation; do not
expand leagues for now. The existing hourly continuation remains appropriate.

Targeted competitor inspection at 390px and 1440px:
- [FotMob referee profile](https://www.fotmob.com/referees/1001070362/ricardo-fierro)
  exposes season totals for matches, yellow/red cards and penalties; it separately
  labels a multi-year comparison period for card/foul averages and lists recent
  matches. The profile fit both widths. Product takeaway: show the sample and
  period alongside any referee statistic. Our mapped referee is currently a name;
  reliable identity grouping and explicit coverage are prerequisites. Fouls and
  all penalties awarded are not present in the existing mapped detail.
- [LiveScore standings](https://www.livescore.com/en/football/england/premier-league/standings/)
  exposes league-level fixtures, results, standings, player/team-stat navigation
  and describes home/away/form tables. Browser inspection loaded the shell and
  explanatory content at both widths but did not expose table rows in the sampled
  state, so do not claim live-table parity or latency verification. The obsolete
  `/table/` path returned 404; use `/standings/` for future checks.

Implemented independent recovery for an empty/missing TOTAL standings response:
- Keep the fresh fixture payload and score timestamp. Recover a valid same-season
  table from this visit/device, otherwise check the existing static file with a
  three-second bound. No new provider requests. An initial missing-table recovery
  can add up to three seconds before this competition finishes loading; known
  saved tables avoid that additional request.
- Retain the table's own timestamp, mark it saved/delayed on desktop and the full
  mobile table, and mark the hero's saved leader. Disable live table projection
  and derived form on a recovered table rather than combine unmatched snapshots.
- Recovery persists across reload, or works for the visit with storage blocked.
  Reject wrong-competition, wrong-season, malformed, future-dated and more than
  seven-day-old candidates. The seven-day maximum is a product retention limit,
  not a freshness promise. A valid live table clears the saved state.
- A started league with no recoverable table says temporarily unavailable with
  Retry; an unstarted or qualifying-only competition can still say unpublished.
  This handles absent tables, not partially truncated tables with some valid rows.

Validation on an isolated export excluding native edits:
- 1,505 tests and production build pass. New tests cover separate score/table age,
  cached reloads, bad candidates, season isolation, blocked storage, safe recovery,
  genuine unstarted states and no invented live projections.
- Six browser scenarios cover known saved table, first-visit static recovery,
  unavailable static data, pre-season empty state, wrong season and blocked storage.
  Fresh score changes survive partial responses; Retry clears saved/unavailable
  status; mobile full table fits and saved timestamps never inherit the score age.
- Existing desktop standings regression passes ten groups, including loading,
  initial error/retry, table selector/focus, filters, Back and 320/390/1024/1200/1440
  layouts. Its live-but-empty expectation now correctly says unavailable.
- Synthetic visual evidence: [desktop](live-score-evidence/standings-recovery-desktop.png)
  and [mobile](live-score-evidence/standings-recovery-mobile.png). These are recovery
  fixtures, not current league positions.

Not deployed. Next P0 work remains provider throttling/pacing and preservation of
fresh scores under that pressure. Referee context is now a scoped P1 feature;
no new leagues, spending or provider request paths were introduced.

## September 19 — bounded provider queue, ready for review

The five-second provider timeout starts after request pacing. The old pacing
queue had no admission deadline, so concurrent uncached reads could spend the
browser's response budget waiting to start. The queue now rejects reads that
cannot start within one second, while preserving the 200ms minimum spacing.
Rejected reads issue no provider call and use the existing delayed-data/error
paths. Cache hits still bypass the queue; a rejected or late timer does not wedge
later requests. The clock used for pacing is monotonic.

Acceptance evidence on an isolated export excluding unrelated native edits:
- All 1,509 tests pass, including deterministic burst spacing, excess admission,
  delayed timer and queue recovery cases, and a real Worker route burst retaining
  its previous score and timestamp before recovering on a later read.
- Production build and Worker bundle dry run pass; no deployment performed.
- Mobile browser against the actual Worker with a local simulated provider:
  initial response 419ms, overloaded response 924ms, recovered response 342ms.
  A 1–0 score remains visible with “Live data is behind”; recovery changes it to
  2–0 and clears the notice. No page errors. This is a controlled fixture, not
  production latency evidence.
- Reproducible scripts: `scripts/qa/queued-provider-server.mjs` and
  `scripts/qa/worker-provider-queue.js`. The burst starts with the incoming live
  request so browser navigation does not consume the overload window first.

Limitations and next work:
- This bounds admission in one isolate. It does not enforce an account-wide
  provider rate limit or resolve shared-egress throttling.
- Multiple sequential provider calls can still accumulate latency within a
  route. Preserve fresh score reads if supplementary data cannot finish.
- Provider throttling remains P0 pending correlated production measurements and
  a concrete cross-isolate pacing decision. Referee context remains P1 and new
  leagues remain out of scope. Public release still requires approval.

## September 19 — supplementary player stats no longer hold scores for eight seconds

Found a separate browser-side delay: `loadModel` waits for both the live feed and
static scorer file. A stalled scorer download could hold already-fetched scores
for its full eight-second timeout. Its timeout is now 1.5 seconds, including body
reading. This is an intentionally short budget for supplementary data; a slow
connection can show the unavailable state, with Retry, while scores remain usable.

Player stats now distinguishes a failed/malformed response from a valid empty
board. Failure says temporarily unavailable and offers Retry; an empty board
says statistics are not published yet, without claiming that no goals occurred.
The visible failure flag participates in refresh detection so a successful empty
response can clear it even when the fixture scores are unchanged. No new API
calls, providers or leagues were added.

Validation on an isolated export excluding unrelated native work:
- 1,516 tests pass and the production build succeeds. Focused tests cover stalled
  headers/body, malformed rows, error/empty/recovered states, preserved fresh
  scores, and refresh detection without a score change.
- Real browser checks at 390px and 1440px exercise initial loading, stalled downloads, failed
  Retry, empty results, successful recovery and score updates. Scores appeared
  in 2,033ms and 2,036ms including navigation while the scorer request remained
  stalled. Delayed fixtures keep their warning; fresh fixtures remain fresh.
  No page errors or horizontal overflow. These are synthetic local timings.
- Reproduction: `scripts/qa/scorer-loading.js` against the production preview.

Next: the Worker still awaits standings after fetching scores. Its error path
can reuse the previous table without an independent age marker; inspect that
alongside its request budget before changing it. Account-wide provider pacing
and correlated production latency measurements remain open P0 work. This change
is local and requires approval before public release.

## September 19 — Worker standings freshness is independent of scores

Confirmed two related problems: a refused standings request could reuse the
Worker's previous rows with a fresh score timestamp and no saved-data marker;
a table recovered from the shared cache could instead backdate fresh scores.

The Worker now reports `standingsUpdatedAt` and `standingsDelayed` separately.
Payload metadata retains the retrieval/cache timestamp through memo hits and
coalesced callers, so a repeated read cannot make an old table younger. Empty
or refused table responses retain the previous same-season rows with their
original timestamp and a saved marker. A healthy table clears that state.
The browser stores this table timestamp independently of scores and applies its
existing seven-day retention limit to server-recovered tables too. Expired rows
reach the established fallback/unavailable path. No additional provider reads.

Acceptance evidence, isolated from unrelated native edits:
- 1,519 tests pass. The real Worker route test covers memo hits, concurrent
  refusals, shared-cache stale recovery, expired shared cache with isolate
  fallback, empty provider responses, healthy recovery, and cold isolates.
  Fresh score timestamps remain current while table timestamps stay unchanged.
- Browser recovery suite passes eight scenarios at desktop and mobile widths:
  device-saved, first-visit fallback, unavailable, preseason, wrong season,
  blocked storage, server-saved and server-expired. Saved tables retain their own
  age across reload, avoid live projection and unnecessary fallback reads, and
  clear their marker after Retry succeeds. No page errors or mobile overflow.
- Production build and Worker bundle dry run pass. Browser fixtures are synthetic;
  these checks do not establish production freshness or event-delivery latency.

Next P0: standings requests still run after the score requests and can consume
up to the provider timeout. Bound this supplementary wait without leaving an
untracked background request or losing fresh scores. Account-wide pacing and
correlated production latency measurements remain open. Referee context remains
P1, new leagues remain out of scope, and public deployment requires approval.

## September 19 — bounded standings provider wait

Standings used the same five-second provider timeout as score-critical reads,
although the live route requests them after obtaining the scores. They now have
a 1.5-second deadline beginning before the upstream queue wait and covering both
response headers and body. An expired queued request is not sent. Cancellation
reaches the existing marked saved-table or missing-table paths; it does not leave
a background origin fetch running. Other endpoints retain their five-second
provider timeout. No retries or extra provider calls were added.

This is a supplementary-data policy: a table response taking longer than the
budget can fall back even while the provider is technically available. The
saved-table notice and Retry make that tradeoff visible. It is not a total route
deadline: fixture reads, cache access and browser static recovery also take time.

Acceptance evidence from an isolated export excluding unrelated native work:
- 1,521 tests pass; production build and Worker bundle dry run pass.
- Real Worker route tests cover header/body stalls, warm saved tables, cold empty
  table coverage, cancellation, concurrent-request coalescing, and later recovery.
  Scores and their timestamps stay current; saved table timestamps do not advance.
- Browser against the real Worker and a local simulated provider: desktop slow
  table response 1,593ms, mobile first-visit body stall 1,705ms. Both are below the
  2.5-second local response acceptance bound; later mobile stalled read 1,503ms.
  Fresh scores remain visible, desktop shows the saved table, mobile explains
  unavailable standings, and Retry restores the table and next score. No page
  errors or horizontal overflow. These are controlled timings, not production
  latency measurements.
- Reproduction: `scripts/qa/stalled-standings-server.mjs` and
  `scripts/qa/worker-standings-timeout.js`.

Next P0: measure where production time is spent (cache, queue, provider and
browser fallback) and correlate provider refusals across consumers before
choosing a cross-isolate pacing policy. The known per-minute refusals are still
unresolved. Avoid extending timeout tuning without fresh evidence. Referee
context remains P1; no new leagues. This change is not deployed.

## September 19, 15:19–15:27 UTC — intermittent score-update incident

User reported wrong/frozen scores, then confirmed they had caught up. Exact
match and incorrect score were not supplied, so the preceding failure is not
attributed to a specific provider refusal or client state.

Current production evidence:
- Mobile kickoffdraft.com serves the September 14 asset `index-CXVe7DPC.js`.
  The later reliability improvements remain local. No browser page errors.
- Real browser observed PL responses at 15:21:40 and 15:22:00, confirming the
  twenty-second poll. Both contained the same scores/minutes, but `lastUpdated`
  advanced to the response time. Code confirms a cached live batch (60-second
  TTL) was being re-dated on every response. This proves misleading freshness,
  not that the underlying scores were wrong at those two instants.
- Newcastle's observed minute advanced from 60 to 61 and Everton from 63 to 64
  during diagnosis. User independently confirmed the scores were then right.
- Quota check: limited=false, 6,792/7,500 provider calls remaining. This snapshot
  cannot rule out an earlier refusal. The backup feeder was active; completed run
  35451113100 logged accepted five-fixture ingests at 15:13:11, 15:14:22,
  15:15:23 and 15:16:23. Next run 35451449171 began its job at 15:19:32. The
  workflow deliberately waits three minutes before re-arming, leaving a backup
  coverage gap. Accepted ingestion alone is not proof of live score delivery.
- Competitor pages did not expose usable live match rows during this check;
  there is no independent timestamped competitor score comparison for the fault.

Implemented source-age correction:
- Live score responses keep their batch retrieval timestamp through in-memory
  and shared-cache hits. A new successful batch advances it; repeated browser
  polls do not. Concurrent readers of a stale cache result also inherit its age.
- Later isolate fallback retains that original score age. Pushed safety copies
  keep their own timestamp. No shorter polling interval or extra provider reads.
- 1,522 tests and production build pass; Worker bundle dry run passes. Real
  browser against the actual local Worker shows “just now”, “20s ago” on a
  cached read, then “just now” on a new score; a stalled provider retains the
  score with “6m ago (delayed)”, and recovery updates the score and clears delay.
  No page errors. Reproduction: `scripts/qa/score-source-age.js`.

The timestamp bug is fixed locally; the reported intermittent score lag remains
open. Next: correlate source batch times, actual event arrival, provider refusal
and feeder-gap intervals. Review continuous backup coverage within the existing
quota before changing its cadence. This incident does not authorize deployment.

## September 19 — reduce deliberate gaps in backup score delivery

The incident investigation found a three-minute restart pause after roughly
four score passes. Local changes extend the active loop budget from four to six
minutes and reduce the pause to one minute when matches are live or discovery
is uncertain. Idle/finished days retain the three-minute pause. In the controlled
normal-duration run, the next detail run starts at the same point in the cycle,
with six score pushes instead of four. Detail still runs once per job.

Additional safeguards:
- A failed/malformed discovery or an empty response after a live pass does not
  declare the matchday idle. Detail is still fetched after the first successful
  discovery when the initial attempt failed. The bounded loop retries; real finished fixtures
  return to the slower cadence.
- Provider reads and ingest writes have ten-second header/body deadlines.
  The detail loop stops starting matches after the run budget is exhausted;
  unfinished detail work is left for the next job.
- Workflow output chooses the restart pause, with the previous three-minute
  delay retained if the step fails before producing output. Existing concurrency,
  queued-run check, execution window, and configured PL league remain intact.

Acceptance and evidence:
- 1,529 tests and production build pass; workflow YAML parses. Seven new tests run
  the actual feeder script against a simulated provider and clock, covering live
  cadence, initial/transient/empty/malformed discovery, failed ingestion, idle fixtures
  and newly finished games. Detail requests are unchanged in the normal-cycle
  comparison; scheduled live pushes are at most 62 seconds apart in that fixture.
- The typical change costs two extra fixture reads per roughly six-minute cycle:
  approximately 220 extra reads across eleven continuously live hours for the
  single configured competition. This is a planning estimate, not a global cap
  or billing forecast. Recheck actual quota after an approved rollout.
- A real browser against the local Worker ingestion route sees backup scores
  advance 1–0, 2–0, 3–0 while the primary provider is refused. A simulated missed
  push retains 3–0 with its 121-second age, and the next push delivers 4–0. The
  delayed-source warning remains explicit. No page errors or desktop overflow.
  The browser fixture validates ingestion and display, not GitHub runner timing.
- Reproduction: `test/live-feeder.test.js`, `scripts/qa/feeder-browser-server.mjs`
  and `scripts/qa/feeder-continuity.js`.

Limits: GitHub queue/setup delays can still extend the handoff. Slow detail work
can delay the second score pass; the first push is sent before detail begins.
A first-pass empty response has no prior live state to distinguish missing
coverage from an idle day. The feeder currently covers PL only; CL is an existing
competition needing backup coverage, but enabling it should avoid polling its
empty matchdays once a minute. None of this is deployed; the public-release
approval request remains pending. Do not count the intermittent incident resolved
until an approved release is checked during actual matches.

Next P0: verify live runner-to-runner gaps and source delivery after approval;
prepare efficient CL backup coverage and continue correlating provider refusals.

## September 19 — Champions League backup coverage and quota safeguards

Prepared locally: the feeder and workflow now include the existing Champions
League alongside Premier League. This does not add a new product league. Each
competition has its own polling state: live or uncertain discovery retries,
an idle competition is read once per job, and a known upcoming kickoff resumes
discovery within the job. Extra time, the extra-time break and penalties remain
active, using the same status rules as the Worker.

All due competitions receive their first score push before optional match
detail starts. Provider requests share a 400 ms minimum spacing within this
process. Optional detail stops at the existing 15% daily-quota threshold,
including when the threshold is crossed mid-match. Missing quota headers retain
the last known reading. HTTP 429, provider allowance errors and a zero minute
allowance pause this process's upstream requests for 60 seconds; score reads
resume afterwards. This is not a rate limiter shared with the Worker or other
jobs, and does not guarantee the account cannot reach its limit.

Acceptance and validation:
- 1,544 tests pass, including 22 feeder scenarios. The production build and
  workflow YAML parse pass in an isolated checkout excluding unrelated mobile
  work.
- In a simulated six-minute run with both competitions live, each receives six
  score pushes, with no repeated detail batch and no push gap above 65 seconds
  for the immediate-response fixture. All provider reads are at least 400 ms
  apart. Defaults and workflow configuration include PL and CL.
- An empty CL matchday costs one discovery while PL continues its six passes;
  the reverse is also tested. Both idle return to the slower restart cadence.
- A kickoff 90 seconds into the run resumes CL reads within 60 seconds of
  kickoff. CL failures and transient empty responses recover while PL continues.
- Low/critical quota retains score delivery for both leagues without detail
  requests. Refusals prevent an immediate request to the next competition.
- Headless mobile/desktop checks for both PL and CL use the actual local Worker
  ingestion route with primary-provider refusal. Scores advance 1–0, 2–0, 3–0;
  a missed push retains 3–0 with a 121-second age; recovery displays 4–0.
  No page errors or desktop overflow. Reproduce with the instructions in
  `scripts/qa/README.md`. These checks simulate source delivery, not GitHub
  scheduling or production latency.

Budget planning: an idle additional competition adds one read per job; a live
one adds approximately one fixture read per minute plus four reads per eligible
match's detail batch while quota is healthy. The number of jobs, match count and
provider latency determine the actual daily spend. No paid service was added.

Release gate / next P0: slow detail fan-out can still delay subsequent score
passes, especially on a crowded CL matchday. Bound or interleave that work and
test a full slow matchday before releasing this feeder expansion. GitHub
queue/setup gaps and late matches around the 22:00 UTC restart cutoff also need
production measurement or explicit coverage. The intermittent score incident
remains open, and the public-release approval request remains pending.

## September 19 — score polls continue through slow match-detail work

Reproduced the release-gating delay above using one PL and eighteen CL fixtures,
with each detail response body taking nine simulated seconds. The previous
feeder sent just one score push per league and then spent the remaining job on
detail. The regression test failed before the scheduler change.

The feeder now queues one detail batch per competition and checks for due score
polls between each detail read and before detail ingestion. It sleeps until the
next competition is due, instead of adding a minute after completing all detail.
Requests retain their ten-second limit and are also capped by the remaining
six-minute run budget. This includes response-body reads and ingest writes.
Timed-out ingestion bodies are reported as failures rather than silently parsed
as an empty successful response. Quota shedding and provider pacing remain in
place, without concurrent upstream fan-out.

Acceptance and evidence:
- The same slow-matchday trace now contains six pushes for each league, with a
  maximum 63,800 ms gap, nine completed detail ingestions and no repeated detail
  batch. The run ends at 360,000 ms, cancelling its last incomplete request.
- Regression scenarios include stalled detail headers, stalled detail bodies,
  slow detail ingestion, idle days, kickoff transitions, quota refusal and
  recovery. In the four crowded fixtures, both leagues retain at least five
  pushes and no gap exceeds 71 seconds. Those bounds assume responsive score
  discovery/ingestion; they are not a production service-level guarantee.
- A separate real-clock check proves the actual abort signal cancels a stalled
  detail body at the shortened run deadline; it does not rely on fake timers.
- 1,549 tests pass, including 27 feeder cases; the isolated production build
  passes. Unrelated native/mobile and Worker changes were excluded.
- The headless browser replays the actual slow-feeder trace through the local
  Worker's ingestion route while the primary provider is unavailable. All six
  scores, 0–0 through 5–0, appear in both PL and CL. Backup-source warnings remain
  visible; mobile and desktop checks have no page errors or overflow.
  Reproduction: `scripts/qa/README.md` and `scripts/qa/feeder-scheduling.js`.

The slow-detail release gate is addressed locally. Remaining P0: verify actual
runner handoffs and score-source delivery after an approved rollout, and cover
late matches around the 22:00 UTC restart cutoff. Detail remains best effort:
severely slow providers can leave later matches without a new detail snapshot
within a job; repeated-job fairness is a follow-up. Source refusals and GitHub
queue delays can still cause stale scores. No public deployment was performed,
and the intermittent production incident remains open.

## September 19 — late matches survive the restart cutoff and midnight

Two distinct gaps were present: the workflow stopped self-dispatching at 22:00
UTC even when scores were still live, and both discovery and Today's screen
could drop an ongoing match when the date changed.

Prepared locally:
- Daytime rearming remains 11:00–22:00 UTC. Afterwards, live/uncertain fixtures
  and known upcoming kickoffs can keep the chain running until 03:00 UTC. Empty
  or finished matchdays stop self-dispatching. The policy is checked before and
  after the restart pause; a missing output does not start an overnight chain.
  The existing scheduled triggers through the 22nd UTC hour are unchanged.
- Between midnight and 03:00 UTC, discovery combines the previous and current
  UTC dates, including a cold job with no inherited state. Date rollover
  invalidates a competition's idle polling state. A failed date read preserves
  the existing backup instead of publishing a partial snapshot as fresh.
- Today and its Live filter include matches still live from the viewer's
  previous local day, with an explicit explanation. Historical dates retain
  their kickoff-date semantics; finished matches stay on their original date.
  Older stuck statuses from before yesterday are not added to Today.

Acceptance and evidence:
- Boundary tests cover 21:59, 22:00, midnight, 02:59, 03:00 and the next daytime
  window, plus a year rollover. The executable command used by the workflow is
  tested with late follow-up both enabled and disabled.
- The actual feeder script sends six CL pushes across a simulated 23:58–00:03
  run. A fresh 00:10 job discovers the previous day's fixture. A full-time result
  is delivered before overnight follow-up is disabled. Partial failures keep
  retrying without refreshing an incomplete backup.
- Headless mobile/desktop replay of that feeder trace through the local Worker
  shows all six scores on Today across midnight and the overnight explanation,
  with no page errors or desktop overflow. Provider refusal is simulated; the
  backup delay warning remains visible. This is not a production latency claim.
- 1,558 tests and the isolated production build pass. Workflow YAML parses.
  Unit rendering checks cover the combined home screen, single competition,
  Live filter, historical dates and finished/older matches using Dublin time.
  Reproduction is documented in `scripts/qa/README.md`.

Limits and next work: 03:00 UTC is an explicit cap against a stuck provider
status or prolonged outage, not round-the-clock coverage. During an active
overnight job each due competition uses two discovery reads per poll instead of
one; request pacing, quota shedding and the job budget remain intact. Existing
cron starts still determine whether a chain begins, and GitHub queue delays can
extend gaps. P0 remains approval-dependent runtime validation of runner handoffs
and score delivery; detail fairness on repeatedly slow matchdays is next local
work. Nothing here is deployed and the production incident remains open.

## October 4 — durable API reliability recorder implemented locally

`scripts/measure-score-reliability.mjs` now records an explicit observation plan
and bounded PL/CL reads to an append-only ledger. Its report reconstructs missed
checks after interruption, preserves expected fixtures when responses lose them,
and reports per-competition/per-fixture failures. Fresh final results retire a
fixture; stale finals do not, and a fresh live correction reopens it. Timeouts
cover response bodies, and failed requests remain in latency measurements.

The current production hostname is limited to one probe per competition per
minute to avoid turning monitoring into extra provider pressure. There are no
retries or cache-busting parameters. Reports explicitly measure feed-reported
age, not independently verified source freshness or browser availability.
No active expected fixtures yields a null freshness percentage. Usage, expected
schedule preparation and limits are in `docs/score-reliability-recorder.md`.

Validation:
- Sixteen focused tests cover missing observations/fixtures, competition
  isolation, invalid/old/future data, terminal corrections, live statuses, clock
  skew, duplicate logs and quota protection. A real local HTTP process exercises
  recording/reporting, interrupted final writes and cancellation of stalled bodies.
- The working-tree regression suite passes 1,588 tests (including the existing
  separate native work). No UI/product runtime code changed in this increment.
- Read-only production evidence around 09:50–09:52 UTC: the preliminary PL read
  returned 502. The bounded recorder then saw PL 200/200 and CL 502/200. This is
  evidence of intermittent failures, not a root cause or measured matchday SLO.
  The initial run exposed 34–50 ms source clock skew; the final recorder tolerates
  up to one second while preserving raw ages. Its raw ledger predates that fix
  and is annotated in `docs/live-score-evidence/2026-10-04-reliability-smoke.json`.
- Headless public checks at 390 and 1440px saw both feeds recover and no page
  errors or horizontal overflow. Both views displayed no games today. CL used
  the labelled saved table from October 3, 22:47 UTC. This observation does not
  independently validate the provider's schedule or empty matchday.

Remaining P0: deploy-independent monitoring with an independently reconciled
fixture schedule, browser/version observations and verified alert delivery;
implement the dedicated collector, fenced takeover and stored-data read adapter
locally; price the infrastructure and provider options before requesting spend
approval. The new recorder is a bounded local command, not an installed service.
No public deployment, paid provisioning or subscription change was performed.

## October 4 — versioned stored-score read path and browser compatibility

The previous goal turn was progress: `64f7336` committed the recorder, tests and
production evidence. This continuation moves into the replacement score path.
`services/scores/snapshots.mjs` now defines validated, versioned publications and
a read-only API compatible with the existing score views. It preserves fixture
observation times, rejects incomplete/backward updates, permits newer downward
score corrections, and keeps optional table failures separate from score writes.
A snapshot cannot erase known fixtures or silently switch competition/season.

A single-process reference store exercises unexpired lease ownership, monotonically
increasing generations and version-conditional publication. It is deliberately
kept under test helpers: it is not durable storage or evidence of multi-host
failover. The production collector, shared budget, DynamoDB adapter, deployment
and operational monitoring remain unfinished. No provider polling was added.

The real browser cache exposed an integration bug: it compared only the feed's
aggregate timestamp. A newer version with a fresh score and an older second
fixture could therefore be replaced by the cached older score. Running the
previous code retained 1–0 and a near-zero age; the new version-aware path kept
2–0 with a 120-second delay. Legacy feed comparisons remain timestamp-based.
Versioned snapshots use publication time for cache lifetime, retain observation
time for displayed freshness, and recalculate offline age across kickoffs.

Evidence:
- Fourteen service checks and the score-cache suite cover failed/partial writes,
  replayed takeover, corrections, midnight, wrong identities and table failures.
  A 1,000-reader in-process test makes no provider call and changes no version;
  it is not a deployed load/latency certification.
- The full working-tree suite passes 1,606 tests, including separate existing
  native work. Final focused cache/service checks pass after metadata validation.
- An isolated production build excludes the unrelated mobile edits. Headless UI
  replay passes initial failure/retry, empty discovery, loading, 1–0 retained on
  collector stall, recovery to 2–0, and 3–0 from a newer mixed-age version with
  the delay warning preserved. No browser errors or 390/1440px overflow occurred.
  Reproduction: `services/scores/README.md`, `scripts/qa/score-service.js`.

Next safe work: shared durable storage with actual conditional-write/fencing
tests, followed by provider collection and account-wide admission/pacing. Keep
independent measurement and verified alert delivery as cutover requirements.
No infrastructure, paid service or production deployment was changed.

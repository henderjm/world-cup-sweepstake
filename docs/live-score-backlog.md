# Daily live-score product backlog

Updated: 2026-09-10. Owner: ongoing Codex task. Branch: `codex/live-score-quality`.
Starting revision: `bfaf0a66e03febeda47647789e275853155ef638`.

## Mandate and continuation

Make Kickoff Draft a compelling daily live-score destination. Prioritize scores
while preserving fantasy, predictions, Paper Run and existing accounts. Make
routine product and engineering decisions autonomously. Ask before spending,
destructive production changes or public deployment. Pushing to main can deploy
both the site and Worker, so local verification is not authorization to push.

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

## Completed locally — awaiting deployment approval

1. Restricted CL table reconciliation and form to league/group-stage fixtures.
   Replayed the public CL feed captured at `2026-09-10T19:55:43.564Z`: AEK is
   back to 3 points / 1 played. Qualifying fixtures remain accessible.
2. Hero chooses the active live matchday; mixed live rounds use a neutral heading.
   Qualifying play-offs and knockout play-offs now have distinct labels/order.
3. Preserved provider status in mapping and detail data. Cards, ticker and drawer
   can show HT, Suspended or Interrupted. Older feeds without the new field show
   Paused rather than guessing HT. This requires the Worker/bake update as well
   as the frontend; nothing has been deployed.
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

## Prioritized remaining work

| Priority | Item | Definition of done |
| --- | --- | --- |
| P1 | Measure actual event latency | Compare timestamped provider events and observed delivery across live matches. Establish p50/p95 delay and update reliability; feed age alone does not prove event latency. |
| P1 — next | All-supported-competitions entry | Show today's supported matches immediately, grouped by competition. A quiet PL day must not hide CL matches. Keep per-competition tables and historical fixtures accessible; handle partial feed failures independently. |
| P1 | Favourites without sign-in | Device-local follows with clear account sync policy; no new D1 identifiers or renaming canonical team keys. Follow/unfollow and reload tests; keyboard/touch journey. |
| P1 | Qualifying versus main knockout presentation | Keep qualification history available, but avoid presenting a wall of July fixtures as the main knockout destination in September. Group two-leg ties with correct aggregate and penalty handling; never invent future draws. |
| P1 | Team identity and labels | The feed says Sabah FA while both benchmarks say Sabah FK. Verify provider team ID, crest and destination before changing display aliases; do not rewrite stored follow keys based on a name alone. |
| P1 | Match detail navigation/accessibility | Summary, events, lineups and stats affordances; partial-coverage wording. Retain verified focus trap/restoration and retries. Verify scheduled, live, finished and postponed states. |
| P2 | Product polish and performance | Align metadata/brand subtitle with score-first positioning, reduce distracting unavailable controls, align the hero with the selected date, preserve date-control focus through poll repaints, and measure rendering/request budgets. Keep existing features reachable. |

## Verification ledger

- Targeted regressions: `test/champions-league.test.js`, `test/feed-loading.test.js`,
  `test/score-dates.test.js` and `test/updated-label.test.js`; shared mapper/live-table
  coverage retained.
- Full JavaScript suite after date/freshness changes: 1,445 passed, 0 failed.
  Production build passed. Both also passed on an isolated export of the staged
  live-score changes, excluding unrelated native-app edits. Browser checks are
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
  [current date browser](live-score-evidence/mobile-dates.png). After screenshots
  use an explicit HT variant of the captured feed. The latest capture shows six
  rows above the bottom nav, full team names and no floating donation widget.

## Next run

Inspect the existing diff, then implement the all-supported-competitions Scores
entry. The working tree also contains separate native-mobile work; preserve it
and keep this goal's commits scoped to live scores. Keep changes reviewable on
this branch. Do not mark the overall product goal complete because individual
slices pass tests.

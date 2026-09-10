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
| Champions League | AEK showed 6 points from 2 games despite the feed saying 3 from 1. Heading showed MD2 above MD1 live games. August qualifiers were labelled knockout play-offs. | Qualifiers/knockouts never affect league-phase points or form; live heading matches visible rounds; stages use correct labels; full UEFA ordering still needs separate work. |
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
4. Compacted mobile live cards. All six replayed matches fit before the bottom
   navigation at 390 × 844 (sixth row bottom: 783px). No page overflow at 320,
   390 or 1440. Desktop retains its existing card layout.
5. Added initial loading UI and bounded feed requests (8 seconds per request;
   Worker plus static fallback may total 16 seconds). Distinguish an unavailable
   feed from a successfully loaded empty competition. Retry recovers in place.
6. Marked static fallback as delayed using its saved timestamp, with an unknown
   age when absent. Repaint on table or stale-state changes even if scores do
   not change; verified stale banner disappearance on recovery.

## Prioritized remaining work

| Priority | Item | Definition of done |
| --- | --- | --- |
| P0 — next | Champions League tie-breaking | Stop applying PL alphabetical tie-breaking to CL. Verify current [UEFA Article 18](https://documents.uefa.com/r/Reglement-de-l-UEFA-Champions-League-2026/27/Article-18-Egalite-de-points-lors-de-la-phase-de-ligue-Online); preserve provider rank when required inputs are unavailable; handle provisional live ordering honestly. Add tied-team scenarios and compare the same feed revision. Current AEK points fix does not establish full rank correctness. |
| P0 | Open match drawer becomes stale | Keep an open match's score/status/event sections current on polling without resetting scroll or keyboard focus; cancel/ignore responses belonging to a closed or different match. Verify two sequential goal updates in browser. |
| P0 | Freshness after total outage and aged healthy payloads | Check last-known-good model preservation after both paths fail, including empty fallback. Show loss of updates without resetting age. Define freshness from actual provider timestamps, not just successful requests. Measure live-event lag; do not infer it from a screenshot. |
| P1 | Scores date navigation and all-supported-competitions entry | Date strip/calendar, Live filter, useful empty day and next-match date. No duplicated Today/Recent rows. Current Next up rows omit the date; fix that. Preserve route/date/filter when opening/closing a match. |
| P1 | Favourites without sign-in | Device-local follows with clear account sync policy; no new D1 identifiers or renaming canonical team keys. Follow/unfollow and reload tests; keyboard/touch journey. |
| P1 | Qualifying versus main knockout presentation | Keep qualification history available, but avoid presenting a wall of July fixtures as the main knockout destination in September. Group two-leg ties with correct aggregate and penalty handling; never invent future draws. |
| P1 | Team identity and labels | The feed says Sabah FA while both benchmarks say Sabah FK. Verify provider team ID, crest and destination before changing display aliases; do not rewrite stored follow keys based on a name alone. |
| P1 | Match detail navigation/accessibility | Summary, events, lineups and stats affordances; focus trap/restoration, retries and partial-coverage wording. Verify scheduled, live, finished and postponed states. |
| P2 | Product polish and performance | Align metadata/brand subtitle with score-first positioning, reduce distracting unavailable controls and floating coffee overlay, measure rendering and request budgets, keep existing features reachable. |

## Verification ledger

- Targeted regressions: `test/champions-league.test.js`, `test/feed-loading.test.js`,
  and `test/updated-label.test.js`; shared mapper/live-table coverage retained.
- Full JavaScript suite: 1,431 passed, 0 failed. Production build passed.
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
- Local screenshots: [mobile before](live-score-evidence/mobile-before.png) and
  [mobile after](live-score-evidence/mobile-after.png). The after screenshot uses
  an explicit HT variant of the captured feed. The donation overlay still needs
  repositioning and Today rows still truncate long team names.

## Next run

Inspect the existing diff, then implement the P0 CL tie-break work. Keep changes
reviewable on this branch. Do not mark the
overall product goal complete merely because this first slice passes tests.

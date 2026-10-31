# Next major release: "Your Match" (draft plan)

Drafted 2026-10-31 from a live side-by-side of FotMob, LiveScore, Sofascore (Chelsea v Man United, PL R9, observed live) plus 365Scores, Apple Sports, Opta, Bundesliga Match Facts and data-provider research. Status: proposal, nothing built.

## The thesis

We cannot out-stat FotMob or Sofascore. They run on Opta and Sportradar: shot maps, xGOT, momentum, physical tracking. API-Football has none of that at shot level, and buying it is enterprise money.

What none of them do is connect a live match to **the user's own stake**. FotMob and Sofascore have a generic "Fantasy" lineup lens and global polls with 100k+ anonymous votes. Nobody shows "your H2H matchup just swung", "your captain is on in 4 minutes", "your prediction is still alive", or puts your league's banter on the match timeline. We already own every input for that: draft rosters, live provisional points, predictions, the Wire, push and the league feed.

The release: **every live match is told through what it means to you**, plus a small set of story-telling visuals we can compute honestly from our own data.

## What competitors do that matters (live, observed today)

| Capability | FotMob | Sofascore | LiveScore | Us today |
| --- | --- | --- | --- | --- |
| Live player ratings + team average | Yes (signature) | Yes (starts 6.5, ~60 recalcs) | No | **Data fetched, discarded** |
| Momentum chart | Yes | Yes (cancelled goal marked) | No | No |
| Shot map / per-shot xG | Yes (Opta) | Yes | No | No (provider lacks it) |
| Team xG | Yes | Yes | Yes | Unverified on our plan |
| Win poll / predictions | 330k-vote 1X2 poll | 3 polls + Player of the Match vote from 80' | No | Predict tab (exact = 3, result = 1) |
| Insight nuggets, referee card, injuries with return date | Yes | Partly | No | Referee name only |
| Social layer | Global emoji reactions, BBC ticker | Text commentary | App-only audio | Banter per match, league feed, the Wire |
| Personal stake on the match page | No | No | No | **Our moat, not yet surfaced** |
| Betting/ads | Ads, paywall creep | Odds in header, ads, paid AI | Age gate, betting brands | None |

Category-wide complaints we can answer: alert latency vs TV, notification spam and settings resetting, betting saturation, ads on score screens, wrong AI copy (Sofascore's AI preview had the wrong date today).

## Release scope

### Pillar 1: Your stake, on every match (the moat)

1. **"Your players" strip on each match card and drawer**: which of your draft players and your opponent's are in this match, live provisional points, captain marked. Reuses `fantasyLivePoints.js` and `fantasyGameweekTracker.js`.
2. **Live H2H win probability** for your fantasy matchup: "62% to win, up from 41% at kickoff", recomputed as points land. Monte Carlo over remaining players' minutes using existing xP.
3. **Prediction status on the match page**: "your 2-1 is alive", "exact needs one more Chelsea goal".
4. **Outcome-weighted push**: alert when something changes *your* result (matchup flips, captain scores, prediction busts), not every goal in every followed match. Fewer, better pushes is the selling point.
5. **League watch-room**: league feed reactions pinned to the match timeline ("Dave reacted to Palmer 34'"), not a separate chat.

### Pillar 2: The story of the match (computed honestly)

6. **Live player ratings and team average**: unlock what `/fixtures/players` already returns and `mapPlayerStats` throws away (rating, shots, key passes, dribbles, duels). Zero extra provider calls.
7. **Live win-probability chart** with markers at goals and reds. Our own pure model (pre-match prior from `/predictions` or team strength, then remaining-time scoring rates on score, minute and red cards), server-computed, stored per minute. Betting-free: no odds shown.
8. **Momentum proxy**: per-minute deltas of shots, shots on target, corners, dangerous attacks from `/fixtures/statistics`, labelled as "pressure from shots and corners", never presented as Opta momentum.
9. **Fan Player of the Match**, opening at 75', alongside the rating leader. Sofascore proves the format; ours is scoped to signed-in users and league.
10. **"Catch me up"**: AI summary since your last visit, built under the existing rule that the server computes every figure and the model writes prose only.

### Pillar 3: What it means

11. **As-it-stands consequences** beyond the live table: top-four, CL-qualification and relegation probabilities by Monte Carlo, moving live. Extends `liveTable.js` and the Wire's impact lines.
12. **"Switch to this game" alert**: a tension score from win-probability swing, closeness and minute; one push when a match you are not watching becomes worth watching (RedZone for football).

### Pillar 4: Trust as a feature

13. **Measured freshness on every score**: "updated 8s ago", with event delay measured (backlog P1) before any speed claim.
14. Stays ad-free and betting-free; say so in the product.

### Explicitly not in this release

- Shot maps, per-shot xG, xG race: need a new provider (see Data). Phase 2 spike.
- Lock-screen Live Activities: needs a native or wrapper app; web push cannot drive them.
- Audio commentary, video highlights: rights.
- New competitions (standing instruction).

## Data: what to verify, what to buy

| Data | Source | Status |
| --- | --- | --- |
| Player rating, shots, passes, duels | `/fixtures/players` (already fetched) | Rating field expected; confirm on one payload |
| Team stats incl. `expected_goals` | `/fixtures/statistics` | Not fetched today; xG coverage for PL/CL unconfirmed |
| Pre-match probabilities | `/predictions` | Not fetched; confirm shape |
| Injuries with return info | `/injuries`, `/sidelined` | Not fetched |
| Shot coordinates, per-shot xG, pressure | Not on API-Football | Sportmonks (Pressure Index + live xG add-on) or TheStatsAPI (shotmap x/y/xG) |

Prices (vendor pages, API-Football's own pricing page returned 403, so confirm): API-Football Pro $19/mo 7,500/day; **Ultra $29/mo 75,000/day**; Mega $39/mo 150,000/day. Sportmonks base EUR 29 to 249/mo plus xG and Pressure add-ons (listed prices disagree). TheStatsAPI $50 to $379/mo.

**Budget asks:**

1. **Superseded (31 October): no Ultra upgrade; Sportmonks replaces API-Football, see the V2 section.** Original note: API-Football Ultra (+$10/mo). Adding `/fixtures/statistics` every minute for 10 live matches is roughly 900+ extra calls per busy afternoon on top of the 4,585-call busy-day simulation; the October 11 incident already showed the 7,500 ceiling bites. Ultra does not fix the per-IP refusals; the AWS collector already addresses those.
2. **Later (Phase 2): a one-month trial** of Sportmonks or TheStatsAPI to measure live latency and PL/CL shot-level coverage before committing to a shot map.

## Milestones

| Milestone | Contents | Exit check |
| --- | --- | --- |
| M0 Verify (days) | One collector call each to `/fixtures/statistics`, `/fixtures/players`, `/predictions`, `/injuries` on a live PL fixture; record real fields; decide on Ultra; budget model for the new calls | Field list committed to `docs/live-score-evidence/`; busy-day simulation re-run with new calls under the cap |
| M1 Ratings and stats | Map ratings and per-player stats; team stats tab; team average rating; preserve nulls (never imply zero) | Live drawer shows ratings at 320/390/1440px; fantasy scoring contract unchanged |
| M2 Your stake | Pillar 1 items 1 to 4 | Signed-in manager sees own and opponent players live on any match; push only on result-changing events |
| M3 Story | Win-probability model and chart, momentum proxy, Player of the Match vote, catch-me-up | Model calibrated against last season's results (Brier score recorded); figures server-computed |
| M4 Consequences | Season Monte Carlo, switch-to-this-game alert, watch-room | Tension alert backtested on recorded matches before it can push |

## M0 status (2026-10-31)

- Probe run on Chelsea v Man United (1557450) at 90', evidence in `live-score-evidence/2026-10-31-m0-provider-fields.json`. Results:

| Data | Live? | Finding |
| --- | --- | --- |
| Team xG (`/fixtures/statistics`) | Yes | `expected_goals` 2.06 v 1.13, plus shots in/out box, on/off target, saves, possession, passes, corners, fouls |
| Player ratings (`/fixtures/players`) | Yes | 40/40 players rated (top 8.2); shots, key passes, dribbles, duels, fouls drawn, saves all populated. Already fetched, currently discarded |
| Win-probability prior (`/predictions`) | Pre-match | home/draw/away percent plus att/def/form/poisson comparison |
| Injuries (`/injuries`) | Yes | 26 entries with type and reason; no expected-return date |
| Shot coordinates / per-shot xG | No | As expected; needs another provider |

- Budget: per-minute team stats for 10 live matches is about 1,100 calls on a busy day, on top of the 4,585 simulated. That fits under 7,500 only by eating the non-score allowance (6,000 is reserved for scores), so poll team stats every 3 minutes (about 370 calls) until the Sportmonks switch.
- Ultra upgrade alone does not raise our ceiling: the collector's stored budget policy only ever shrinks to the provider's reported limit (`services/scores/budget.mjs`, the `Math.min` against `quota.dailyLimit`). After upgrading, the stored `dailyLimit`/`scoreReserve` need a deliberate, audited raise; no tool for that exists yet (`initialize-budget` refuses an existing budget by design).

## Touchless UI (first slice built on `feat/your-match-ui`)

Principle: the app decides what to show; the visitor should rarely need to tap, filter or scroll to find the match that matters.

- **For you spotlight** (`src/spotlight.js`): a followed team's match (live, then next kickoff, then latest result), else the tightest late live match as "Match of the moment". Nothing to show means no card.
- **Day strip**: one tap per day from three days back to a week ahead, plus a swipe left or right on the list to move a day. Calendar input kept for far dates.
- **Matches before the Wire**: the scores list is now above the commentary panel; the big page title is screen-reader only.
- **Goal flash**: a score that changes between polls flashes its row and card once.
- **Mobile chrome trimmed**: bottom nav is Scores, Fantasy, Play, You (Learn stays in the desktop nav and footer); the duplicate mobile ticker and header "Updated" label are hidden since each league card carries its own freshness.

Next UI slices: bottom-sheet match drawer with swipe-to-close and swipeable sections; your fantasy players on match cards (Pillar 1); return-visit "since you were away" chip; live score in the tab title when the page is in the background.

## Open decision

The live-score backlog says no feature expansion ahead of the P0 reliability work (independent matchday monitoring, public read capacity). Recommendation: run M0 and M1 now (zero or tiny provider cost, mostly mapping), and gate M2 push features on the monitoring P0, since outcome-weighted alerts are only valuable if they are trusted.

## Success measures (PostHog plus D1)

- Matchday sessions per active user and time on the match drawer during live windows.
- Share of fantasy managers who open a match drawer during their gameweek.
- Push opt-in rate and push-to-open rate (target: fewer pushes, higher open rate).
- Prediction entries per matchday.

## Sources

FotMob live match page (fotmob.com/matches/chelsea-vs-manchester-united/2w9xj5); Sofascore match (sofascore.com, Chelsea v Man United, 31 Oct 2026); LiveScore match page; Sofascore rating methodology and attack-momentum articles; FotMob and LiveScore App Store release notes; Sportmonks pricing and Pressure Index docs; TheStatsAPI shotmap docs; Stats Perform win-probability explainer; Bundesliga Match Facts announcements; Apple Sports October 2026 update coverage.

## V2: side-by-side release (decided 2026-10-31)

Provider decision: move live data to Sportmonks (Starter EUR 29 plus the xG and Pressure Index bundle, about EUR 58 a month). TheStatsAPI rejected: 100k calls a month is about 3,300 a day, too tight to manage safely. Measured API-Football peak today: about 320 calls in the busiest hour, against Sportmonks' 2,000 per entity per hour.

V2 is opt-in and runs beside V1, which stays production and untouched.

| Layer | V1 | V2 |
| --- | --- | --- |
| UI | Current HTML-string shell (`src/app.js`) | New Svelte app (`src/v2/`), chosen by `?v=2` or the in-app switch, remembered per device |
| Live match data | API-Football | API-Football first, then Sportmonks behind an ID map |
| Fantasy, predictions, banter, Wire | API-Football IDs | Same stores, reached through the ID map, never re-keyed |
| Push notifications | API-Football | **Switched last**, only after the ID map has run clean through a full gameweek, because a wrong ID there sends a wrong alert to a phone |

Switch order: V2 UI on current data, then Sportmonks match centre (scores, events, stats, xG, pressure) through the ID map, then fantasy reads, then notifications, then API-Football cancelled.

V2 product principles:
- **The leader, and new**: one confident home that says "live now" before anything else; no marketing copy.
- **State decides the layout**: a match page reshapes itself by state. Before kickoff: preview and line-ups. Live: score, live stat bars, latest moments, the talk thread. After: the match report first, then stats, then talk. The visitor never picks a tab to find the obvious thing.
- **Limited scrolling and tapping**: every datapoint a visitor wants for a match fits in roughly one phone screen per state; depth (full line-ups, every event) expands in place.
- **Talk like a forum**: the per-match thread (existing banter store) is a first-class section with replies and reactions, not a footer.
- **Match reports**: the existing full-time AI analysis is presented as an article, every figure server-computed, the model writing prose only.

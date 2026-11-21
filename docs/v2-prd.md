# Kickoff Draft V2: Product Requirements (for UI design review)

Version: draft 2, 31 October 2026. Owner: Mark Hender. Draft 2 corrects the data table against the Worker and the 31 October provider probe, tags every Match page item with its phase, and specifies the empty home, V1/V2 coexistence, Talk moderation and the exit criteria for V1.

## 1. What this is

Kickoff Draft (kickoffdraft.com) is a web app for football fans: live scores, tables, fixtures and match detail for the **Premier League and the Champions League**, plus a head-to-head fantasy draft league (snake draft, waivers, weekly matchups) and a score-prediction game.

V2 is a rebuild of the live football experience. It ships **beside** the current app (V1): visitors opt in with a switch and can go back at any time. When V2 is proven (defined in section 11), it replaces V1.

**Positioning:** the one place a fan needs for the Premier League and the Champions League today, with the other European cups on the roadmap. Design for that scope honestly: two competitions, not a hundred. It should still feel new, big and confident, like the category leader, not a side project.

## 2. Who it is for

| User | What they want on a matchday |
| --- | --- |
| The checker | Glance: what's live, what's the score, did my team win. Seconds, not minutes. |
| The fan of one club | Their club's match, front and centre, without filtering. |
| The fantasy manager | Their players and their head-to-head matchup, live, tied to the real matches. |
| The talker | Somewhere to react and argue about a match while it happens. |
| The analyst | Live stats, xG, player ratings, a proper match report afterwards. |

Most visitors arrive **signed out with no followed club**, and five days a week there is **no match on**. Both cases are first-class states (see 7.1), not edge cases.

Primary device: phone (320 to 430px wide). Secondary: desktop (1200 to 1440px). Dark theme only.

## 3. Problems with V1 that V2 must fix

- Too much tapping and scrolling to reach the obvious thing (the match that matters now).
- Looks dated: pill-shaped buttons everywhere, heavy italic uppercase headings, cards inside cards, "bubbly". The owner describes it as "old and legacy".
- Match detail is a long drawer of sections; the visitor has to hunt.
- The comments ("banter") and the AI match analysis exist but are buried.
- Scores alone has six tabs (Live, Tables, Knockout, Fixtures, Stats, Predict). [Owner: add the PostHog tab-usage split for the last four matchdays before the review, so the designer knows which tabs are being cut on evidence.]

## 4. Design principles (the brief in one list)

1. **Touchless first.** The app chooses what to show. A visitor who opens it and does nothing should see the most relevant live information, updating by itself. This includes the visitor with nothing live and nothing followed.
2. **State decides the layout.** A match page reshapes itself before, during and after the match. The visitor never picks a tab to find the obvious thing.
3. **Limited scrolling and tapping.** Everything worth knowing about a match in its current state fits in about one phone screen. Depth expands in place rather than navigating away.
4. **Calm, dense, modern.** Flat surfaces, hairline dividers, strong typographic hierarchy, tabular numerals. Motion only to signal change (a goal, a new comment).
5. **Honest data.** Never show a zero for something unknown (a rating of 0 and "not rated yet" are different facts), never invent a figure, always show how old live data is.
6. **No ads, no betting.** This is a deliberate difference from LiveScore, Sofascore and FotMob, which all carry gambling ads or odds. Anything expressed as a probability must not read like odds (see 7.2).

## 5. Competitive reference

| Product | Best at | Weakness to exploit |
| --- | --- | --- |
| FotMob | Live player ratings, shot map, momentum chart, deep stats, global fan poll | Ad-heavy web, paywall creep, nothing personal |
| Sofascore | Momentum graph, fan Player of the Match vote from 80', three prediction polls | Overwhelming density, odds in the header, gambling ads |
| LiveScore | Speed, clean list | Thin match detail, betting age gate on entry |
| Apple Sports | Minimal, glanceable, lock-screen live activities | Shallow data |

FotMob and Sofascore each have a generic fantasy lens and anonymous global polls. **Nobody shows the fan their own stake on the match**: that their head-to-head matchup just swung, that their prediction is still alive, or what their league's friends said about the 34' goal. That is V2's moat, and the app already owns every input for it (draft rosters, live provisional points, predictions, the Wire, the league feed).

## 6. Information architecture

Bottom navigation on phone, top navigation on desktop. Four destinations:

1. **Live** (home)
2. **Fantasy**
3. **Play** (prediction game and daily mini-game)
4. **You** (account, followed teams, notification settings, the V1/V2 switch)

V2 phase 1 rebuilds **Live** and the **Match page**. Fantasy, Play and You keep their current screens at first.

**How V1 and V2 coexist in phase 1** (the designer needs this to design the seams):

- The switch lives in You and in the footer, is remembered per device, and `?v=2` on any URL forces V2. A push notification tap, a shared link and a deep link all open whichever version the device remembers.
- Fantasy, Play and You render the V1 screens inside the V2 shell (V2 navigation, V1 content). The designer should expect a visible seam and propose how the shell softens it (shared header, shared bottom nav, V2 tokens applied to V1 surfaces where cheap). A full restyle of those sections is not phase 1.
- Predict stays where it is (a tab inside V1 Scores) and is **also** reachable inline on the V2 Match page before kickoff. It moves to Play when Play is rebuilt, not in phase 1.
- Section 7.4 covers notifications; they do not change in phase 1.

## 7. Screen requirements

### 7.1 Live (home)

Order of content, top to bottom:

1. **Matchday strip.** A horizontal row of dates showing only days on which a tracked competition plays (the last two matchdays, the next five, plus today when today is one of them). Selected day underlined. Default selection: today when a tracked competition plays today, otherwise the nearest upcoming matchday. Swipe left or right anywhere on the list to move to the next or previous matchday.
2. **Spotlight.** One or two large cards chosen automatically, in this order:
   - a followed team's match: live first, then next kickoff today, then today's result;
   - otherwise the live match most worth watching, ranked by minute played (later first), then closeness of score, labelled "Match of the moment";
   - otherwise, with nothing live, the **next kickoff** in a tracked competition ("Next: Arsenal v Spurs, Sat 17:30"), with a followed team's next fixture winning if there is one;
   - nothing scheduled at all (a season break) means no card and the Wire leads.
   The card shows crests, score, minute and the latest key moment in one line ("71' Goal ruled out, offside"). Tap opens the Match page.
3. **Your stake strip** (signed in, fantasy manager): your head-to-head score this gameweek and which of your players are playing right now.
4. **Match list grouped by competition.** Compact rows: status or kickoff time, teams with crests, score. Live rows visually distinct. A row flashes once when its score changes. **Following a club is one tap on any row or on the Match page header**, and it must work signed out (stored on the device, like signed-out predictions today) and merge into the account on sign-in; otherwise the "fan of one club" persona is behind a Google sign-in wall.
5. **The Wire.** A short feed of the latest big moments across all matches (goals, red cards, VAR decisions), each with an optional one-line AI comment. Three items by default, expandable.

Filters (Live only, My teams) are quiet text toggles, not buttons.

Desktop: three columns. Competitions on the left, the list in the centre, and on the right The Wire while matches are live, otherwise the league table. The Match page opens over the right column; the list stays visible and usable.

### 7.2 Match page

Opens from any row or card. On phone it is a full-screen sheet with swipe down to close. On desktop it is a wide side panel over the right column.

A sticky header always shows crests, score, minute or status, the competition and a follow control for each club.

**Phases.** Every item below is tagged. **P1** ships with the V2 Live and Match page on data the app already has or can map at no new provider cost (ratings and per-player stats are fetched today and discarded; team stats including xG need one new call per live match, polled every three minutes). **P2** adds the fan's own stake and the pre-match data (predictions prior, injuries, head-to-head, Talk threading). **P3** needs the provider switch or a model that has been calibrated first (win-probability line, momentum, fan vote). Design all three; build above the fold for P1.

**Before kickoff**
- Kickoff time, venue, referee. **P1.**
- Pre-match win chances (home, draw, away percentages). **P2.** Source: API-Football's pre-match model, not bookmaker odds; label it "model", show it as three bars, never as a 1X2 row or decimal odds.
- Line-ups as a pitch graphic when announced, otherwise "line-ups expected around HH:MM". **P1.**
- Injuries and suspensions (player, type, reason; no expected return date is available). **P2.**
- Form. **P1.** Head-to-head record. **P2.**
- The prediction game: "Predict the score" inline, one tap per digit. **P1** (exists; reskin).

**Live**
- Key stat bars, home versus away: xG, shots, shots on target, possession, corners, cards. **P1.** Any stat the provider has not returned is omitted, not shown as zero.
- A live win-probability line with markers at goals and red cards. **P3.**
- Latest moments: the last three events, expandable to the full timeline. **P1.**
- Player ratings on the line-up pitch, best-rated player highlighted. **P1.** Unrated players show no number.
- Talk (see 7.3), visible without leaving the page. **P1** for reading, posting and reactions; **P2** for replies and moment-tagging.
- Fantasy overlay for managers: your players and your opponent's in this match, with live points. **P2.**

**After the whistle**
- **Match report first:** a headline and two or three short paragraphs written by AI from figures the server computed (the AI writes prose only and cannot invent a number). Clearly labelled as AI-written. **P1** (the full-time analysis exists; the report shape is a prompt change).
- Player of the match by highest rating. **P1.** Fan vote result. **P3.**
- Full stats and timeline. **P1.**
- Talk. **P1.**

**Fan vote (P3), minimal spec:** signed-in users vote for one player from 75' until 30 minutes after full time, one vote per account, changeable until the window closes. The result shows as a percentage split once at least ten votes are in; below that it says "N votes so far" with no percentages. Shown beside the ratings leader, never instead of it.

### 7.3 Talk (comments)

A per-match discussion that should feel like a lively forum thread, not a footer. Today's banter has posts and six reactions and polls for new messages; replies, moment-tagging and live arrival are **new backend**, not a reskin.

- Signed-in users post; everyone can read.
- Reactions on the match and on comments (fire, laughing, shocked, salt, goat, skull). **P1.**
- Replies (one level of threading). **P2.**
- New comments arrive live without a refresh. **P1.**
- Comments can be tied to a moment ("reacted to the 34' goal"). **P2.**

**Moderation (P1, before Talk is public):** every comment has a report action; a reported comment is hidden from everyone but its author once it has two reports or one report from the owner, pending review; the owner can hide a comment or mute an account from the app; posting is rate limited per account (one post per 10 seconds, 60 per match) and a muted account sees its own posts but nobody else does. The designer places report, hidden-pending-review and muted states in the thread without making them loud.

### 7.4 Notifications (unchanged in phase 1)

Web push for followed teams: kickoff, goals, red cards, VAR reversals, full time. V2 later adds "your result changed" alerts for fantasy managers. Notifications move to the new data source last.

## 8. Data available to the design

Three columns, because they differ. **In the app today** is what the Worker fetches and maps. **On API-Football** is what the 31 October 2026 probe of a live Premier League fixture returned (Chelsea v Manchester United at 90'). **After the provider switch** is Sportmonks (Starter plus the xG and Pressure Index bundle, decided 31 October), which replaces API-Football for live match data behind an id map, with notifications moving last.

| Data | In the app today | On API-Football | After the provider switch |
| --- | --- | --- | --- |
| Scores, minute, status, events (goals, cards, subs, VAR) | Yes | Yes | Yes |
| Line-ups with formation grid, bench, coach | Yes | Yes | Yes |
| Referee | Name only | Name only | Yes |
| Player ratings, shots, key passes, saves | Fetched, not shown | Yes, live (40 of 40 players rated) | Yes |
| Team stats incl. xG, shots, possession, corners, fouls | No | Yes, live (confirmed for the Premier League; Champions League unconfirmed) | Yes |
| Pre-match win percentages | No | Yes, pre-match only | Yes |
| Injuries with type and reason | No | Yes, no expected return date | Yes |
| Head-to-head record | No | Yes | Yes |
| Momentum / pressure over time | No | No | Yes (Pressure Index) |
| Shot map (each shot's position and result) | No | No | Not planned yet |
| AI live analysis and full-time report | Yes | n/a | Yes |
| League table including live results | Yes | Yes | Yes |

Design should treat any of these as possibly missing for a given match and degrade quietly: omit the element, never show a placeholder zero.

## 9. Visual direction

Keep the brand: near-black navy background (#0A0E14), lime accent (#C8F542), card surface #12181F, the Archivo typeface, the "KD" mark. Fantasy uses a violet accent (#A78BFA).

Change the feel:
- Flat over bubbly: underlined tabs and text toggles instead of pills.
- Fewer boxes: hairline dividers and spacing instead of nested cards.
- Italic uppercase reserved for the logo and the hero score at most.
- Big, tabular score numerals; small, quiet metadata.
- Motion: a short flash or pulse on change only. Respect reduced-motion settings.

## 10. Constraints

- Web app (installable), no native app. No lock-screen live activities.
- Widths 320 to 1440px with no horizontal page scroll; 44px minimum touch targets; keyboard accessible; screen-reader labels on all icons and scores; score and status changes announced through a polite live region, so touchless works with a screen reader too.
- Data refreshes automatically (every 20 seconds while a match is live). No pull-to-refresh required.
- **Freshness is the age of the data, never the time since the browser fetched.** "Updated 12s ago" means the score is 12 seconds old at the source. The pipeline can run from one minute to 45 minutes behind the provider when the primary path is refused, so the "delayed" state is shown whenever the server marks the feed stale, and in any case when live data is more than two minutes old. The delayed state names the age; it never hides it.

## 11. Success measures

Baselines: [Owner: pull the last four matchdays from PostHog before the review.] Targets are relative to V1 on the same matchdays, V2 opt-in cohort against V1.

1. Matchday visits per user and time on the Match page during live matches.
2. Share of visitors who reach a live match within one tap of opening the app. Needs a new event (first tap after open, with its target); it is not measurable today.
3. Comments per live match.
4. Share of fantasy managers who open a Match page during their gameweek.
5. Push open rate (fewer, better notifications). **Not a phase 1 measure**: notifications do not change until the data source moves.

**"Proven", the condition for retiring V1:** four consecutive matchdays on which V2 beats V1 on measures 1 to 3, no P0 incident attributable to V2, and fewer than one in twenty V2 users switching back. Until then both versions ship.

## 12. What we want from the design review

1. A critique of the principles and the IA: anything missing or wrong for a fan's one place for the Premier League and the Champions League.
2. A layout for the Live home on phone and desktop that meets "touchless" and "limited scrolling", in all three states: live now, matchday with nothing live yet, and no match today.
3. The Match page in its three states on phone, showing what is above the fold in each, built from the P1 items.
4. How Talk should look and behave to feel like a forum without crowding the match, including the report, hidden and muted states.
5. A visual system update: type scale, spacing, components (date strip, match row, spotlight card, stat bar, rating chip, comment), motion rules.
6. How to make V2 feel new and big on first open without a marketing splash screen.
7. How the V2 shell wraps the V1 Fantasy, Play and You screens so the seam is tolerable in phase 1.

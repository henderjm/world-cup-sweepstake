# Business metrics, straight from D1

Twelve read-only SQL queries answering "is this product working", without
needing access to PostHog. Nearly everything that proves the product works is
already in the database: users, leagues, members, draft picks, rosters,
gameweek scores, head-to-head fixtures, waivers, and the chat and recap tables.

PostHog answers what happens **before** someone signs in (landing, the
signed-out sandbox draft, the demo report card). D1 answers what happens
**after**, and that is the half that proves the business. The two do not
overlap, so neither replaces the other.

## Running them

```sh
./scripts/metrics/run.sh                       # every query, in order
./scripts/metrics/run.sh 02-draft-completion.sql   # just one
```

Or by hand, which is all `run.sh` does:

```sh
npx wrangler d1 execute squad-goals --remote \
  --command "$(cat scripts/metrics/01-league-funnel.sql)"
```

Every file is a **single `SELECT` with no bound parameters**, so it passes
through `--command` verbatim and is nowhere near D1's 100 bound-parameter cap.
Nothing here writes, creates or drops anything.

## The queries

Read them roughly in order; each file's header comment says what question it
answers and how to read the result.

| File | Answers |
| --- | --- |
| `01-league-funnel.sql` | The whole league funnel in one row. Read the DROPS between columns, not the columns. |
| `02-draft-completion.sql` | Of leagues that started a draft, how many finished. The headline number. |
| `03-stalled-drafts.sql` | Which drafts are wedged right now, and how far each got. Empty is good. |
| `04-drafted-league-seats.sql` | Managers per drafted league, and how many of those seats are actually alive. |
| `05-time-to-draft.sql` | Per league: hours from created to drafted, with the wait and the draft separated. |
| `06-time-to-draft-buckets.sql` | The shape of the same thing, plus how many never drafted at all. |
| `07-weekly-active-managers.sql` | Wall-clock week-over-week activity. A floor, see the caveat below. |
| `08-gameweek-retention.sql` | Gameweek-by-gameweek engagement across every drafted league. |
| `09-signup-funnel.sql` | The same funnel counted in PEOPLE rather than leagues. |
| `10-feed-engagement.sql` | Whether the league feed is a conversation or just the app talking. |
| `11-waiver-activity.sql` | Whether the mid-season habit loop is being used, and whether runs work. |
| `12-league-health.sql` | Per running league: is scoring, the H2H season and the recap cron actually working. |

### Two numbers to read carefully

**Setting a lineup is a floor on engagement, never attendance.** Absence from
`fantasy_lineups` for a gameweek means "inherit the previous gameweek's XI" by
design (`resolveEffectiveLineup`, `src/fantasyLineups.js`), so a happy manager
with a settled squad is indistinguishable from one who has left. The trend
across gameweeks is meaningful because the ambiguity is constant; the absolute
level is not.

**"Empty seats" is not a question this schema can answer.** See the gaps below.

## Validation

Every query in this directory was run against a **local SQLite database built
from `worker/schema.sql`**, seeded with synthetic leagues covering each shape
the queries claim to detect: a completed draft, a stalled draft, a pending
league with two managers, and a single-manager league that never filled.

```sh
sqlite3 /tmp/metrics.db < worker/schema.sql
for f in scripts/metrics/*.sql; do sqlite3 /tmp/metrics.db < "$f"; done
```

All twelve parse, run and return correct results against that fixture. **None
of them has been run against production**, deliberately. Column names and
types were checked against `worker/schema.sql`, including the columns added by
`worker/migrations/001-waivers.sql` (`fantasy_waivers.bid`, `.reason`).

One coupling to keep in step: `03-stalled-drafts.sql` hardcodes a 15-man squad
when computing `picks_expected`. That is `SQUAD_SLOTS` in `src/fantasy.js`. If
the squad size ever changes, change the `15` there too.

## What the schema cannot currently answer

These are real gaps, not query bugs. Each needs a schema change, and the schema
is owned elsewhere right now, so none of them has been made.

**1. An autopicked draft pick is indistinguishable from an engaged one.**
This is the most valuable missing column by a distance. When a manager's
60-second clock expires, `FantasyDraftRoom`'s alarm autopicks for them
(`worker/draftRoom.js`), and the row it writes to `fantasy_draft_picks` is
byte-for-byte identical to one a manager chose deliberately. The `viaQueue`
flag does survive, in the `fantasy_chat_messages` payload JSON, but it only
distinguishes "came from my shortlist" from everything else: an autopick with
an empty queue records `viaQueue: false`, exactly like a manual pick. So a
draft where every manager was present and a draft where three of four
sleepwalked through on the clock look the same, and "did the draft go well" is
unanswerable.
*Minimal fix:* one column, `fantasy_draft_picks.via TEXT` (`manual` | `queue` |
`autopick`), written where `commitPick` already knows the answer.

**2. Lineup saves have no timestamp, only a gameweek.**
`fantasy_lineups` is keyed on `(league_id, user_id, gameweek, player_id)` with
no time column at all, so there is no way to place a lineup save in a calendar
week or to ask the operationally interesting question, "did they set it before
the deadline or after kickoff". This is why `07-weekly-active-managers.sql`
excludes lineups and undercounts the quiet manager who sets an XI and does
nothing else.
*Minimal fix:* `fantasy_lineups.updated_at TEXT NOT NULL DEFAULT (datetime('now'))`.

**3. There is no completion timestamp on a league.**
`fantasy_leagues` carries `draft_status` but no `drafted_at`, so
`05-time-to-draft.sql` uses `MAX(fantasy_draft_picks.picked_at)` as the proxy.
That is accurate to within a second (the final pick and `completeDraft()` share
a commit path), so this gap is mild, but it does mean a league whose picks were
ever pruned would lose its conversion time.
*Minimal fix:* `fantasy_leagues.drafted_at TEXT`.

**4. Bots and empty seats do not exist in the schema.**
Every row in `fantasy_league_members` is a real signed-in Google account. Bots
exist only in the client-side sandbox (`src/fantasyDemo.js`) and never touch
D1, and there is no target-size column on a league, so "how many seats are
unfilled" has no denominator to be measured against.
`04-drafted-league-seats.sql` answers the useful version of the question
instead, counting seats that did nothing at all after the draft.
*Minimal fix (only if the product wants it):* `fantasy_leagues.target_size INTEGER`.

**5. Nothing signed-out is in D1 at all.**
Landing traffic, sandbox drafts and demo report cards happen before there is a
user row, so the top of the funnel is PostHog-only by construction. The one
bridge is the `came_from_demo` property on `fantasy_league_created` and
`fantasy_league_joined` (see `src/funnelEvents.js`), which is session-scoped
and in-memory, so it undercounts rather than guesses.

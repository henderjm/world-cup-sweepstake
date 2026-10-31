# Kickoff Draft V2 design, handoff

Twelve artboards for the V2 live experience, built from `docs/v2-prd.md` (draft 2, 31 October 2026). This folder is a static mirror for any agent or person working in the repo: open any `.dc.html` in a browser. The editable source of record is the Design canvas at https://claude.ai/artifact/TTupUgRh9dKVcGT2tADu62 (private to the owner's account until shared from its Share menu).

## How to read a board

- Each board is one HTML file. `<x-dc>` and `<helmet>` are the canvas wrapper; everything inside is ordinary HTML with inline CSS, so a builder can lift markup directly.
- `kd.css` holds the tokens and the primitives (`.row`, `.stat`, `.rating`, `.toggle`, `.chip`, `.nav`, `.fold`). Token values match `src/styles.css`.
- Crests load from `assets/crests/`. Archivo loads from Google Fonts.
- `canvas.json` is the canvas layout (board positions and notes) and is not needed to read the boards.
- Phone boards are 390 wide. The three Match boards and Talk are 1200 tall with a dashed red line at 844 marking the phone fold.

## Board index

| File | Shows | Size |
| --- | --- | --- |
| `Main.dc.html` | Home, live, signed in: followed-club row, hero "Match of the moment", your matchup strip, list, V2 banner | 390 x 844 |
| `Home-Signed-Out.dc.html` | Home, live, signed out: hero spotlight, "Choose club" line (no account needed), list | 390 x 844 |
| `Home-Matchday-Pre.dc.html` | Saturday morning, nothing live: followed club as the big card with countdown, next kickoff row, list | 390 x 844 |
| `Home-No-Match.dc.html` | Thursday, no match: strip defaults to the next matchday, next fixture card, compact table, Saturday list | 390 x 844 |
| `Match-Pre.dc.html` | Match sheet before kickoff: venue and referee, predict pad, form (P1); win chances, injuries, head to head (P2) | 390 x 1200 |
| `Match-Live.dc.html` | Match sheet live: stat bars, latest three events, your players (P2), Talk inline, ratings pitch, win probability (P3) | 390 x 1200 |
| `Match-FT.dc.html` | Match sheet after the whistle: AI report first, player of the match, fan vote (P3), Talk, stats, timeline | 390 x 1200 |
| `Talk.dc.html` | Full thread: match reactions, moment dividers, one-level replies, report menu, hidden-pending-review, muted-account view, "3 new" chip, composer with reply and moment chips | 390 x 1200 |
| `Desktop-Live.dc.html` | Desktop home: competitions and filters left, strip, hero, matchup strip and list centre, The Wire right | 1440 x 900 |
| `Desktop-Match.dc.html` | Desktop with the match panel open over the right column; left column narrows, list stays usable | 1440 x 900 |
| `System.dc.html` | Visual system: colour roles, type scale, spacing and shape, motion and freshness rules, every component in its states | 1440 x 1560 |
| `Shell-Fantasy.dc.html` | The V2 shell (header, text sub-tabs, bottom nav) around the untouched V1 Fantasy My team screen | 390 x 844 |

## Rules the boards follow

- **State decides the layout.** Spotlight order: a followed club's match (live, then next kickoff today, then today's result), else the live match with the latest minute and closest score ("Match of the moment"), else the next kickoff. Hero size only while live; an upcoming match is a compact row-card.
- **Above the fold is P1 only.** P2 and P3 items carry a violet `P2`/`P3` chip on the boards. Remove the chips in the build; they mark build order, not UI.
- **Lime means live, selected, or the one primary action.** Violet is only the visitor's own fantasy stake. Red is red card, loss, destructive. Gold is yellow card, doubtful, delayed.
- **No pills.** Rows have radius 0 and hairline dividers, controls 8px, cards 12px. One level of surface: never a card inside a card. Tabs and filters are underlined text.
- **Type.** Archivo throughout, tabular numerals everywhere. Hero score is the only italic 900 besides the KD mark. Scale: 56 hero, 24 display, 17 title, 15 body, 13 meta, 11 caps label.
- **Honest data.** A stat the provider has not returned is omitted, never drawn at zero. Unrated players show a name and no number. A player whose match has not started shows the kickoff time in an outlined chip.
- **Freshness** is the age of the data at the source, never the time since the browser fetched. Over two minutes live is "Delayed" and the state names the age.
- **Motion.** Score change: row and card flash lime once, 1.2s. Live dot pulses 1.6s. New comments wait behind a "N new" chip so the list never jumps. Sheet opens in 240ms. Reduced motion disables all of it; the live region still announces.
- **Accessibility.** 44px targets, `aria-live="polite"` on the freshness chip and score header, `aria-label` on every icon-only button, follow controls on the Match header for each club. Icons are inline stroke SVG; the six reactions are emoji because they are product content, not icons.

## Data in the mock

The Chelsea v Manchester United numbers (xG 2.06 v 1.13, 17 shots to 11, 9 on target to 4, 57% possession, 7 corners each, 1 yellow v 4 plus a red, 40 of 40 players rated, Palmer 8.2) are from the 31 October 2026 probe recorded in `docs/live-score-evidence/2026-10-31-m0-provider-fields.json`. Every other score, fixture time, table position, comment and name is sample data.

## Where it lands in code

Per the V2 section of `docs/release-plan-matchday-2.md`: a new Svelte app under `src/v2/`, chosen by `?v=2` or the in-app switch and remembered per device, with V1 left untouched. Fantasy, Play and You render the V1 screens inside the V2 shell in phase 1 (see `Shell-Fantasy.dc.html`). Talk reuses the banter store in D1; replies, moment tags and live arrival are new backend (PRD 7.3). Team stats need `/fixtures/statistics` wired into the Worker; ratings are already fetched by `/fixtures/players` and mapped in `mapPlayerStats` (`src/mapApiFootball.js`) but not rendered by the drawer yet.

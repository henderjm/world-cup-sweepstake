# Matchday review — October 4, 2026

Public journeys inspected headlessly at 390px and 1440px: kickoffdraft.com,
FotMob's Champions League overview and LiveScore's Champions League league-stage
page. This is a UI sample, not a busy-matchday latency or correctness benchmark.

- Kickoff's empty October 4 scorecards identify the next PL and CL fixture, but
  the next-match text is not actionable. Reaching October 13 takes repeated date
  stepping or manual date entry. This is especially poor for following a team.
- FotMob presents competition tabs, standings, team form and upcoming round
  fixtures on desktop; its mobile overview reduces the table to three rows.
- LiveScore exposes Overview / Fixtures / Results / Standings and shows upcoming
  fixtures and recent results together. Consent/age overlays were present; no
  consent or age choice was submitted in this review.
- Kickoff's full CL table displays 36 clubs, points, goal difference and phase
  bands. The two competitors and Kickoff show some tied teams in different
  orders. This sample does not establish which ranking is correct; verify against
  authoritative UEFA tie-break evidence before changing provider ordering.
- Kickoff also repeats a CL mini-table beside its full desktop table. Review that
  space for more useful context, preserving the requested sidebar on Scores.

## Implemented and verified locally

The empty-date and empty-Live states now offer **View upcoming matches**. It opens
the next relevant matchday using the viewer's local date, retains Following and
competition scope, and clears Live so scheduled fixtures are visible. Browser
Back restores the original date and filters. A 44px minimum target supports touch.
No shortcut is offered when the known schedule contains no later fixture.

The real browser journey also exposed a malformed fallback's missing competition
identity reaching the feed store. The feed store now rejects missing/wrong identity,
reports that league unavailable on cold start, and preserves labelled last-good
scores if available. It cannot put another competition's payload in that slot.

Validation: 31 focused unit tests; headless 390/1440px CL and combined journeys
cover Following, delayed-data disclosure, shortcut, match drawer return, Back,
44px target, no horizontal overflow and no uncaught page errors. Also replayed
existing date/freshness regression. Screenshots show synthetic failure states,
not production scores. No public deployment.

Sources visited:
- https://kickoffdraft.com/
- https://kickoffdraft.com/#tables?competition=CL
- https://www.fotmob.com/leagues/42/overview/champions-league
- https://www.livescore.com/en/football/champions-league/league-stage/

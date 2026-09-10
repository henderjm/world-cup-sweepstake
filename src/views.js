import { abbrFor, badgeFor } from "./badges.js";
import { COMPETITIONS } from "./competitions.js";
import { displayTeamName } from "./domain.js";
import { compareByGoals, compareByInvolvements } from "./scorers.js";
import { dateLabel, dayLabel, formatStage, isFinished, isLive, statusLabel } from "./format.js";
import { feedDelayNotice, isOverdueFixture } from "./fixtureFreshness.js";
import { learnPages } from "./learnSeo.js";
import { TUTORIALS } from "./tutorials.js";
import { localDateKey, validScoreDate } from "./scoreDates.js";

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

function hasScore(score) {
  return Number.isFinite(score?.home) && Number.isFinite(score?.away);
}

function hasPenalties(match) {
  return Number.isFinite(match?.penalties?.home) && Number.isFinite(match?.penalties?.away);
}

function penaltyTag(match) {
  if (!hasPenalties(match)) return "";
  return ` <span class="pens" title="Decided on penalties">(${match.penalties.home}-${match.penalties.away}p)</span>`;
}

function scoreText(match) {
  if (hasScore(match.score)) return `${match.score.home} – ${match.score.away}`;
  return "v";
}

// -- Ticker -----------------------------------------------------------------

export function renderTicker(model) {
  const now = Date.now();
  const window = 36 * 60 * 60 * 1000;
  const items = model.matches
    .filter((match) => {
      if (isLive(match.status)) return true;
      if (!isFinished(match.status)) return false;
      return now - new Date(match.utcDate).getTime() <= window;
    })
    .sort((a, b) => new Date(b.utcDate) - new Date(a.utcDate))
    .slice(0, 12);

  if (!items.length) {
    return `<div class="ticker__track" style="animation:none;"><span class="ticker__item ticker__item--idle">No live or recent games right now. Next up below.</span></div>`;
  }

  const cells = items
    .map((match) => {
      const live = isLive(match.status);
      const score = hasScore(match.score) ? `${match.score.home}–${match.score.away}` : "●";
      return `<span class="ticker__item ${live ? "is-live" : ""}">
        <b class="ticker__status">${live ? `${esc(statusLabel(match))} ●` : "FT"}</b>
        ${esc(abbrFor(match.homeTeam))} ${score} ${esc(abbrFor(match.awayTeam))}
      </span>`;
    })
    .join("");
  // Doubled so the marquee loops seamlessly.
  return `<div class="ticker__track">${cells}${cells}</div>`;
}

// -- Competitions: desktop sidebar and mobile chip row -------------------------

export function renderCompetitionSidebar(activeCode, includeAll = false) {
  const rows = Object.values(COMPETITIONS).map(comp => `
    <button class="comprow ${comp.code === activeCode ? "is-active" : ""}" type="button" data-competition="${comp.code}">
      <span class="comprow__mark">${esc(comp.code === "PL" ? "PL" : "UCL")}</span>
      <span class="comprow__label">${esc(comp.shortName)}</span>
    </button>`).join("");
  return `<aside class="side"><h3 class="side__title">Competitions</h3>
    ${includeAll ? `<button class="comprow ${activeCode == null ? "is-active" : ""}" type="button" data-all-scores>All matches</button>` : ""}
    ${rows}</aside>`;
}

export function renderCompetitionChips(activeCode, includeAll = false) {
  const chips = Object.values(COMPETITIONS).map(comp => `
    <button class="compchip ${comp.code === activeCode ? "is-active" : ""}" type="button" data-competition="${comp.code}">${esc(comp.shortName)}</button>`).join("");
  return `<div class="compchips">
    ${includeAll ? `<button class="compchip ${activeCode == null ? "is-active" : ""}" type="button" data-all-scores>All matches</button>` : ""}
    ${chips}</div>`;
}

// -- Hero -----------------------------------------------------------------------

export function renderHero(model) {
  const live = model.matches.filter((match) => isLive(match.status));
  const next = model.matches
    .filter((match) => ["TIMED", "SCHEDULED"].includes(match.status))
    .sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate))[0];
  const seasonStarted = model.matches.some(
    (match) => isFinished(match.status) || isLive(match.status),
  );
  const activeMatchdays = [...new Set(live.map((match) => match.matchday).filter(Number.isFinite))];
  const currentMatchday = live.length
    ? (activeMatchdays.length === 1 ? activeMatchdays[0] : null)
    : next?.matchday ?? latestMatchday(model.matches.filter((match) => isFinished(match.status)));
  const leader = model.tables?.[0]?.rows?.[0] ?? null;

  const title = !seasonStarted && next
    ? `Season starts ${esc(dayLabel(next.utcDate))}`
    : currentMatchday
      ? `Matchday ${currentMatchday}`
      : "Live scores & table";

  const chips = [
    live.length
      ? `<span class="chip"><span class="chip__dot"></span>${live.length} live now</span>`
      : next
        ? `<span class="chip">Next: ${esc(displayTeamName(next.homeTeam))} v ${esc(displayTeamName(next.awayTeam))} · ${esc(dayLabel(next.utcDate))}</span>`
        : "",
    seasonStarted && leader
      ? `<span class="chip">Top: ${esc(displayTeamName(leader.team))} · ${leader.points} pts</span>`
      : "",
  ]
    .filter(Boolean)
    .join("");

  return `
    <div class="hero__head">
      <div class="hero__lead">
        <p class="hero__eyebrow">${esc(model.competition.name)}</p>
        <h1 class="hero__title">${title}</h1>
      </div>
      <div class="hero__meta">${chips}</div>
    </div>`;
}

function latestMatchday(matches) {
  return matches.reduce(
    (max, match) => (Number.isFinite(match.matchday) && match.matchday > max ? match.matchday : max),
    0,
  ) || null;
}

// -- Scores tab bar ----------------------------------------------------------------

const SCORES_TABS = [
  ["live", "Live & today"],
  ["tables", "Table"],
  ["knockout", "Knockout"],
  ["fixtures", "Fixtures"],
  ["predict", "Predict"],
  ["stats", "Player stats"],
];

export function renderScoresTabs(model, activeTab) {
  const hasKnockout = knockoutMatches(model).length > 0;
  return `<div class="stabs">${SCORES_TABS.filter(([key]) => key !== "knockout" || hasKnockout)
    .map(
      ([key, label]) =>
        `<button class="stab ${key === activeTab ? "is-active" : ""}" type="button" data-tab="${key}">${label}</button>`,
    )
    .join("")}</div>`;
}

// -- Match rows ----------------------------------------------------------------------

function matchLine(match) {
  const live = isLive(match.status);
  // A fixture whose kickoff is well past while the feed still calls it pre-match
  // is one we have lost track of. Showing the bare kickoff time there reads as
  // "hasn't started", which is the false claim; the time plus an explicit mark
  // keeps the fact we do know and drops the one we do not.
  const overdue = isOverdueFixture(match);
  const statusText = overdue ? `${statusLabel(match)} ?` : statusLabel(match);
  return `<div class="mline" data-match-id="${match.id ?? ""}" role="button" tabindex="0">
      <span class="mline__st ${live ? "is-live" : ""}${overdue ? " is-overdue" : ""}"${
        overdue ? ` title="Kick-off has passed but there is no update for this match yet: the live feed is running behind."` : ""
      }>${esc(statusText)}</span>
      <span class="mline__side mline__side--h"><span class="mline__name">${esc(displayTeamName(match.homeTeam))}</span>${badgeFor(match.homeTeam)}</span>
      <span class="mline__score">${scoreText(match)}${penaltyTag(match)}</span>
      <span class="mline__side">${badgeFor(match.awayTeam)}<span class="mline__name">${esc(displayTeamName(match.awayTeam))}</span></span>
    </div>`;
}

// Says out loud that the live feed is behind, instead of leaving a played match
// sitting there with a kickoff time as though it had not started. Named fixtures
// rather than a generic warning, because "Hull City v Man United kicked off 47
// minutes ago" is checkable and "something may be stale" is not.
//
// Deliberately does NOT guess a scoreline or promote the match to live. We do not
// know the score, and a fabricated one would be worse than an honest gap.
function renderFeedDelayBanner(model, now) {
  const notice = feedDelayNotice({
    matches: model.matches,
    stale: Boolean(model.stale),
    staleAgeMs: model.staleAgeMs ?? null,
    now,
  });
  if (!notice) return "";

  const minutes = notice.behindByMs != null ? Math.round(notice.behindByMs / 60000) : null;
  const named = notice.overdue
    .slice(0, 3)
    .map((match) => `${displayTeamName(match.homeTeam)} v ${displayTeamName(match.awayTeam)}`)
    .join(", ");
  const extra = notice.overdue.length > 3 ? ` and ${notice.overdue.length - 3} more` : "";

  const detail = named
    ? `${esc(named)}${esc(extra)} should have kicked off${minutes ? ` about ${minutes} minutes ago` : ""}, but we have had no update since.`
    : model.lastUpdated
      ? `Last available update: ${esc(dateLabel(model.lastUpdated))}.`
      : "We could not confirm when these scores were last updated.";

  return `
    <section class="card feeddelay" role="status">
      <p class="feeddelay__title">Live data is behind</p>
      <p class="note">${detail} Showing the last figures we have rather than guessing.</p>
    </section>`;
}

// -- Live & today -----------------------------------------------------------------------

function matchesOnDate(model, date) {
  return (model.matches ?? []).filter(match => localDateKey(match.utcDate) === date)
    .sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate));
}

function scoreDateControls(selectedDate, liveOnly, liveCount) {
  return `<div class="score-controls" aria-label="Match dates and filters">
    <button class="seg" type="button" data-score-action="previous" aria-label="Previous day">‹</button>
    <label class="score-controls__date"><input type="date" data-score-date aria-label="Match date" value="${selectedDate}"></label>
    <button class="seg" type="button" data-score-action="next" aria-label="Next day">›</button>
    <button class="seg ${selectedDate === localDateKey() ? "is-active" : ""}" type="button" data-score-action="today">Today</button>
    <button class="seg ${liveOnly ? "is-active" : ""}" type="button" data-score-action="live" aria-pressed="${liveOnly}">Live <span class="seg__count">${liveCount}</span></button>
  </div>`;
}

function scoreDayRows(model, selectedDate, liveOnly) {
  const dayMatches = matchesOnDate(model, selectedDate);
  const matches = liveOnly ? dayMatches.filter(match => isLive(match.status)) : dayMatches;
  const next = (model.matches ?? [])
    .filter(match => ["TIMED", "SCHEDULED"].includes(match.status) && localDateKey(match.utcDate) > selectedDate)
    .sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate))[0];
  const empty = liveOnly ? "No live matches on this date." : selectedDate === localDateKey() ? "No kick-offs today." : "No matches on this date.";
  return `${matches.length ? matches.map(matchLine).join("") : `<p class="note">${empty}</p>`}
    ${!dayMatches.length && next ? `<p class="note">Next: ${esc(displayTeamName(next.homeTeam))} v ${esc(displayTeamName(next.awayTeam))} · ${esc(dayLabel(next.utcDate))}</p>` : ""}`;
}

export function renderLive(model, { date = null, liveOnly = false } = {}) {
  const selectedDate = validScoreDate(date) ? date : localDateKey();
  const dayMatches = matchesOnDate(model, selectedDate);
  const liveCount = dayMatches.filter(match => isLive(match.status)).length;
  const count = liveOnly ? liveCount : dayMatches.length;
  const title = selectedDate === localDateKey() ? "Today" : dayLabel(`${selectedDate}T12:00:00`);
  return `${scoreDateControls(selectedDate, liveOnly, liveCount)}
    ${renderFeedDelayBanner(model, Date.now())}
    <section class="card card--list score-day">
      <h2 class="card__title">${esc(title)} · ${count} ${count === 1 ? "match" : "matches"}</h2>
      ${scoreDayRows(model, selectedDate, liveOnly)}
    </section>`;
}

export function renderScoresHome(feeds, { date = null, liveOnly = false } = {}) {
  const selectedDate = validScoreDate(date) ? date : localDateKey();
  const liveCount = feeds.flatMap(feed => matchesOnDate(feed, selectedDate)).filter(match => isLive(match.status)).length;
  const priority = feed => {
    const matches = matchesOnDate(feed, selectedDate);
    return matches.some(match => isLive(match.status)) ? 2 : !liveOnly && matches.length ? 1 : 0;
  };
  const ordered = [...feeds].sort((a, b) => priority(b) - priority(a));
  const groups = ordered.map(feed => {
    const code = feed.competition.code;
    return `<section class="card card--list score-day score-league" data-score-league="${code}" aria-label="${esc(feed.competition.shortName)}">
      <div class="score-league__heading">
        <h2 class="card__title">${esc(feed.competition.shortName)}</h2>
        <button type="button" class="score-league__table" data-score-table="${code}" aria-label="${esc(feed.competition.shortName)} table">Table ›</button>
      </div>
      <p class="score-league__freshness ${feed.stale || feed.error ? "is-delayed" : ""}">Updated <span data-feed-age="${code}"></span></p>
      ${feed.loading ? '<p class="note" role="status">Loading matches…</p>'
        : feed.error ? `<p class="note" role="status">Scores unavailable.</p><button class="seg" data-score-feed-retry="${code}">Try again</button>`
        : !feed.hasData ? '<p class="note">No fixtures published.</p>'
        : `${feed.stale ? `<p class="note" role="status">Live updates delayed. Showing the last available scores. <button class="score-league__table" data-score-feed-retry="${code}">Retry</button></p>` : ""}${scoreDayRows(feed, selectedDate, liveOnly)}`}
    </section>`;
  }).join("");
  return `${scoreDateControls(selectedDate, liveOnly, liveCount)}${groups}`;
}

// -- League table ----------------------------------------------------------------------------

function formDots(form) {
  if (!form?.length) return "";
  return form.map((r) => `<span class="fdot fdot--${esc(r)}" title="${esc(r)}"></span>`).join("");
}

export function renderTable(model) {
  if (!model.tables.length) {
    return `<p class="note">No table published yet.</p>`;
  }

  const cards = model.tables
    .map((table) => {
      const rows = table.rows
        .map(
          (row) => `<div class="ltable__row${row.live ? " is-liverow" : ""}">
            <span class="ltable__pos"><span class="zbar ${row.zone ? `zbar--${row.zone.tone}` : ""}"></span><span class="ltable__posnum">${row.position}</span></span>
            <span class="ltable__club">${badgeFor(row.team)}<span class="ltable__team">${esc(displayTeamName(row.team))}</span></span>
            <span class="ltable__num">${row.played}</span>
            <span class="ltable__num ltable__wdl">${row.won}</span>
            <span class="ltable__num ltable__wdl">${row.drawn}</span>
            <span class="ltable__num ltable__wdl">${row.lost}</span>
            <span class="ltable__num">${row.goalDifference > 0 ? "+" : ""}${row.goalDifference}</span>
            <span class="ltable__pts">${row.points}</span>
            <span class="ltable__form">${formDots(row.form)}</span>
          </div>`,
        )
        .join("");
      return `<section class="card ltable">
          ${model.tables.length > 1 ? `<h3 class="card__title">${esc(table.name)}</h3>` : ""}
          ${
            table.live
              ? `<p class="note ltable__livenote">As it stands: includes today's results and matches still in play, so these figures can still change.</p>`
              : ""
          }
          ${table.rankingIncomplete ? '<p class="note">Some tied positions remain in the published order until all tie-break information is available.</p>' : ""}
          <div class="ltable__row ltable__head">
            <span>#</span><span>Club</span><span class="ltable__num">P</span>
            <span class="ltable__num ltable__wdl">W</span><span class="ltable__num ltable__wdl">D</span><span class="ltable__num ltable__wdl">L</span>
            <span class="ltable__num">GD</span><span class="ltable__pts">Pts</span><span class="ltable__form">Form</span>
          </div>
          ${rows}
        </section>`;
    })
    .join("");

  return `${cards}${renderLegend(model.competition, "legend")}`;
}

function renderLegend(competition, className) {
  const zones = competition.zones ?? [];
  if (!zones.length) return "";
  return `<p class="${className}">${zones
    .map(
      (zone) =>
        `<span class="legend__item"><span class="legend__swatch legend__swatch--${zone.tone}"></span>${esc(zone.label)} (${zone.from}–${zone.to})</span>`,
    )
    .join("")}</p>`;
}

// -- Mini table (desktop aside) -----------------------------------------------------------------

export function renderMiniTable(model) {
  const table = model.tables?.[0];
  if (!table) return "";
  const rows = table.rows
    .map(
      (row) => `<div class="minirow">
        <span class="zbar ${row.zone ? `zbar--${row.zone.tone}` : ""}"></span>
        <span class="minirow__pos">${row.position}</span>
        <span class="minirow__club">${badgeFor(row.team)}<span class="minirow__team">${esc(displayTeamName(row.team))}</span></span>
        <span class="minirow__pts">${row.points}</span>
      </div>`,
    )
    .join("");
  const legend = (model.competition.zones ?? [])
    .map(
      (zone) =>
        `<span class="legend__item"><span class="legend__swatch legend__swatch--${zone.tone}"></span>${esc(zone.label)}</span>`,
    )
    .join("");
  return `<aside class="aside">
      <div class="aside__head">
        <h3 class="aside__title">${esc(model.competition.code === "CL" ? "League phase" : "League table")}</h3>
        <button class="aside__more" type="button" data-tab="tables">Full →</button>
      </div>
      ${rows}
      ${legend ? `<div class="aside__legend">${legend}</div>` : ""}
    </aside>`;
}

// -- Knockout (cups) ------------------------------------------------------------------------------

const KNOCKOUT_STAGE_ORDER = [
  "FIRST_QUALIFYING_ROUND",
  "SECOND_QUALIFYING_ROUND",
  "THIRD_QUALIFYING_ROUND",
  "QUALIFYING",
  "PLAYOFFS",
  "PLAYOFF_ROUND",
  "LAST_32",
  "ROUND_OF_32",
  "LAST_16",
  "ROUND_OF_16",
  "QUARTER_FINALS",
  "SEMI_FINALS",
  "THIRD_PLACE",
  "FINAL",
];

const LEAGUE_STAGES = new Set(["REGULAR_SEASON", "LEAGUE_STAGE", "GROUP_STAGE"]);

export function knockoutMatches(model) {
  return model.matches.filter((match) => match.stage && !LEAGUE_STAGES.has(match.stage));
}

// Display-only knockout board: one column per stage in bracket order, each tie card
// a real fixture (two-legged rounds show both legs). No seeding, no projection.
export function renderKnockout(model) {
  const byStage = new Map();
  knockoutMatches(model).forEach((match) => {
    if (!byStage.has(match.stage)) byStage.set(match.stage, []);
    byStage.get(match.stage).push(match);
  });

  if (!byStage.size) {
    return `<p class="note">No knockout ties yet. They appear once the draw is made.</p>`;
  }

  const stageRank = (stage) => {
    const index = KNOCKOUT_STAGE_ORDER.indexOf(stage);
    return index === -1 ? KNOCKOUT_STAGE_ORDER.indexOf("PLAYOFFS") - 0.5 : index;
  };

  const koCard = (match) => `<div class="kocard kocard--openable" data-match-id="${match.id ?? ""}" role="button" tabindex="0">
      <div class="kocard__grid">
        <span class="kocard__team">${badgeFor(match.homeTeam)}<span class="kocard__name">${esc(displayTeamName(match.homeTeam))}</span></span>
        <span class="kocard__score">${Number.isFinite(match.score?.home) ? match.score.home : "–"}</span>
        <span class="kocard__team">${badgeFor(match.awayTeam)}<span class="kocard__name">${esc(displayTeamName(match.awayTeam))}</span></span>
        <span class="kocard__score">${Number.isFinite(match.score?.away) ? match.score.away : "–"}</span>
      </div>
      <p class="kocard__note">${esc(statusLabel(match))}${match.utcDate ? ` · ${esc(dayLabel(match.utcDate))}` : ""}${penaltyTag(match)}</p>
    </div>`;

  const columns = [...byStage.entries()]
    .sort((a, b) => stageRank(a[0]) - stageRank(b[0]))
    .map(
      ([stage, matches]) => `<div class="kocol">
        <h3>${esc(formatStage(stage))}</h3>
        ${matches
          .sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate))
          .map(koCard)
          .join("")}
      </div>`,
    )
    .join("");

  return `<div class="koboard">${columns}</div>
    <p class="note" style="margin-top:10px;">Ties straight from the feed; two-legged rounds show both legs.</p>`;
}

// -- Fixtures ----------------------------------------------------------------------------------------

// `team` is "All" or a club name exactly as it appears on a match. Filtering by
// club is the one thing a 380-fixture season list is unusable without: the
// question people actually bring to this page is "when do we play", not "what
// is on this weekend". The Results/Upcoming counts are deliberately computed
// AFTER the club filter, so they describe the list actually on screen rather
// than the whole competition.
export function renderFixtures(model, view = "results", team = "All") {
  const isUpcoming = (match) => !isFinished(match.status) && !isLive(match.status);
  const upcoming = view === "upcoming";
  const clubs = [...new Set(model.matches.flatMap((match) => [match.homeTeam, match.awayTeam]).filter(Boolean))].sort(
    (a, b) => a.localeCompare(b),
  );
  const activeTeam = team && clubs.includes(team) ? team : "All";
  const inTeam = (match) => activeTeam === "All" || match.homeTeam === activeTeam || match.awayTeam === activeTeam;

  const scoped = model.matches.filter(inTeam);
  const counts = {
    results: scoped.filter((match) => !isUpcoming(match)).length,
    upcoming: scoped.filter(isUpcoming).length,
  };

  const byDay = new Map();
  scoped
    .filter((match) => (upcoming ? isUpcoming(match) : !isUpcoming(match)))
    .sort((a, b) =>
      upcoming
        ? new Date(a.utcDate) - new Date(b.utcDate)
        : new Date(b.utcDate) - new Date(a.utcDate),
    )
    .forEach((match) => {
      const day = dayLabel(match.utcDate);
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(match);
    });

  const days = [...byDay.entries()]
    .map(
      ([day, dayMatches]) => `<section class="fxday">
        <h3>${day}</h3>
        <div class="fxday__card">${dayMatches.map(matchLine).join("")}</div>
      </section>`,
    )
    .join("");

  const segments = [
    ["results", "Results", counts.results],
    ["upcoming", "Upcoming", counts.upcoming],
  ]
    .map(
      ([key, label, count]) =>
        `<button class="seg ${key === view ? "is-active" : ""}" type="button" data-fixture-view="${key}">${label} <span class="seg__count">(${count})</span></button>`,
    )
    .join("");

  // Option VALUES stay the canonical join key (the filter compares against
  // match team names); only the visible label goes through displayTeamName.
  const teamOptions = ["All", ...clubs]
    .map(
      (club) =>
        `<option value="${esc(club)}"${club === activeTeam ? " selected" : ""}>${club === "All" ? "All clubs" : esc(displayTeamName(club))}</option>`,
    )
    .join("");

  const empty =
    activeTeam === "All"
      ? `No ${upcoming ? "upcoming fixtures" : "results yet"}.`
      : `No ${upcoming ? "upcoming fixtures" : "results yet"} for ${esc(displayTeamName(activeTeam))}.`;

  return `
    <div class="fxfilters">
      <div class="segrow">${segments}</div>
      <select class="fantasy-select" data-fixture-team aria-label="Filter fixtures by club">${teamOptions}</select>
    </div>
    ${days || `<p class="note">${empty}</p>`}`;
}

// -- Player stats --------------------------------------------------------------------------------------

// Goals / assists / involvements: everything the feed really has. The design's xG,
// Extra stat columns stay out until their scoring and display rules are agreed.
const STAT_SORTS = {
  goals: { label: "Goals", compare: compareByGoals, key: "goals" },
  assists: {
    label: "Assists",
    compare: (a, b) => b.assists - a.assists || b.goals - a.goals || a.player.localeCompare(b.player),
    key: "assists",
  },
  ga: { label: "G+A", compare: compareByInvolvements, key: "points" },
};

export function renderStats(model, sortKey = "goals") {
  const activeKey = STAT_SORTS[sortKey] ? sortKey : "goals";
  const sort = STAT_SORTS[activeKey];
  const scorers = [...(model.scorers ?? [])].sort(sort.compare);

  const segments = Object.entries(STAT_SORTS)
    .map(
      ([key, def]) =>
        `<button class="seg ${key === activeKey ? "is-active" : ""}" type="button" data-gb-sort="${key}">${def.label}</button>`,
    )
    .join("");

  const head = `
    <div class="statbar">
      <div class="segrow">${segments}</div>
      <span class="statbar__season">Season ${seasonLabel(model)}</span>
    </div>`;

  if (!scorers.length) {
    return `${head}<p class="note">No goals yet. The scorer board appears once the first goals are in.</p>`;
  }

  const sorted = (key) => (STAT_SORTS[activeKey].key === key ? "is-sorted" : "");
  const rows = scorers
    .map(
      (row, index) => `<div class="strow">
        <span class="strow__rk">${index + 1}</span>
        <span class="strow__player">${badgeFor(row.team, "lg")}
          <span class="strow__id"><strong>${esc(row.player)}</strong><span>${esc(displayTeamName(row.team))}</span></span>
        </span>
        <span class="strow__num ${sorted("goals")}">${row.goals}</span>
        <span class="strow__num ${sorted("assists")}">${row.assists}</span>
        <span class="strow__num ${sorted("points")}">${row.points}</span>
      </div>`,
    )
    .join("");

  return `${head}
    <section class="card" style="padding:6px 16px 10px;">
      <div class="strow strow--head">
        <span>#</span><span>Player</span><span class="strow__num">G</span><span class="strow__num">A</span><span class="strow__num">G+A</span>
      </div>
      ${rows}
    </section>
    <p class="note" style="margin:12px 2px 0;">Goal involvements this season.<span title="Penalties count. Own goals and shootout kicks do not. Updates every few minutes." class="fantasy-hint" role="img" aria-label="Penalties count. Own goals and shootout kicks do not.">?</span></p>`;
}

function seasonLabel(model) {
  const first = model.matches[0]?.utcDate;
  if (!first) return "";
  const year = new Date(first).getFullYear();
  const start = new Date(first).getMonth() >= 6 ? year : year - 1;
  return `${start}/${String((start + 1) % 100).padStart(2, "0")}`;
}

// -- You (account) -------------------------------------------------------------------------------------------

const PREF_LABELS = [
  ["goals", "Goals"],
  ["kickoff", "Kick-off"],
  ["fulltime", "Full-time"],
  ["red", "Red cards"],
  ["analysis", "Match analysis ready"],
  ["draft", "Draft reminders"],
  ["recap", "Weekly league recap"],
];

// Signed-out: the design's sign-in card. GIS renders the real Google button into
// #gisButton; `configured` false swaps it for an honest note.
export function renderSignedOut({ available, configured }) {
  const cta = !available
    ? `<p class="note">Sign-in needs the live data Worker, which this deployment does not have.</p>`
    : !configured
      ? `<p class="note">Sign-in is nearly ready. It switches on once the Google client is configured.</p>`
      : `<div class="you__gis" id="gisButton"></div>`;
  return `
    <div class="you you--signin">
      <span class="brand__mark you__mark">KD</span>
      <h2 class="you__title">Sign in to Kickoff Draft</h2>
      <p class="note">Follow your clubs, get goal alerts on this device, and run your fantasy squad. One tap with Google.</p>
      ${cta}
      <p class="note--dim">We only use Google to sign you in. No posts, no contacts.</p>
    </div>`;
}

// Signed-in: profile, followed clubs (the active competition's teams as toggle
// chips), and notification preferences (stored now, delivered by push in Phase 3).
export function renderSignedIn(model, account, isFollowed) {
  const user = account.user;
  const initial = (user.name ?? user.email ?? "?").trim()[0]?.toUpperCase() ?? "?";
  const teams = (model.tables?.[0]?.rows ?? []).map((row) => row.team);
  const comp = model.competition.code;

  const chips = teams
    .map((team) => {
      const on = isFollowed(comp, team);
      // data-follow-team stays the canonical join key: it is what POST
      // /follows/toggle stores and what push targeting matches against.
      return `<button class="compchip ${on ? "is-active" : ""}" type="button" data-follow-team="${esc(team)}">${badgeFor(team)} ${esc(displayTeamName(team))}</button>`;
    })
    .join("");

  const otherFollows = (account.follows ?? []).filter((f) => f.competition !== comp);

  const prefs = PREF_LABELS.map(([key, label]) => {
    const on = Boolean(user.prefs?.[key]);
    return `<div class="you__prefrow">
        <span>${label}</span>
        <button class="tgl ${on ? "is-on" : ""}" type="button" role="switch" aria-checked="${on}" data-pref-key="${key}"><span class="tgl__knob"></span></button>
      </div>`;
  }).join("");

  return `
    <div class="you">
      <section class="card you__profile">
        ${user.avatar ? `<img class="you__avatar" src="${esc(user.avatar)}" alt="" referrerpolicy="no-referrer" />` : `<span class="you__avatar you__avatar--initial">${esc(initial)}</span>`}
        <span class="you__id">
          <strong>${esc(user.name ?? "Signed in")}</strong>
          <span>${esc(user.email)} · Google</span>
        </span>
        <span class="topnav__spacer"></span>
        <button class="seg" type="button" data-sign-out>Sign out</button>
      </section>
      <section class="card">
        <h3 class="card__title">Followed clubs · ${esc(model.competition.shortName)}</h3>
        <p class="note" style="margin:0 0 12px;">Goal and result alerts for these clubs, sent as push notifications.</p>
        <div class="you__chips">${chips || `<p class="note">No clubs to follow until the feed opens the season.</p>`}</div>
        ${otherFollows.length ? `<p class="note--dim" style="margin-top:10px;">Also following: ${otherFollows.map((f) => esc(displayTeamName(f.team))).join(", ")}</p>` : ""}
      </section>
      <section class="card">
        <h3 class="card__title">Notifications</h3>
        <div class="you__prefrow you__device">
          <span>This device</span>
          <span data-push-controls><span class="note">Checking…</span></span>
        </div>
        ${prefs}
        <p class="note--dim" style="margin-top:10px;">Pushed to every device you enable, for the clubs and events above.</p>
      </section>
    </div>`;
}

// -- Footer ------------------------------------------------------------------------------------------------

// The guide links are real anchors to the pre-rendered /learn/ pages, not
// `data-tutorial-open` buttons, on purpose: those pages only rank if something
// links to them, and this is the site-wide link that every rendered page
// carries. Relative hrefs (no leading slash) so they keep resolving if the site
// is ever served from a subpath again, matching vite's base: "./".
// Derived from TUTORIALS, so a new tutorial appears here with no edit.
function footerLearnLinks() {
  const links = learnPages(TUTORIALS)
    .map((page) => `<a href="learn/${esc(page.slug)}/">${esc(page.tutorial.title)}</a>`)
    .join(" · ");
  // "All guides" capitalised to match the tutorial titles beside it and the
  // same link on the static Learn pages (renderLearnArticlePage), which was
  // already sentence case. It was the only lower-case link in the row.
  return links ? `<p class="footer__learn">Guides: ${links} · <a href="learn/">All guides</a></p>` : "";
}

export function renderFooter(model) {
  return `
    <p>Data: ${esc(model.source)}${model.lastUpdated ? ` · updated ${dateLabel(model.lastUpdated)}` : ""} · Kickoff Draft is a Goon Squad production · Not affiliated with the Premier League or UEFA.</p>
    ${footerLearnLinks()}
    <p class="footer__support"><a href="https://www.buymeacoffee.com/henderjm" target="_blank" rel="noopener noreferrer">Support Kickoff Draft</a></p>`;
}

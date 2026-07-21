import { abbrFor, badgeFor } from "./badges.js";
import { COMPETITIONS } from "./competitions.js";
import { compareByGoals, compareByInvolvements } from "./scorers.js";
import { dateLabel, dayLabel, formatStage, isFinished, isLive, statusLabel } from "./format.js";

function esc(value) {
  return String(value ?? "").replace(/[&<>"]/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
  })[char]);
}

// Small context tag for a match row: the group when there is one (cups), otherwise
// the matchday (leagues), otherwise the stage.
function matchTag(match) {
  if (match.group) return esc(match.group.replace("GROUP_", "Grp "));
  if (Number.isFinite(match.matchday)) return `MD ${match.matchday}`;
  return esc(formatStage(match.stage));
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

// Locked entries are the roadmap: visible so the destination is legible, inert
// until their data tier is switched on (same pattern as the design's SOON rows).
const LOCKED_COMPETITIONS = [
  { label: "Europa League", abbr: "UEL" },
  { label: "Conference League", abbr: "UECL" },
];

export function renderCompetitionSidebar(activeCode) {
  const rows = Object.values(COMPETITIONS)
    .map(
      (comp) => `<button class="comprow ${comp.code === activeCode ? "is-active" : ""}" type="button" data-competition="${comp.code}">
        <span class="comprow__mark">${esc(comp.code === "PL" ? "PL" : "UCL")}</span>
        <span class="comprow__label">${esc(comp.shortName)}</span>
      </button>`,
    )
    .join("");
  const locked = LOCKED_COMPETITIONS.map(
    (comp) => `<button class="comprow is-locked" type="button" disabled>
        <span class="comprow__mark">${esc(comp.abbr)}</span>
        <span class="comprow__label">${esc(comp.label)}</span>
        <span class="soon">Soon</span>
      </button>`,
  ).join("");
  return `<aside class="side">
      <h3 class="side__title">Competitions</h3>
      ${rows}${locked}
    </aside>`;
}

export function renderCompetitionChips(activeCode) {
  const chips = Object.values(COMPETITIONS)
    .map(
      (comp) =>
        `<button class="compchip ${comp.code === activeCode ? "is-active" : ""}" type="button" data-competition="${comp.code}">${esc(comp.shortName)}</button>`,
    )
    .join("");
  const locked = LOCKED_COMPETITIONS.map(
    (comp) => `<button class="compchip is-locked" type="button" disabled>${esc(comp.label)} <span class="soon">Soon</span></button>`,
  ).join("");
  return `<div class="compchips">${chips}${locked}</div>`;
}

// -- Hero -----------------------------------------------------------------------

export function renderHero(model) {
  const live = model.matches.filter((match) => isLive(match.status));
  const next = model.matches
    .filter((match) => !isFinished(match.status) && !isLive(match.status))
    .sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate))[0];
  const seasonStarted = model.matches.some(
    (match) => isFinished(match.status) || isLive(match.status),
  );
  const currentMatchday = next?.matchday ?? latestMatchday(model.matches);
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
        ? `<span class="chip">Next: ${esc(next.homeTeam)} v ${esc(next.awayTeam)} · ${esc(dayLabel(next.utcDate))}</span>`
        : "",
    seasonStarted && leader
      ? `<span class="chip">Top: ${esc(leader.team)} · ${leader.points} pts</span>`
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
  return `<div class="mline" data-match-id="${match.id ?? ""}" role="button" tabindex="0">
      <span class="mline__st ${live ? "is-live" : ""}">${esc(statusLabel(match))}</span>
      <span class="mline__side mline__side--h"><span class="mline__name">${esc(match.homeTeam)}</span>${badgeFor(match.homeTeam)}</span>
      <span class="mline__score">${scoreText(match)}${penaltyTag(match)}</span>
      <span class="mline__side">${badgeFor(match.awayTeam)}<span class="mline__name">${esc(match.awayTeam)}</span></span>
    </div>`;
}

function liveCard(match) {
  return `<div class="lcard" data-match-id="${match.id ?? ""}" role="button" tabindex="0">
      <div class="lcard__top">
        <span class="lcard__min">${esc(statusLabel(match))}</span>
        <span class="lcard__tag">${matchTag(match)}</span>
      </div>
      <div class="lcard__grid">
        <span class="lcard__team">${badgeFor(match.homeTeam, "lg")}<span class="lcard__name">${esc(match.homeTeam)}</span></span>
        <span class="lcard__score">${Number.isFinite(match.score?.home) ? match.score.home : "–"}</span>
        <span class="lcard__team">${badgeFor(match.awayTeam, "lg")}<span class="lcard__name">${esc(match.awayTeam)}</span></span>
        <span class="lcard__score">${Number.isFinite(match.score?.away) ? match.score.away : "–"}</span>
      </div>
    </div>`;
}

// -- Live & today -----------------------------------------------------------------------

export function renderLive(model) {
  const now = Date.now();
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = startOfDay.getTime() + 24 * 60 * 60 * 1000;

  const live = model.matches.filter((match) => isLive(match.status));
  const today = model.matches.filter((match) => {
    const time = new Date(match.utcDate).getTime();
    return !isLive(match.status) && time >= startOfDay.getTime() && time < endOfDay;
  });
  const upcoming = model.matches
    .filter((match) => !isFinished(match.status) && !isLive(match.status) && new Date(match.utcDate).getTime() >= endOfDay)
    .sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate))
    .slice(0, 6);
  const recent = model.matches
    .filter((match) => isFinished(match.status))
    .sort((a, b) => new Date(b.utcDate) - new Date(a.utcDate))
    .slice(0, 6);

  const listCard = (title, matches, empty) => `
    <section class="card card--list">
      <h3 class="card__title">${title}</h3>
      ${matches.length ? matches.map(matchLine).join("") : `<p class="note" style="margin:6px 0 10px;">${empty}</p>`}
    </section>`;

  return `
    ${
      live.length
        ? `<div class="livehead"><span class="livehead__dot"></span><h3>Live now</h3></div>
           <div class="livegrid">${live.map(liveCard).join("")}</div>`
        : ""
    }
    <div class="scoregrid">
      <div class="scorecol">
        ${listCard("Today", today, "No more kick-offs today.")}
        ${listCard("Next up", upcoming, "Nothing on the horizon.")}
      </div>
      <div class="scorecol">
        ${listCard("Recent results", recent, "No results yet.")}
      </div>
    </div>`;
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
          (row) => `<div class="ltable__row">
            <span class="ltable__pos"><span class="zbar ${row.zone ? `zbar--${row.zone.tone}` : ""}"></span><span class="ltable__posnum">${row.position}</span></span>
            <span class="ltable__club">${badgeFor(row.team)}<span class="ltable__team">${esc(row.team)}</span></span>
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
        <span class="minirow__club">${badgeFor(row.team)}<span class="minirow__team">${esc(row.team)}</span></span>
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
  "PLAYOFF_ROUND",
  "PLAYOFFS",
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
        <span class="kocard__team">${badgeFor(match.homeTeam)}<span class="kocard__name">${esc(match.homeTeam)}</span></span>
        <span class="kocard__score">${Number.isFinite(match.score?.home) ? match.score.home : "–"}</span>
        <span class="kocard__team">${badgeFor(match.awayTeam)}<span class="kocard__name">${esc(match.awayTeam)}</span></span>
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

export function renderFixtures(model, view = "results") {
  const isUpcoming = (match) => !isFinished(match.status) && !isLive(match.status);
  const upcoming = view === "upcoming";
  const counts = {
    results: model.matches.filter((match) => !isUpcoming(match)).length,
    upcoming: model.matches.filter(isUpcoming).length,
  };

  const byDay = new Map();
  model.matches
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

  return `
    <div class="segrow" style="margin-bottom:16px;">${segments}</div>
    ${days || `<p class="note">No ${upcoming ? "upcoming fixtures" : "results yet"}.</p>`}`;
}

// -- Player stats --------------------------------------------------------------------------------------

// Goals / assists / involvements: everything the feed really has. The design's xG,
// shots and minutes columns need a data tier football-data does not sell us yet.
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
          <span class="strow__id"><strong>${esc(row.player)}</strong><span>${esc(row.team)}</span></span>
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
    <p class="note" style="margin:12px 2px 0;">Goal involvements across the season. Penalties count; own goals and shootout kicks do not. Updates every few minutes.</p>`;
}

function seasonLabel(model) {
  const first = model.matches[0]?.utcDate;
  if (!first) return "";
  const year = new Date(first).getFullYear();
  const start = new Date(first).getMonth() >= 6 ? year : year - 1;
  return `${start}/${String((start + 1) % 100).padStart(2, "0")}`;
}

// -- Footer ------------------------------------------------------------------------------------------------

export function renderFooter(model) {
  return `
    <p>Data: ${esc(model.source)}${model.lastUpdated ? ` · updated ${dateLabel(model.lastUpdated)}` : ""} · Squad Goals is a Goon Squad production · Not affiliated with the Premier League or UEFA.</p>`;
}

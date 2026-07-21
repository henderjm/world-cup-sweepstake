import { badgeFor } from "./badges.js";
import { COMPETITIONS } from "./competitions.js";
import { compareByGoals, compareByInvolvements } from "./scorers.js";
import {
  dateLabel,
  dayLabel,
  formatStage,
  isFinished,
  isLive,
  signed,
  statusLabel,
} from "./format.js";

function esc(value) {
  return String(value ?? "").replace(/[&<>"]/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
  })[char]);
}

function isKnown(team) {
  return team && team !== "Unknown";
}

function teamCell(team) {
  if (!isKnown(team)) return `<span class="team team--tbd">TBD</span>`;
  return `<span class="team">
      <span class="team__flag">${badgeFor(team)}</span>
      <span class="team__name">${esc(team)}</span>
    </span>`;
}

function mapLink(match, className = "loc-link") {
  if (!match?.city || !match?.mapUrl) return "";
  const label = match.venue ? `${match.city} · ${match.venue}` : match.city;
  return `<a class="${className}" href="${esc(match.mapUrl)}" target="_blank" rel="noopener noreferrer" data-map-link title="${esc(label)} on Google Maps">${esc(match.city)}</a>`;
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

// Shootout marker for a decided knockout tie. Penalties are shown home-away to match the
// score, so the leading number names the team that went through.
function penaltyTag(match) {
  if (!hasPenalties(match)) return "";
  return ` <span class="pens" title="Decided on penalties">(${match.penalties.home}-${match.penalties.away} pens)</span>`;
}

// Score for a row. Finished/decided games show the number (0-0 included), plus a shootout
// tag when a level tie went to penalties. Live games whose score the free feed withholds
// show a pulsing live marker instead of a blank.
function scoreCell(match) {
  if (hasScore(match.score)) return `${match.score.home} <i>-</i> ${match.score.away}${penaltyTag(match)}`;
  if (isLive(match.status)) {
    return `<span class="score-pending" title="Live, score not in the free feed yet">●</span>`;
  }
  return `<i>-</i>`;
}

function tickerScore(match) {
  if (!hasScore(match.score)) return "●";
  return `${match.score.home}-${match.score.away}${hasPenalties(match) ? ` (${match.penalties.home}-${match.penalties.away}p)` : ""}`;
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
    .slice(0, 14);

  if (!items.length) {
    return `<div class="ticker__track"><span class="ticker__item ticker__item--idle">No live or recent games right now. Next up below.</span></div>`;
  }

  const cells = items
    .map((match) => {
      const live = isLive(match.status);
      return `<span class="ticker__item ${live ? "is-live" : ""}">
        <span class="ticker__status">${live ? `${statusLabel(match)} ●` : "FT"}</span>
        ${badgeFor(match.homeTeam)} ${esc(match.homeTeam)}
        <b>${tickerScore(match)}</b>
        ${esc(match.awayTeam)} ${badgeFor(match.awayTeam)}
      </span>`;
    })
    .join("");
  // Doubled so the marquee loops seamlessly.
  return `<div class="ticker__track">${cells}${cells}</div>`;
}

// -- Hero: competition header --------------------------------------------------

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

  // Pre-season the table is alphabetical zeros, so the leader chip means nothing
  // and "Matchday 1" undersells a kickoff still weeks away.
  const title = !seasonStarted && next
    ? `Season starts ${esc(dayLabel(next.utcDate))}`
    : currentMatchday
      ? `Matchday ${currentMatchday}`
      : "Live scores & table";

  const chips = [
    live.length
      ? `<span class="chip chip--mover">● ${live.length} live now</span>`
      : next
        ? `<span class="chip">Next: ${esc(next.homeTeam)} v ${esc(next.awayTeam)} · ${esc(dayLabel(next.utcDate))}</span>`
        : "",
    seasonStarted && leader
      ? `<span class="chip">Top: ${badgeFor(leader.team)} ${esc(leader.team)} · ${leader.points} pts</span>`
      : "",
  ]
    .filter(Boolean)
    .join("");

  return `
    <div class="hero__head">
      <div>
        <p class="hero__eyebrow">${esc(model.competition.name)}</p>
        <h1 class="hero__title">${title}</h1>
      </div>
      <div class="hero__meta">
        ${renderCompetitionSwitcher(model.competition.code)}
        ${chips}
      </div>
    </div>`;
}

// Rendered inside the hero, and also on the pending screen so a competition whose
// feed has nothing yet (a cup before its season opens) never traps the visitor.
export function renderCompetitionSwitcher(activeCode) {
  const buttons = Object.values(COMPETITIONS)
    .map(
      (comp) =>
        `<button class="seg ${comp.code === activeCode ? "is-active" : ""}" data-competition="${comp.code}" type="button">${esc(comp.shortName)}</button>`,
    )
    .join("");
  return `<div class="seg-group" data-control="competition">${buttons}</div>`;
}

function latestMatchday(matches) {
  return matches.reduce(
    (max, match) => (Number.isFinite(match.matchday) && match.matchday > max ? match.matchday : max),
    0,
  ) || null;
}

// -- Live & Today ------------------------------------------------------------

function matchRow(match) {
  const live = isLive(match.status);
  return `<div class="mrow ${live ? "is-live" : ""}" data-match-id="${match.id ?? ""}" role="button" tabindex="0">
      <span class="mrow__status">${statusLabel(match)}</span>
      <span class="mrow__side">${teamCell(match.homeTeam)}</span>
      <span class="mrow__score">${scoreCell(match)}</span>
      <span class="mrow__side mrow__side--away">${teamCell(match.awayTeam)}</span>
      <span class="mrow__meta">${mapLink(match)}<span class="mrow__tag">${matchTag(match)}</span></span>
    </div>`;
}

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
    .slice(0, 6);
  const recent = model.matches
    .filter((match) => isFinished(match.status))
    .sort((a, b) => new Date(b.utcDate) - new Date(a.utcDate))
    .slice(0, 6);

  const block = (title, matches, empty) => `
    <section class="live-block">
      <h3>${title}</h3>
      ${matches.length ? matches.map(matchRow).join("") : `<p class="panel__note">${empty}</p>`}
    </section>`;

  return `
    <div class="panel__head"><h2>Live & today</h2></div>
    ${live.length ? `<div class="live-now">${block("Live now", live, "")}</div>` : ""}
    ${block("Today", today, "No more games scheduled today.")}
    ${block("Next up", upcoming, "Nothing on the horizon.")}
    ${block("Recent results", recent, "No results yet.")}`;
}

// -- League table --------------------------------------------------------------

export function renderTable(model) {
  if (!model.tables.length) {
    return `<div class="panel__head"><h2>Table</h2></div><p class="panel__note">No table published yet.</p>`;
  }

  const legend = legendFor(model.competition);

  const cards = model.tables
    .map((table) => {
      const rows = table.rows
        .map(
          (row) => `<tr class="${row.zone ? `grp--${row.zone.tone}` : ""}">
            <td class="grp__pos">${row.position}</td>
            <td class="grp__team">${teamCell(row.team)}</td>
            <td>${row.played}</td>
            <td class="grp__num--wide">${row.won}</td>
            <td class="grp__num--wide">${row.drawn}</td>
            <td class="grp__num--wide">${row.lost}</td>
            <td>${signed(row.goalDifference)}</td>
            <td class="grp__pts">${row.points}</td>
          </tr>`,
        )
        .join("");
      return `<article class="grp grp--league">
          <h3>${esc(table.name)}</h3>
          <table>
            <thead><tr><th></th><th>Team</th><th>P</th><th class="grp__num--wide">W</th><th class="grp__num--wide">D</th><th class="grp__num--wide">L</th><th>GD</th><th>Pts</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </article>`;
    })
    .join("");

  return `
    <div class="panel__head"><h2>Table</h2></div>
    <div class="grp-grid grp-grid--league">${cards}</div>
    ${legend ? `<p class="panel__note">${legend}</p>` : ""}`;
}

function legendFor(competition) {
  return (competition.zones ?? [])
    .map((zone) => `<span class="legend legend--${zone.tone}"></span> ${esc(zone.label)} (${zone.from}–${zone.to})`)
    .join(" · ");
}

// -- Knockout (cups) -----------------------------------------------------------

// Stage display order for the knockout view, qualifying first, final last. Any stage
// the feed sends that is not listed lands between qualifiers and the play-offs.
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

// Stages that are the league/group part of a competition, not knockout football.
const LEAGUE_STAGES = new Set(["REGULAR_SEASON", "LEAGUE_STAGE", "GROUP_STAGE"]);

export function knockoutMatches(model) {
  return model.matches.filter((match) => match.stage && !LEAGUE_STAGES.has(match.stage));
}

// Display-only knockout view: the real fixtures grouped by stage in bracket order,
// each stage's ties in kickoff order. Two-legged rounds simply list both legs; no
// seeding or projection, the feed is the single source of truth.
export function renderKnockout(model) {
  const byStage = new Map();
  knockoutMatches(model).forEach((match) => {
    if (!byStage.has(match.stage)) byStage.set(match.stage, []);
    byStage.get(match.stage).push(match);
  });

  if (!byStage.size) {
    return `<div class="panel__head"><h2>Knockout</h2></div><p class="panel__note">No knockout ties yet. They appear once the draw is made.</p>`;
  }

  const stageRank = (stage) => {
    const index = KNOCKOUT_STAGE_ORDER.indexOf(stage);
    return index === -1 ? KNOCKOUT_STAGE_ORDER.indexOf("PLAYOFFS") - 0.5 : index;
  };

  const sections = [...byStage.entries()]
    .sort((a, b) => stageRank(a[0]) - stageRank(b[0]))
    .map(
      ([stage, matches]) => `<section class="fx-day">
        <h3>${esc(formatStage(stage))}</h3>
        ${matches
          .sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate))
          .map(matchRow)
          .join("")}
      </section>`,
    )
    .join("");

  return `
    <div class="panel__head"><h2>Knockout</h2></div>
    ${sections}
    <p class="panel__note">Ties straight from the feed; two-legged rounds show both legs.</p>`;
}

// -- Fixtures ----------------------------------------------------------------

function fixtureRow(match) {
  return `<div class="fx ${isLive(match.status) ? "is-live" : ""}" data-match-id="${match.id ?? ""}" role="button" tabindex="0">
      <span class="fx__time">${statusLabel(match)}</span>
      <span class="fx__side">${teamCell(match.homeTeam)}</span>
      <span class="fx__score">${scoreCell(match)}</span>
      <span class="fx__side fx__side--away">${teamCell(match.awayTeam)}</span>
      <span class="fx__meta">${mapLink(match)}<span class="fx__tag">${matchTag(match)}</span></span>
    </div>`;
}

export function renderFixtures(model, view = "results") {
  // A result is anything kicked off: finished or in play. Everything else is upcoming.
  const isUpcoming = (match) => !isFinished(match.status) && !isLive(match.status);

  const upcoming = view === "upcoming";
  const counts = {
    results: model.matches.filter((match) => !isUpcoming(match)).length,
    upcoming: model.matches.filter(isUpcoming).length,
  };

  // Results read newest-first so the latest result (and any live game) sits at the top
  // with no scrolling; upcoming reads soonest-first so the next kickoff is at the top.
  // Bucketing in sorted order makes the day sections fall out in the same direction.
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
      ([day, dayMatches]) => `<section class="fx-day">
        <h3>${day}</h3>
        ${dayMatches.map(fixtureRow).join("")}
      </section>`,
    )
    .join("");

  const segments = [
    ["results", "Results", counts.results],
    ["upcoming", "Upcoming", counts.upcoming],
  ]
    .map(
      ([key, label, count]) =>
        `<button class="seg ${key === view ? "is-active" : ""}" data-fixture-view="${key}">${label} <span class="seg__count">${count}</span></button>`,
    )
    .join("");

  return `
    <div class="panel__head">
      <h2>Fixtures</h2>
      <div class="fx-controls">
        <div class="seg-group" data-control="fixture-view">${segments}</div>
      </div>
    </div>
    ${days || `<p class="panel__note">No ${upcoming ? "upcoming fixtures" : "results yet"}.</p>`}`;
}

// -- Golden Boot -------------------------------------------------------------

// Goals first: the Golden Boot is a goals award, so it is the primary metric and
// the default sort. Goals + assists is offered as the secondary view.
const GOLDEN_BOOT_SORTS = {
  goals: { label: "Goals", compare: compareByGoals },
  ga: { label: "Goals + assists", compare: compareByInvolvements },
};

export function renderGoldenBoot(model, sortKey = "goals") {
  const activeKey = GOLDEN_BOOT_SORTS[sortKey] ? sortKey : "goals";
  const sort = GOLDEN_BOOT_SORTS[activeKey];
  const scorers = [...(model.scorers ?? [])].sort(sort.compare);

  const controls = Object.entries(GOLDEN_BOOT_SORTS)
    .map(
      ([key, def]) =>
        `<button class="seg ${key === activeKey ? "is-active" : ""}" data-gb-sort="${key}">${def.label}</button>`,
    )
    .join("");

  // Accent the column that is actually being ranked, so the toggle visibly changes
  // the emphasis instead of always highlighting G+A.
  const goalsClass = activeKey === "goals" ? "lb__num gb__pts" : "lb__num";
  const gaClass = activeKey === "ga" ? "lb__num gb__pts" : "lb__num lb__num--muted";

  const head = `
    <div class="panel__head">
      <h2>Golden Boot</h2>
      <div class="seg-group" data-control="golden-boot-sort">${controls}</div>
    </div>`;

  if (!scorers.length) {
    return `${head}
    <p class="panel__note">No goals yet. The scorer board appears once the first goals are in.</p>`;
  }

  const body = scorers
    .map(
      (row, index) => `<tr>
          <td class="lb__rank">${index + 1}</td>
          <td class="gb__player">
            <span class="gb__flag">${badgeFor(row.team)}</span>
            <span class="gb__id">
              <strong>${esc(row.player)}</strong>
              <span class="gb__team">${esc(row.team)}</span>
            </span>
          </td>
          <td class="${goalsClass}">${row.goals}</td>
          <td class="lb__num lb__num--muted">${row.assists}</td>
          <td class="${gaClass}">${row.points}</td>
        </tr>`,
    )
    .join("");

  return `${head}
    <div class="table-wrap">
      <table class="lb gb">
        <thead>
          <tr><th></th><th>Player</th><th>G</th><th>A</th><th>G+A</th></tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    </div>
    <p class="panel__note">Goal involvements across the season. Penalties count; own goals and penalty-shootout kicks do not. Updates every few minutes.</p>`;
}

// -- Footer ------------------------------------------------------------------

export function renderFooter(model) {
  return `
    <p class="footer__src">Data: ${esc(model.source)}${model.lastUpdated ? ` · updated ${dateLabel(model.lastUpdated)}` : ""}. Not affiliated with the ${esc(model.competition.name)}.</p>`;
}

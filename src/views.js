import { flagFor } from "./flags.js";
import { ENTRANTS, ownerOf } from "./data.js";
import { compareByGoals, compareByInvolvements } from "./scorers.js";
import {
  FINAL,
  KNOCKOUT_SCHEDULE_ORDER,
  OFFICIAL_R32_TEAMS,
  QF,
  R16,
  R32,
  SF,
  THIRD,
} from "./bracket.js";
import {
  dateLabel,
  dayLabel,
  formatStage,
  isFinished,
  isLive,
  money,
  percent,
  signed,
  statusLabel,
  timeLabel,
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

function teamCell(team, { owner = true } = {}) {
  if (!isKnown(team)) return `<span class="team team--tbd">TBD</span>`;
  const ownerName = owner ? ownerOf(team) : null;
  return `<span class="team">
      <span class="team__flag">${flagFor(team)}</span>
      <span class="team__name">${esc(team)}</span>
      ${ownerName ? `<span class="team__owner">${esc(ownerName)}</span>` : ""}
    </span>`;
}

function mapLink(match, className = "loc-link") {
  if (!match?.city || !match?.mapUrl) return "";
  const label = match.venue ? `${match.city} · ${match.venue}` : match.city;
  return `<a class="${className}" href="${esc(match.mapUrl)}" target="_blank" rel="noopener noreferrer" data-map-link title="${esc(label)} on Google Maps">${esc(match.city)}</a>`;
}

function momentumArrow(value) {
  if (value > 0) return `<span class="mover mover--up" title="On the up">▲</span>`;
  if (value < 0) return `<span class="mover mover--down" title="Slipping">▼</span>`;
  return `<span class="mover mover--flat" title="Holding">·</span>`;
}

function mergedRows(model) {
  return model.leaderboard.map((entrant) => ({
    entrant,
    forecast: model.forecast.entrants.get(entrant.name),
    momentum: model.momentum.get(entrant.name) ?? 0,
  }));
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
  return ` <span class="pens" title="Decided on penalties">(${match.penalties.home}-${match.penalties.away} pens)</span>`;
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
        ${flagFor(match.homeTeam)} ${esc(match.homeTeam)}
        <b>${tickerScore(match)}</b>
        ${esc(match.awayTeam)} ${flagFor(match.awayTeam)}
      </span>`;
    })
    .join("");
  // Doubled so the marquee loops seamlessly.
  return `<div class="ticker__track">${cells}${cells}</div>`;
}

// -- Hero: the race ----------------------------------------------------------

function contenderBar(row, max) {
  const width = max > 0 ? Math.max(2, (row.value / max) * 100) : 0;
  return `<li class="bar">
      <span class="bar__name">${esc(row.name)}</span>
      <span class="bar__track"><span class="bar__fill" style="width:${width}%"></span></span>
      <span class="bar__value">${percent(row.value)}</span>
    </li>`;
}

function prizeCard({ variant, amount, label, rows, valueKey, teamKey, footnote }) {
  const ranked = rows
    .map((row) => ({ name: row.forecast.name, value: row.forecast[valueKey], team: row.forecast[teamKey] }))
    .filter((row) => row.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 4);

  const leader = ranked[0];
  const max = leader ? leader.value : 0;

  return `<article class="prize prize--${variant}">
      <header class="prize__head">
        <span class="prize__amount">${money(amount)}</span>
        <span class="prize__label">${label}</span>
      </header>
      ${
        leader
          ? `<div class="prize__leader">
              <span class="prize__flag">${flagFor(leader.team)}</span>
              <div>
                <strong>${esc(leader.name)}</strong>
                <span class="prize__leadteam">${esc(leader.team)} · ${percent(leader.value)}</span>
              </div>
            </div>
            <ul class="prize__bars">${ranked.slice(1).map((row) => contenderBar(row, max)).join("")}</ul>`
          : `<p class="prize__empty">No projection yet.</p>`
      }
      ${footnote ? `<p class="prize__foot">${footnote}</p>` : ""}
    </article>`;
}

export function renderHero(model) {
  const rows = mergedRows(model);
  const topMover = rows
    .filter((row) => row.momentum > 0)
    .sort((a, b) => b.momentum - a.momentum)[0];

  const championConfirmed = model.prizes.champion.owner !== "TBC";

  return `
    <div class="hero__head">
      <div>
        <p class="hero__eyebrow">The race for the pot</p>
        <h1 class="hero__title">Who is on for the ${money(model.payouts.pot)}</h1>
      </div>
      <div class="hero__meta">
        <button type="button" class="chip chip--sim" aria-label="How the projection works">
          Projected from ${model.forecast.iterations.toLocaleString("en-IE")} simulations
          <span class="chip__tip" role="tooltip">We play the rest of the tournament out ${model.forecast.iterations.toLocaleString("en-IE")} times from the current results, giving each remaining game a plausible scoreline based on team strength, then count how often each entrant's teams take each prize. A model for fun, not a prediction: strengths are estimated and the knockout route is fixed by official match number.</span>
        </button>
        ${topMover ? `<span class="chip chip--mover">On the up: ${esc(topMover.name)} ▲</span>` : ""}
      </div>
    </div>
    <div class="hero__grid">
      ${prizeCard({
        variant: "champion",
        amount: model.payouts.first,
        label: "World Cup winner",
        rows,
        valueKey: "winPct",
        teamKey: "bestTeam",
        footnote: championConfirmed
          ? `Confirmed: ${esc(model.prizes.champion.owner)} (${esc(model.prizes.champion.team)})`
          : "Owner of the team that lifts the trophy",
      })}
      ${prizeCard({
        variant: "runnerup",
        amount: model.payouts.second,
        label: "Runner-up",
        rows,
        valueKey: "runnerUpPct",
        teamKey: "bestTeam",
        footnote: "Owner of the losing finalist",
      })}
      ${prizeCard({
        variant: "spoon",
        amount: model.payouts.woodenSpoon,
        label: "Wooden spoon",
        rows,
        valueKey: "spoonPct",
        teamKey: "spoonTeam",
        footnote:
          model.spoon.owner !== "TBC"
            ? `Confirmed: ${esc(model.spoon.owner)} (${esc(model.spoon.team)})`
            : "Owner of the worst confirmed group-last team",
      })}
    </div>`;
}

// -- Leaderboard -------------------------------------------------------------

const LEADERBOARD_SORTS = {
  now: { label: "Points now", value: (row) => row.entrant.score },
  proj: { label: "Projected", value: (row) => row.forecast.projectedPoints },
  win: { label: "Win odds", value: (row) => row.forecast.winPct },
  spoon: { label: "Spoon risk", value: (row) => row.forecast.spoonPct },
};

export function renderLeaderboard(model, sortKey = "now") {
  const sort = LEADERBOARD_SORTS[sortKey] ?? LEADERBOARD_SORTS.now;
  const rows = mergedRows(model).sort((a, b) => sort.value(b) - sort.value(a));

  const controls = Object.entries(LEADERBOARD_SORTS)
    .map(
      ([key, def]) =>
        `<button class="seg ${key === sortKey ? "is-active" : ""}" data-sort="${key}">${def.label}</button>`,
    )
    .join("");

  const body = rows
    .map((row, index) => {
      const teams = row.entrant.teams
        .map((team) => {
          const odds = model.forecast.teamTitleOdds.get(team.name) ?? 0;
          const danger = team.dangerLevel === "out" ? "is-out" : team.dangerLevel === "danger" ? "is-edge" : "";
          return `<span class="chiplet ${danger}" title="${esc(team.name)}: ${percent(odds)} title odds">
              ${flagFor(team.name)} <span class="chiplet__odds">${percent(odds)}</span>
            </span>`;
        })
        .join("");

      return `<tr>
          <td class="lb__rank">${index + 1}</td>
          <td class="lb__name">
            <strong>${esc(row.entrant.name)}</strong> ${momentumArrow(row.momentum)}
            <div class="lb__teams">${teams}</div>
          </td>
          <td class="lb__num">${row.entrant.score}</td>
          <td class="lb__num lb__num--muted">${row.forecast.projectedPoints}</td>
          <td class="lb__num lb__pct">${percent(row.forecast.winPct)}</td>
          <td class="lb__num lb__pct lb__pct--spoon">${percent(row.forecast.spoonPct)}</td>
        </tr>`;
    })
    .join("");

  return `
    <div class="panel__head">
      <h2>Sweepstake leaderboard</h2>
      <div class="seg-group" data-control="leaderboard-sort">${controls}</div>
    </div>
    <div class="table-wrap">
      <table class="lb">
        <thead>
          <tr>
            <th></th><th>Entrant</th><th>Now</th><th>Proj</th><th>Win</th><th>Spoon</th>
          </tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    </div>
    <p class="panel__note">Chiplets show each owned team and its projected odds of winning the tournament. Win and Spoon are this entrant's projected share of the prizes.</p>`;
}

// -- Live & Today ------------------------------------------------------------

function matchRow(match) {
  const live = isLive(match.status);
  return `<div class="mrow ${live ? "is-live" : ""}" data-match-id="${match.id ?? ""}" role="button" tabindex="0">
      <span class="mrow__status">${statusLabel(match)}</span>
      <span class="mrow__side">${teamCell(match.homeTeam)}</span>
      <span class="mrow__score">${scoreCell(match)}</span>
      <span class="mrow__side mrow__side--away">${teamCell(match.awayTeam)}</span>
      <span class="mrow__meta">${mapLink(match)}<span class="mrow__tag">${match.group ? esc(match.group) : formatStage(match.stage)}</span></span>
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

// -- Group tables ------------------------------------------------------------

export function renderGroupTables(model) {
  if (!model.groupTables.length) {
    return `<div class="panel__head"><h2>Group tables</h2></div><p class="panel__note">No group tables published yet.</p>`;
  }

  const cards = model.groupTables
    .map((group) => {
      const rows = group.rows
        .map(
          (row) => `<tr class="grp--${row.dangerLevel}">
            <td class="grp__pos">${row.position}</td>
            <td class="grp__team">${teamCell(row.team)}</td>
            <td>${row.played}</td>
            <td>${signed(row.goalDifference)}</td>
            <td class="grp__pts">${row.points}</td>
          </tr>`,
        )
        .join("");
      return `<article class="grp">
          <h3>${esc(group.name)}</h3>
          <table>
            <thead><tr><th></th><th>Team</th><th>P</th><th>GD</th><th>Pts</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </article>`;
    })
    .join("");

  return `
    <div class="panel__head"><h2>Group tables</h2></div>
    <div class="grp-grid">${cards}</div>
    <p class="panel__note">Green qualifies, amber is the third-place edge, red is bottom. Every team carries its owner.</p>`;
}

// -- Knockout bracket --------------------------------------------------------

const KNOCKOUT_ROUNDS = [
  { stage: "LAST_32", matches: R32 },
  { stage: "LAST_16", matches: R16 },
  { stage: "QUARTER_FINALS", matches: QF },
  { stage: "SEMI_FINALS", matches: SF },
  { stage: "THIRD_PLACE", matches: [THIRD], source: "loser" },
  { stage: "FINAL", matches: [FINAL], source: "winner" },
];

const KNOCKOUT_MATCH_DEFS = new Map(
  KNOCKOUT_ROUNDS.flatMap((round) => round.matches.map((match) => [match.no, match])),
);

// Canonical stage for each match number, so a column can look up how to label its routes.
const STAGE_BY_NO = new Map(
  KNOCKOUT_ROUNDS.flatMap((round) => round.matches.map((match) => [match.no, round.stage])),
);

function knockoutFixturesByNo(model) {
  const fixturesByNo = new Map();
  Object.entries(KNOCKOUT_SCHEDULE_ORDER).forEach(([stage, numbers]) => {
    const fixtures = model.matches
      .filter((match) => match.stage === stage)
      .sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate));
    numbers.forEach((no, index) => {
      if (fixtures[index]) fixturesByNo.set(no, fixtures[index]);
    });
  });
  return fixturesByNo;
}

function r32SlotLabel(slot) {
  if (slot.t === "W") return `Winner Group ${slot.g}`;
  if (slot.t === "RU") return `Runner-up Group ${slot.g}`;
  return `Third place ${slot.from.join("/")}`;
}

// One team line inside a knockout card: flag + name + owner (or the match-number route
// when the team is still unknown), with its score on the right and a (pens) marker when
// the tie went to a shootout.
function koRow(team, route, isWinner, fixture, side) {
  const body = isKnown(team)
    ? teamCell(team)
    : `<span class="ko-route">${esc(route)}</span>`;
  return `<div class="ko-row ${isWinner ? "is-win" : ""}">
      ${body}
      ${koRowScore(fixture, side)}
    </div>`;
}

function koRowScore(fixture, side) {
  if (!fixture || !hasScore(fixture.score)) return "";
  const goals = side === "home" ? fixture.score.home : fixture.score.away;
  const pen = hasPenalties(fixture) ? (side === "home" ? fixture.penalties.home : fixture.penalties.away) : null;
  return `<span class="ko-row__score">${goals}${pen !== null ? ` <i>(${pen})</i>` : ""}</span>`;
}

function fixtureTeam(fixture, def, side) {
  const feedTeam = fixture?.[side === "home" ? "homeTeam" : "awayTeam"];
  if (isKnown(feedTeam)) return feedTeam;
  return OFFICIAL_R32_TEAMS.get(def.no)?.[side] ?? "";
}

function knownFixtureTeam(fixture, side) {
  const team = fixture?.[side === "home" ? "homeTeam" : "awayTeam"];
  return isKnown(team) ? team : "";
}

function knockoutWinnerSide(fixture) {
  if (!fixture || !isFinished(fixture.status)) return "";
  if (fixture.winner === "HOME_TEAM") return "home";
  if (fixture.winner === "AWAY_TEAM") return "away";
  if (!hasScore(fixture.score)) return "";
  if (fixture.score.home > fixture.score.away) return "home";
  if (fixture.score.away > fixture.score.home) return "away";
  return "";
}

function knockoutRoute(def, stage, side, source) {
  if (stage === "LAST_32") return r32SlotLabel(side === "home" ? def.a : def.b);
  const from = def.from[side === "home" ? 0 : 1];
  return `${source === "loser" ? "Loser" : "Winner"} M${from}`;
}

function resolvedKnockoutTeam(def, stage, fixture, side, source, outcomes) {
  const feedTeam = knownFixtureTeam(fixture, side);
  if (feedTeam) return feedTeam;
  if (stage === "LAST_32") return fixtureTeam(fixture, def, side);
  const from = def.from?.[side === "home" ? 0 : 1];
  return outcomes.get(from)?.[source] ?? "";
}

function buildKnockoutOutcomes(fixturesByNo) {
  const outcomes = new Map();
  KNOCKOUT_ROUNDS.forEach((round) => {
    round.matches.forEach((def) => {
      const fixture = fixturesByNo.get(def.no);
      const home = resolvedKnockoutTeam(def, round.stage, fixture, "home", round.source ?? "winner", outcomes);
      const away = resolvedKnockoutTeam(def, round.stage, fixture, "away", round.source ?? "winner", outcomes);
      const winnerSide = knockoutWinnerSide(fixture);
      const winner = winnerSide === "home" ? home : winnerSide === "away" ? away : "";
      const loser = winnerSide === "home" ? away : winnerSide === "away" ? home : "";
      outcomes.set(def.no, { home, away, winner, loser });
    });
  });
  return outcomes;
}

// One compact knockout card: a header (match number + kick-off / live), then a team line
// each, score on the right and a (pens) marker on shootouts. Carries data-ko-no so the
// connector overlay can find it and data-match-id so the existing click delegation opens
// the drawer.
function koMatchCard(def, stage, fixture, source, ctx) {
  const r32 = stage === "LAST_32";
  const homeTeam = r32
    ? fixtureTeam(fixture, def, "home")
    : resolvedKnockoutTeam(def, stage, fixture, "home", source, ctx.outcomes);
  const awayTeam = r32
    ? fixtureTeam(fixture, def, "away")
    : resolvedKnockoutTeam(def, stage, fixture, "away", source, ctx.outcomes);
  const homeRoute = knockoutRoute(def, stage, "home", source);
  const awayRoute = knockoutRoute(def, stage, "away", source);
  const winner = knockoutWinnerSide(fixture);
  const live = fixture && isLive(fixture.status);
  const location = mapLink(fixture, "ko-card__map");
  const date = fixture?.utcDate ? `<span>${esc(dayLabel(fixture.utcDate))}</span>` : "";
  const meta = live
    ? `<span class="ko-card__live">${esc(statusLabel(fixture))}</span>`
    : location || date
      ? `<span class="ko-card__meta">${location}${date}</span>`
      : "";
  const openable = fixture?.id != null;
  return `<div class="ko-card ${openable ? "ko-card--openable" : ""}" data-ko-no="${def.no}" ${openable ? `data-match-id="${fixture.id}" role="button" tabindex="0"` : ""}>
      <div class="ko-card__head"><span>M${def.no}</span>${meta}</div>
      ${koRow(homeTeam, homeRoute, winner === "home", fixture, "home")}
      ${koRow(awayTeam, awayRoute, winner === "away", fixture, "away")}
    </div>`;
}

function koColumn(title, nos, ctx) {
  const cards = nos
    .map((no) => {
      const def = KNOCKOUT_MATCH_DEFS.get(no);
      return koMatchCard(def, ctx.stageByNo.get(no), ctx.fixturesByNo.get(no), "winner", ctx);
    })
    .join("");
  return `<div class="ko-col"><h3>${title}</h3><div class="ko-col__body">${cards}</div></div>`;
}

export function renderBracket(model) {
  const fixturesByNo = knockoutFixturesByNo(model);
  const ctx = {
    fixturesByNo,
    outcomes: buildKnockoutOutcomes(fixturesByNo),
    stageByNo: STAGE_BY_NO,
  };

  const left =
    koColumn("Round of 32", [74, 77, 73, 75, 83, 84, 81, 82], ctx) +
    koColumn("Round of 16", [89, 90, 93, 94], ctx) +
    koColumn("Quarter-finals", [97, 98], ctx) +
    koColumn("Semi-finals", [101], ctx);
  const right =
    koColumn("Semi-finals", [102], ctx) +
    koColumn("Quarter-finals", [99, 100], ctx) +
    koColumn("Round of 16", [91, 92, 95, 96], ctx) +
    koColumn("Round of 32", [76, 78, 79, 80, 86, 88, 85, 87], ctx);
  const final = koMatchCard(FINAL, "FINAL", fixturesByNo.get(FINAL.no), "winner", ctx);
  const third = koMatchCard(THIRD, "THIRD_PLACE", fixturesByNo.get(THIRD.no), "loser", ctx);

  return `
    <div class="panel__head"><h2>Knockout bracket</h2><span class="panel__hint">Official 2026 route</span></div>
    <div class="ko-board" data-ko-board>
      <svg class="ko-lines" aria-hidden="true"></svg>
      <div class="ko-half ko-half--left">${left}</div>
      <div class="ko-centre"><div class="ko-col ko-col--final"><h3>Final</h3>${final}</div></div>
      <div class="ko-half ko-half--right">${right}</div>
    </div>
    <div class="ko-third">
      <h4>Third-place play-off</h4>
      ${third}
    </div>
    <p class="panel__note">Official FIFA knockout structure. Tap a tie for detail. Finished winners are carried forward locally until the feed fills later-round team names; ties level after extra time show the penalty result.</p>`;
}

// Each match and the two it is fed by, for the connector overlay.
const KO_CONNECTIONS = [
  ...R16.map((m) => ({ child: m.no, feeders: m.from })),
  ...QF.map((m) => ({ child: m.no, feeders: m.from })),
  ...SF.map((m) => ({ child: m.no, feeders: m.from })),
  { child: FINAL.no, feeders: FINAL.from },
];

// Draws the elbow connectors as an SVG overlay measured from the rendered cards, so the
// lines track real card positions whatever their height or the viewport width. A feeder
// left of its child connects card-right to card-left; a feeder on the right (the mirrored
// half, and the final) connects the other way. Re-run after each render and on resize.
export function drawBracketConnectors() {
  const board = document.querySelector("[data-ko-board]");
  if (!board) return;
  const svg = board.querySelector(".ko-lines");
  if (!svg) return;

  const cards = new Map();
  board.querySelectorAll("[data-ko-no]").forEach((el) => cards.set(Number(el.dataset.koNo), el));

  const base = board.getBoundingClientRect();
  const ox = board.scrollLeft - base.left;
  const oy = board.scrollTop - base.top;
  const width = board.scrollWidth;
  const height = board.scrollHeight;
  svg.setAttribute("width", width);
  svg.setAttribute("height", height);
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

  const at = (n) => Math.round(n) + 0.5;
  const segments = [];
  for (const { child, feeders } of KO_CONNECTIONS) {
    const childEl = cards.get(child);
    if (!childEl) continue;
    const c = childEl.getBoundingClientRect();
    for (const feeder of feeders) {
      const feederEl = cards.get(feeder);
      if (!feederEl) continue;
      const f = feederEl.getBoundingClientRect();
      const feederOnLeft = f.right <= c.left + 1;
      const cx = at((feederOnLeft ? c.left : c.right) + ox);
      const cy = at(c.top + c.height / 2 + oy);
      const fx = at((feederOnLeft ? f.right : f.left) + ox);
      const fy = at(f.top + f.height / 2 + oy);
      const midX = at((cx + fx) / 2);
      segments.push(`M${fx} ${fy}H${midX}V${cy}H${cx}`);
    }
  }
  svg.innerHTML = `<path d="${segments.join("")}" />`;
}

// -- What-if explorer --------------------------------------------------------

export function renderWhatIf(model, scenario) {
  const pins = scenario?.pins ?? new Map();
  const remaining = model.matches
    .filter((match) => match.stage === "GROUP_STAGE" && !isFinished(match.status))
    .sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate));

  const byGroup = new Map();
  remaining.forEach((match) => {
    const key = match.group ?? "Group";
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push(match);
  });

  const groups = [...byGroup.entries()]
    .map(([group, matches]) => {
      const rows = matches
        .map((match) => {
          const pin = pins.get(String(match.id)) ?? null;
          const btn = (outcome, label, title) =>
            `<button type="button" class="pin ${pin === outcome ? "is-on" : ""}" data-pin-match="${esc(match.id)}" data-pin-outcome="${outcome}" title="${esc(title)}">${label}</button>`;
          return `<div class="wif-fx">
              <span class="wif-fx__teams">${flagFor(match.homeTeam)} ${esc(match.homeTeam)} <i>v</i> ${esc(match.awayTeam)} ${flagFor(match.awayTeam)}</span>
              <span class="wif-fx__pins">
                ${btn("home", `${flagFor(match.homeTeam)}`, `${match.homeTeam} win`)}
                ${btn("draw", "X", "Draw")}
                ${btn("away", `${flagFor(match.awayTeam)}`, `${match.awayTeam} win`)}
              </span>
            </div>`;
        })
        .join("");
      return `<section class="wif-group"><h4>${esc(group.replace("GROUP_", "Group "))}</h4>${rows}</section>`;
    })
    .join("");

  const pinned = pins.size;
  const left = `
    <div class="wif-left">
      <div class="wif-left__head">
        <h3>Pin remaining group games</h3>
        <button type="button" class="btn btn--ghost" data-action="clear-whatif" ${pinned ? "" : "disabled"}>Clear${pinned ? ` (${pinned})` : ""}</button>
      </div>
      ${groups || `<p class="panel__note">All group games are done; the knockout bracket is set.</p>`}
    </div>`;

  return `
    <div class="panel__head"><h2>What-if explorer</h2><span class="panel__hint">Pin results, watch the money move</span></div>
    <div class="wif-grid">${left}${renderWhatIfRace(model, scenario)}</div>`;
}

function renderWhatIfRace(model, scenario) {
  const baseline = scenario?.baseline ?? null;
  const result = scenario?.result ?? null;
  if (!baseline) {
    return `<div class="wif-right"><p class="panel__note">${scenario?.computing ? "Simulating the baseline…" : "Preparing the baseline…"}</p></div>`;
  }
  const current = result ?? baseline;

  const rows = model.leaderboard
    .map((entrant) => {
      const base = baseline.entrants.get(entrant.name);
      const now = current.entrants.get(entrant.name);
      return {
        name: entrant.name,
        win: now.winPct,
        winDelta: now.winPct - base.winPct,
        spoon: now.spoonPct,
        spoonDelta: now.spoonPct - base.spoonPct,
      };
    })
    .sort((a, b) => b.win - a.win);

  const deltaTag = (delta, goodWhenUp = true) => {
    if (Math.abs(delta) < 0.5) return "";
    const increased = delta > 0;
    const good = goodWhenUp ? increased : !increased;
    return `<span class="wif-d ${good ? "wif-d--good" : "wif-d--bad"}">${increased ? "▲" : "▼"}${Math.abs(Math.round(delta))}</span>`;
  };

  const body = rows
    .map(
      (row) => `<tr>
        <td class="wif-r__name">${esc(row.name)}</td>
        <td class="wif-r__num">${percent(row.win)} ${result ? deltaTag(row.winDelta, true) : ""}</td>
        <td class="wif-r__num wif-r__num--spoon">${percent(row.spoon)} ${result ? deltaTag(row.spoonDelta, false) : ""}</td>
      </tr>`,
    )
    .join("");

  const proj = current.projectedBracket;
  const champLine =
    proj && isKnown(proj.champion)
      ? `<p class="wif-champ">Projected champion: ${flagFor(proj.champion)} <strong>${esc(proj.champion)}</strong>${ownerOf(proj.champion) ? ` · ${esc(ownerOf(proj.champion))}` : ""}</p>`
      : "";

  return `<div class="wif-right">
      <div class="wif-right__head"><h3>The money race</h3>${scenario.computing ? `<span class="wif-spin">simulating…</span>` : ""}</div>
      ${champLine}
      <div class="table-wrap">
        <table class="wif-race">
          <thead><tr><th>Entrant</th><th>Win ${money(model.payouts.first)}</th><th>Spoon</th></tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>
      <p class="panel__note">${result ? "Change shown is versus the no-pin baseline." : "Pin some games on the left to see the odds move."}</p>
    </div>`;
}

// -- Fixtures ----------------------------------------------------------------

function fixtureRow(match) {
  return `<div class="fx ${isLive(match.status) ? "is-live" : ""}" data-match-id="${match.id ?? ""}" role="button" tabindex="0">
      <span class="fx__time">${statusLabel(match)}</span>
      <span class="fx__side">${teamCell(match.homeTeam)}</span>
      <span class="fx__score">${scoreCell(match)}</span>
      <span class="fx__side fx__side--away">${teamCell(match.awayTeam)}</span>
      <span class="fx__meta">${mapLink(match)}<span class="fx__tag">${match.group ? esc(match.group.replace("GROUP_", "Grp ")) : formatStage(match.stage)}</span></span>
    </div>`;
}

export function renderFixtures(model, ownerFilter = "all", view = "results") {
  const ownerOptions = ["all", ...ENTRANTS.map((entrant) => entrant.name)]
    .map(
      (name) =>
        `<option value="${esc(name)}" ${name === ownerFilter ? "selected" : ""}>${name === "all" ? "All owners" : esc(name)}</option>`,
    )
    .join("");

  const ownedByFilter = (match) =>
    ownerFilter === "all" ||
    [match.homeTeam, match.awayTeam].some((team) => ownerOf(team) === ownerFilter);
  // A result is anything kicked off: finished or in play. Everything else is upcoming.
  const isUpcoming = (match) => !isFinished(match.status) && !isLive(match.status);

  const filtered = model.matches.filter(ownedByFilter);
  const upcoming = view === "upcoming";
  const counts = {
    results: filtered.filter((match) => !isUpcoming(match)).length,
    upcoming: filtered.filter(isUpcoming).length,
  };

  // Results read newest-first so the latest result (and any live game) sits at the top
  // with no scrolling; upcoming reads soonest-first so the next kickoff is at the top.
  // Bucketing in sorted order makes the day sections fall out in the same direction.
  const byDay = new Map();
  filtered
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

  const empty = `No ${upcoming ? "upcoming fixtures" : "results yet"}${ownerFilter === "all" ? "." : " for that owner."}`;

  return `
    <div class="panel__head">
      <h2>Fixtures</h2>
      <div class="fx-controls">
        <div class="seg-group" data-control="fixture-view">${segments}</div>
        <label class="fx-filter">Owner
          <select data-control="fixture-owner">${ownerOptions}</select>
        </label>
      </div>
    </div>
    ${days || `<p class="panel__note">${empty}</p>`}`;
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
    .map((row, index) => {
      const owner = ownerOf(row.team);
      return `<tr>
          <td class="lb__rank">${index + 1}</td>
          <td class="gb__player">
            <span class="gb__flag">${flagFor(row.team)}</span>
            <span class="gb__id">
              <strong>${esc(row.player)}</strong>
              <span class="gb__team">${esc(row.team)}${owner ? ` · ${esc(owner)}` : ""}</span>
            </span>
          </td>
          <td class="${goalsClass}">${row.goals}</td>
          <td class="lb__num lb__num--muted">${row.assists}</td>
          <td class="${gaClass}">${row.points}</td>
        </tr>`;
    })
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
    <p class="panel__note">Goal involvements across the tournament. Penalties count; own goals and penalty-shootout kicks do not. Updates every few minutes.</p>`;
}

// -- Footer ------------------------------------------------------------------

export function renderFooter(model) {
  return `
    <p><strong>${money(model.payouts.pot)}</strong> pot · ${money(model.payouts.first)} winner · ${money(model.payouts.second)} runner-up · ${money(model.payouts.woodenSpoon)} wooden spoon</p>
    <p class="footer__src">Data: ${esc(model.source)}${model.lastUpdated ? ` · updated ${dateLabel(model.lastUpdated)}` : ""}. Win, runner-up and spoon odds are Monte Carlo projections, not actual results.</p>`;
}

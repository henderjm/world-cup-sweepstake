import { flagFor } from "./flags.js";
import { ENTRANTS, ownerOf } from "./data.js";
import {
  dateLabel,
  dayLabel,
  formatStage,
  isFinished,
  isLive,
  money,
  percent,
  scorePart,
  signed,
  statusLabel,
  timeLabel,
} from "./format.js";

const KNOCKOUT_ORDER = ["LAST_32", "LAST_16", "QUARTER_FINALS", "SEMI_FINALS", "THIRD_PLACE", "FINAL"];

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
        <b>${scorePart(match.score, "home")}-${scorePart(match.score, "away")}</b>
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
        <span class="chip chip--sim">Projected from ${model.forecast.iterations.toLocaleString("en-IE")} simulations</span>
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
        teamKey: "bestTeam",
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
  return `<div class="mrow ${live ? "is-live" : ""}">
      <span class="mrow__status">${statusLabel(match)}</span>
      <span class="mrow__side">${teamCell(match.homeTeam)}</span>
      <span class="mrow__score">${scorePart(match.score, "home")} <i>-</i> ${scorePart(match.score, "away")}</span>
      <span class="mrow__side mrow__side--away">${teamCell(match.awayTeam)}</span>
      <span class="mrow__tag">${match.group ? esc(match.group) : formatStage(match.stage)}</span>
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

export function renderBracket(model) {
  const byStage = new Map(KNOCKOUT_ORDER.map((stage) => [stage, []]));
  model.matches.forEach((match) => {
    if (byStage.has(match.stage)) byStage.get(match.stage).push(match);
  });

  const columns = KNOCKOUT_ORDER.filter((stage) => byStage.get(stage).length)
    .map((stage) => {
      const matches = byStage.get(stage).sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate));
      const cards = matches
        .map(
          (match) => `<div class="ko-match">
            <span class="ko-slot">${teamCell(match.homeTeam)}<b>${scorePart(match.score, "home")}</b></span>
            <span class="ko-slot">${teamCell(match.awayTeam)}<b>${scorePart(match.score, "away")}</b></span>
            <span class="ko-date">${dayLabel(match.utcDate)}</span>
          </div>`,
        )
        .join("");
      return `<div class="ko-col">
          <h3>${formatStage(stage)}</h3>
          ${cards}
        </div>`;
    })
    .join("");

  const favourites = [...model.forecast.teamTitleOdds.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(
      ([team, odds]) =>
        `<li>${flagFor(team)} <span>${esc(team)}</span> <span class="ko-fav__owner">${esc(ownerOf(team) ?? "")}</span> <b>${percent(odds)}</b></li>`,
    )
    .join("");

  return `
    <div class="panel__head"><h2>Knockout bracket</h2></div>
    <div class="ko-wrap">${columns || `<p class="panel__note">No knockout fixtures yet.</p>`}</div>
    <div class="ko-fav">
      <h3>Projected to lift the trophy</h3>
      <ul>${favourites}</ul>
      <p class="panel__note">The real 2026 pairings are not in the feed yet, so slots show TBD and fill in as teams qualify. Trophy odds come from the simulation.</p>
    </div>`;
}

// -- Fixtures ----------------------------------------------------------------

export function renderFixtures(model, ownerFilter = "all") {
  const options = ["all", ...ENTRANTS.map((entrant) => entrant.name)]
    .map(
      (name) =>
        `<option value="${esc(name)}" ${name === ownerFilter ? "selected" : ""}>${name === "all" ? "All owners" : esc(name)}</option>`,
    )
    .join("");

  const byDay = new Map();
  model.matches
    .filter((match) => {
      if (ownerFilter === "all") return true;
      return [match.homeTeam, match.awayTeam].some((team) => ownerOf(team) === ownerFilter);
    })
    .sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate))
    .forEach((match) => {
      const day = dayLabel(match.utcDate);
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(match);
    });

  const days = [...byDay.entries()]
    .map(
      ([day, matches]) => `<section class="fx-day">
        <h3>${day}</h3>
        ${matches
          .map(
            (match) => `<div class="fx ${isLive(match.status) ? "is-live" : ""}">
              <span class="fx__time">${isFinished(match.status) ? "FT" : timeLabel(match.utcDate)}</span>
              <span class="fx__side">${teamCell(match.homeTeam)}</span>
              <span class="fx__score">${scorePart(match.score, "home")}<i>-</i>${scorePart(match.score, "away")}</span>
              <span class="fx__side fx__side--away">${teamCell(match.awayTeam)}</span>
              <span class="fx__tag">${match.group ? esc(match.group.replace("GROUP_", "Grp ")) : formatStage(match.stage)}</span>
            </div>`,
          )
          .join("")}
      </section>`,
    )
    .join("");

  return `
    <div class="panel__head">
      <h2>Fixtures</h2>
      <label class="fx-filter">Owner
        <select data-control="fixture-owner">${options}</select>
      </label>
    </div>
    ${days || `<p class="panel__note">No fixtures match that filter.</p>`}`;
}

// -- Footer ------------------------------------------------------------------

export function renderFooter(model) {
  return `
    <p><strong>${money(model.payouts.pot)}</strong> pot · ${money(model.payouts.first)} winner · ${money(model.payouts.second)} runner-up · ${money(model.payouts.woodenSpoon)} wooden spoon</p>
    <p class="footer__src">Data: ${esc(model.source)}${model.lastUpdated ? ` · updated ${dateLabel(model.lastUpdated)}` : ""}. Win, runner-up and spoon odds are a Monte Carlo projection, not the real draw.</p>`;
}

import { flagFor } from "./flags.js";
import { ENTRANTS, ownerOf } from "./data.js";
import { compareByGoals, compareByInvolvements } from "./scorers.js";
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

// Score for a row. Finished/decided games show the number (0-0 included). Live games
// whose score the free feed withholds show a pulsing live marker instead of a blank.
function scoreCell(match) {
  if (hasScore(match.score)) return `${match.score.home} <i>-</i> ${match.score.away}`;
  if (isLive(match.status)) {
    return `<span class="score-pending" title="Live, score not in the free feed yet">●</span>`;
  }
  return `<i>-</i>`;
}

function tickerScore(match) {
  return hasScore(match.score) ? `${match.score.home}-${match.score.away}` : "●";
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
          <span class="chip__tip" role="tooltip">We play the rest of the tournament out ${model.forecast.iterations.toLocaleString("en-IE")} times from the current results, giving each remaining game a plausible scoreline based on team strength, then count how often each entrant's teams take each prize. A model for fun, not a prediction: strengths are estimated and the real knockout draw is not in the feed yet.</span>
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
  return `<div class="mrow ${live ? "is-live" : ""}" data-match-id="${match.id ?? ""}" role="button" tabindex="0">
      <span class="mrow__status">${statusLabel(match)}</span>
      <span class="mrow__side">${teamCell(match.homeTeam)}</span>
      <span class="mrow__score">${scoreCell(match)}</span>
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

// Date range across the feed's real fixtures for a stage, e.g. "28 Jun to 03 Jul".
function stageDateRange(model, stage) {
  const times = model.matches
    .filter((match) => match.stage === stage && match.utcDate)
    .map((match) => new Date(match.utcDate).getTime());
  if (!times.length) return "";
  const fmt = (time) =>
    new Intl.DateTimeFormat("en-IE", { day: "2-digit", month: "short" }).format(new Date(time));
  const min = Math.min(...times);
  const max = Math.max(...times);
  return min === max ? fmt(min) : `${fmt(min)} to ${fmt(max)}`;
}

// A single projected tie: the matchup with the favourite highlighted, and the win-odds
// split revealed on hover or tap.
function koMatchCard(match) {
  const homePct = Math.round((match.homeWin ?? 0.5) * 100);
  const awayPct = 100 - homePct;
  const homeWin = match.winner && match.winner === match.home;
  const awayWin = match.winner && match.winner === match.away;
  return `<div class="ko-match" data-ko-toggle tabindex="0" role="button" aria-label="${esc(match.home)} ${homePct}% to beat ${esc(match.away)} ${awayPct}%">
      <span class="ko-slot ${homeWin ? "is-win" : ""}">${teamCell(match.home)}<b class="ko-pct">${homePct}%</b></span>
      <span class="ko-slot ${awayWin ? "is-win" : ""}">${teamCell(match.away)}<b class="ko-pct">${awayPct}%</b></span>
    </div>`;
}

export function renderBracket(model) {
  const projection = model.forecast?.projectedBracket;
  const columns = (projection?.rounds ?? [])
    .filter((round) => round.matches.length)
    .map((round) => {
      const cards = round.matches.map(koMatchCard).join("");
      const when = stageDateRange(model, round.stage);
      return `<div class="ko-col">
          <h3>${formatStage(round.stage)}${when ? `<span class="ko-when">${when}</span>` : ""}</h3>
          ${cards}
        </div>`;
    })
    .join("");

  const champ =
    projection && isKnown(projection.champion)
      ? `<p class="ko-proj__champ">Projected champion: <span class="prize__flag">${flagFor(projection.champion)}</span> <strong>${esc(projection.champion)}</strong>${ownerOf(projection.champion) ? ` (${esc(ownerOf(projection.champion))})` : ""}</p>`
      : "";

  const favourites = [...model.forecast.teamTitleOdds.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(
      ([team, odds]) =>
        `<li>${flagFor(team)} <span>${esc(team)}</span> <span class="ko-fav__owner">${esc(ownerOf(team) ?? "")}</span> <b>${percent(odds)}</b></li>`,
    )
    .join("");

  return `
    <div class="panel__head"><h2>Knockout bracket</h2><span class="panel__hint">Most likely path · tap a tie for odds</span></div>
    ${champ}
    <div class="ko-wrap">${columns || `<p class="panel__note">No knockout projection yet.</p>`}</div>
    <div class="ko-fav">
      <h3>Projected to lift the trophy</h3>
      <ul>${favourites}</ul>
      <p class="panel__note">Projected group finishes are seeded into the real, fixed 2026 bracket pathways. Teams and odds are a Monte Carlo projection and sharpen as group results land.</p>
    </div>`;
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
      <span class="fx__tag">${match.group ? esc(match.group.replace("GROUP_", "Grp ")) : formatStage(match.stage)}</span>
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

const GOLDEN_BOOT_SORTS = {
  ga: { label: "Goals + assists", compare: compareByInvolvements },
  goals: { label: "Goals", compare: compareByGoals },
};

export function renderGoldenBoot(model, sortKey = "ga") {
  const sort = GOLDEN_BOOT_SORTS[sortKey] ?? GOLDEN_BOOT_SORTS.ga;
  const scorers = [...(model.scorers ?? [])].sort(sort.compare);

  const controls = Object.entries(GOLDEN_BOOT_SORTS)
    .map(
      ([key, def]) =>
        `<button class="seg ${key === sortKey ? "is-active" : ""}" data-gb-sort="${key}">${def.label}</button>`,
    )
    .join("");

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
          <td class="lb__num">${row.goals}</td>
          <td class="lb__num lb__num--muted">${row.assists}</td>
          <td class="lb__num gb__pts">${row.points}</td>
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
    <p class="footer__src">Data: ${esc(model.source)}${model.lastUpdated ? ` · updated ${dateLabel(model.lastUpdated)}` : ""}. Win, runner-up and spoon odds are a Monte Carlo projection, not the real draw.</p>`;
}

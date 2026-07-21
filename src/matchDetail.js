import { badgeFor } from "./badges.js";
import { DATA_API } from "./data.js";
import { normalizeTeamName } from "./domain.js";
import { dayLabel, formatStage, isFinished, isLive, timeLabel } from "./format.js";
import { locationForMatch } from "./locations.js";
import { banterAvailable, mountBanter, unmountBanter } from "./banter.js";

// Match detail drawer. Combines the real feed detail (scorers, lineups, subs, cards)
// with league context: where both sides sit in the table and what the result moves.

let model = null;
let root = null;
let panel = null;
let openId = null;

export function setupMatchDetail(activeModel, { drawer }) {
  model = activeModel;
  root = drawer;
  if (!root) return;
  panel = root.querySelector(".mdrawer__panel");
  root.addEventListener("click", (event) => {
    if (event.target === root || event.target.closest("[data-md-close]")) {
      close();
      return;
    }
    const tab = event.target.closest("[data-md-tab]");
    if (tab) selectTab(tab.dataset.mdTab);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !root.hidden) close();
  });
}

function selectTab(name) {
  if (!panel) return;
  panel.querySelectorAll("[data-md-tab]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.mdTab === name);
  });
  panel.querySelectorAll(".md-pane").forEach((pane) => {
    pane.hidden = pane.dataset.pane !== name;
  });
  panel.scrollTop = 0;
  // Lazily wire banter the first time its tab is opened, so an unopened drawer never
  // hits the Worker. mountBanter is a no-op if it is already mounted for this match.
  if (name === "banter") mountBanter(panel.querySelector("[data-banter]"), openId);
}

export function openMatch(match) {
  if (!root || !panel || !match) return;
  unmountBanter(); // tear down any banter from a previously opened match
  openId = match.id;
  root.hidden = false;
  requestAnimationFrame(() => root.classList.add("is-open"));
  panel.scrollTop = 0;
  panel.innerHTML = renderShell(match);
  loadDetail(match);
  loadAnalysis(match);
}

function close() {
  if (!root) return;
  unmountBanter();
  root.classList.remove("is-open");
  openId = null;
  window.setTimeout(() => {
    if (!root.classList.contains("is-open")) root.hidden = true;
  }, 220);
}

export function setMatchModel(activeModel) {
  model = activeModel;
}

async function loadDetail(match) {
  const slot = panel.querySelector("#mdEvents");
  if (!slot || match.id == null) {
    if (slot) slot.innerHTML = scheduledNote(match);
    return;
  }
  const sources = [];
  if (DATA_API) sources.push(`${DATA_API}/match/${match.id}`);
  sources.push(`./data/matches/${match.id}.json?cache=${Date.now()}`);

  for (const src of sources) {
    try {
      const response = await fetch(src, { cache: "no-store" });
      if (!response.ok) continue;
      const detail = await response.json();
      if (openId !== match.id) return; // a different match was opened meanwhile
      panel.querySelector("#mdEvents").innerHTML = renderEvents(match, detail);
      return;
    } catch {
      // try the next source
    }
  }
  if (openId === match.id && panel.querySelector("#mdEvents")) {
    panel.querySelector("#mdEvents").innerHTML = scheduledNote(match);
  }
}

// AI analysis card (Worker /analysis/:id). Purely additive: any failure, missing
// config, or a match the Worker cron has not analysed yet just leaves the section
// hidden. The Worker cron pre-generates during live play (faster in extra time and
// shootouts); this fetch only ever reads the stored copy, never triggers a
// generation.
async function loadAnalysis(match) {
  if (!DATA_API || match.id == null) return;
  if (!isLive(match.status) && !isFinished(match.status)) return;
  try {
    const response = await fetch(`${DATA_API}/analysis/${match.id}`, { cache: "no-store" });
    if (!response.ok) return;
    const analysis = await response.json();
    if (openId !== match.id) return; // a different match was opened meanwhile
    const slot = panel.querySelector("#mdAnalysis");
    if (!slot || !analysis?.match || !analysis?.context) return;
    slot.innerHTML = renderAnalysis(analysis);
    slot.open = true; // visible on arrival, collapsible out of the way
    slot.hidden = false;
  } catch {
    // analysis is a bonus; the drawer works without it
  }
}

function renderAnalysis(analysis) {
  const live = isLive(analysis.status);
  const stamp = live
    ? `as of ${analysis.minute ? `${analysis.minute}'` : "now"}`
    : "full-time read";
  return `
    <summary class="md-ai__head">
      <span class="md-ai__spark" aria-hidden="true">✦</span>
      <span class="md-ai__titles">
        <span class="md-ai__kicker">AI analysis${live ? `<i class="md-ai__livedot"></i>${analysis.minute ? `${analysis.minute}'` : "live"}` : " · full-time"}</span>
        <strong class="md-ai__headline">${esc(analysis.headline || "Match read")}</strong>
      </span>
      <span class="md-ai__chev" aria-hidden="true">▾</span>
    </summary>
    <div class="md-ai__body">
      <p>${esc(analysis.match)}</p>
      <div class="md-ai__stakes">
        <span class="md-ai__potlabel">What it means</span>
        <p>${esc(analysis.context)}</p>
      </div>
      <span class="md-ai__meta">${esc(stamp)} · written by Claude, it can slip up</span>
    </div>
  `;
}

// -- league context ------------------------------------------------------------

function standingOf(team) {
  return model.standings?.get(team) ?? null;
}

function ordinal(n) {
  const tens = n % 100;
  const ones = n % 10;
  const suffix = tens >= 11 && tens <= 13 ? "th" : ones === 1 ? "st" : ones === 2 ? "nd" : ones === 3 ? "rd" : "th";
  return `${n}${suffix}`;
}

function teamForm(team) {
  return model.matches
    .filter((m) => isFinished(m.status) && Number.isFinite(m.score?.home) && [m.homeTeam, m.awayTeam].includes(team))
    .sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate))
    .slice(-5)
    .map((m) => {
      const home = m.homeTeam === team;
      const gf = home ? m.score.home : m.score.away;
      const ga = home ? m.score.away : m.score.home;
      const opp = home ? m.awayTeam : m.homeTeam;
      const r = gf > ga ? "W" : gf < ga ? "L" : "D";
      return { r, title: `${r} ${gf}-${ga} v ${opp}` };
    });
}

// -- shell (instant, no fetch) -----------------------------------------------

function renderShell(match) {
  const live = isLive(match.status);
  const finished = isFinished(match.status);
  const decided = Number.isFinite(match.score?.home) && Number.isFinite(match.score?.away);
  // Prefer the feed's winner so a level tie decided on penalties highlights the side that
  // actually went through, not a draw.
  const winner = decided
    ? match.winner === "HOME_TEAM"
      ? "home"
      : match.winner === "AWAY_TEAM"
        ? "away"
        : match.score.home > match.score.away
          ? "home"
          : match.score.away > match.score.home
            ? "away"
            : "draw"
    : null;

  const statusPill = live
    ? `<span class="md-pill md-pill--live"><span class="md-dot"></span>Live${match.minute ? ` ${match.minute}'` : ""}</span>`
    : finished
      ? `<span class="md-pill md-pill--fin">Result</span>`
      : `<span class="md-pill md-pill--up">Upcoming</span>`;

  const pens = Number.isFinite(match.penalties?.home) && Number.isFinite(match.penalties?.away);
  const fullTimeSub = pens ? `Penalties ${match.penalties.home}-${match.penalties.away}` : "Full time";
  const centre = !decided
    ? `<span class="md-vs">vs</span><span class="md-sub">${match.status === "TIMED" ? timeLabel(match.utcDate) : ""}</span>`
    : `<span class="md-score">${match.score.home} <i>-</i> ${match.score.away}</span><span class="md-sub">${live ? `${match.minute ? `${match.minute}'` : "Live"}` : fullTimeSub}</span>`;

  return `
    <div class="md-top">
      <header class="md-bar">
        <div class="md-where">
          <strong>${esc(contextLabel(match))}</strong>
          <span>${esc(dayLabel(match.utcDate))} · ${esc(timeLabel(match.utcDate))}</span>
        </div>
        <div class="md-bar__right">${statusPill}<button class="md-close" data-md-close aria-label="Close">✕</button></div>
      </header>
      <div class="md-tabs" role="tablist">
        <button class="md-tab is-active" data-md-tab="match" type="button">Match</button>
        <button class="md-tab" data-md-tab="table" type="button">Table</button>
        ${banterAvailable() ? `<button class="md-tab" data-md-tab="banter" type="button">Banter</button>` : ""}
      </div>
    </div>

    <div class="md-scoreline">${centre}</div>
    ${locationCard(match)}

    <div class="md-pane" data-pane="table" hidden>
      <div class="md-duel">
        ${sideCard("home", match, winner)}
        ${sideCard("away", match, winner)}
      </div>
      ${leagueTable(match)}
    </div>

    <div class="md-pane" data-pane="match">
      <details class="md-ai" id="mdAnalysis" hidden></details>
      <section class="md-events" id="mdEvents">
        <div class="md-loading">Loading match detail…</div>
      </section>
    </div>

    ${banterAvailable() ? `<div class="md-pane" data-pane="banter" hidden><div class="md-banter" data-banter></div></div>` : ""}
  `;
}

function sideCard(side, match, winner) {
  const team = side === "home" ? match.homeTeam : match.awayTeam;
  const standing = standingOf(team);
  const won = winner === side;
  const lost = winner && winner !== "draw" && winner !== side;
  const pills = teamForm(team)
    .map((f) => `<span class="md-form md-form--${f.r}" title="${esc(f.title)}">${f.r}</span>`)
    .join("");
  const positionLine = standing
    ? `${ordinal(standing.position)} · ${standing.points} pts${standing.zone ? ` · ${esc(standing.zone.label)}` : ""}`
    : "No table position yet";

  return `<article class="md-side ${won ? "is-won" : ""} ${lost ? "is-lost" : ""} md-side--${side}">
      <div class="md-team">
        <span class="md-flag">${badgeFor(team)}</span>
        <div><strong>${esc(team)}</strong><span class="md-odds">${esc(positionLine)}</span></div>
      </div>
      <div class="md-formpills">${pills || `<span class="md-form md-form--D" title="Yet to play">–</span>`}</div>
    </article>`;
}

function leagueTable(match) {
  const table = model.tables?.find((t) =>
    t.rows.some((row) => row.team === match.homeTeam || row.team === match.awayTeam),
  );
  if (!table) return "";
  const rows = table.rows
    .map((row) => {
      const here = row.team === match.homeTeam || row.team === match.awayTeam;
      return `<tr class="${row.zone ? `grp--${row.zone.tone}` : ""} ${here ? "is-here" : ""}">
          <td class="grp__pos">${row.position}</td>
          <td class="grp__team"><span class="team"><span class="team__flag">${badgeFor(row.team)}</span><span class="team__name">${esc(row.team)}</span></span></td>
          <td>${row.played}</td>
          <td>${row.goalDifference > 0 ? "+" : ""}${row.goalDifference}</td>
          <td class="grp__pts">${row.points}</td>
        </tr>`;
    })
    .join("");
  return `<section class="md-group">
      <h3>${esc(table.name)}</h3>
      <table class="grp md-grouptable"><thead><tr><th></th><th>Team</th><th>P</th><th>GD</th><th>Pts</th></tr></thead><tbody>${rows}</tbody></table>
    </section>`;
}

// -- events (after fetch) ----------------------------------------------------

function renderEvents(match, detail) {
  const sideOf = (teamName) => (normalizeTeamName(teamName) === match.homeTeam ? "home" : "away");
  const meta = renderMatchMeta(match, detail);

  const goals = (detail.goals ?? [])
    .map((g) => {
      const own = g.type === "OWN" ? " (OG)" : g.type === "PENALTY" ? " (pen)" : "";
      return `<li class="md-ev md-ev--${sideOf(g.team)}">
          <span class="md-ev__min">${g.minute}'</span>
          <span class="md-ev__icon">⚽</span>
          <span class="md-ev__txt"><strong>${esc(g.scorer)}${own}</strong>${g.assist ? `<span> · assist ${esc(g.assist)}</span>` : ""}</span>
          <span class="md-ev__score">${g.home}-${g.away}</span>
        </li>`;
    })
    .join("");

  const cards = (detail.cards ?? [])
    .map(
      (c) => `<li class="md-ev md-ev--${sideOf(c.team)}">
        <span class="md-ev__min">${c.minute}'</span>
        <span class="md-ev__icon">${c.card === "RED" ? "🟥" : "🟨"}</span>
        <span class="md-ev__txt">${esc(c.player)}</span>
      </li>`,
    )
    .join("");

  const subs = (detail.subs ?? [])
    .map(
      (s) => `<li class="md-ev md-ev--${sideOf(s.team)}">
        <span class="md-ev__min">${s.minute}'</span>
        <span class="md-ev__icon">🔁</span>
        <span class="md-ev__txt"><span class="md-in">▲ ${esc(s.in)}</span><span class="md-out">▼ ${esc(s.out)}</span></span>
      </li>`,
    )
    .join("");

  const xi = (team) => {
    if (!team?.lineup?.length) return `<p class="md-note">Line-up not announced yet (usually about an hour before kick-off).</p>`;
    const starters = team.lineup
      .map((p) => `<li><span class="md-num">${p.num ?? ""}</span>${esc(p.name)}<span class="md-pos">${esc(shortPos(p.pos))}</span></li>`)
      .join("");
    const bench = (team.bench ?? []).map((p) => esc(p.name)).join(", ");
    return `<div class="md-xi">
        <div class="md-xi__head">${badgeFor(normalizeTeamName(team.name))} <strong>${esc(team.name)}</strong> ${team.formation ? `<span class="md-form-tag">${esc(team.formation)}</span>` : ""}${team.coach ? `<span class="md-coach">${esc(team.coach)}</span>` : ""}</div>
        <ol class="md-players">${starters}</ol>
        ${bench ? `<p class="md-bench"><span>Bench</span> ${bench}</p>` : ""}
      </div>`;
  };

  const hasAny = goals || cards || subs || detail.home?.lineup?.length;
  if (!hasAny) return `${meta}${scheduledNote(match)}`;

  const block = (title, body) => (body ? `<div class="md-evblock"><h3>${title}</h3><ul class="md-evlist">${body}</ul></div>` : "");

  return `
    ${meta}
    ${block("Goals", goals)}
    ${block("Substitutions", subs)}
    ${block("Cards", cards)}
    <div class="md-evblock">
      <h3>Line-ups</h3>
      ${xi(detail.home)}
      ${xi(detail.away)}
    </div>
    <p class="md-note md-note--src">Lineups, scorers, substitutions and cards from football-data.org.</p>
  `;
}

function renderMatchMeta(match, detail) {
  const detailLocation = locationForMatch(detail);
  const items = [
    detailLocation?.city && !match.city
      ? `<a href="${esc(detailLocation.mapUrl)}" target="_blank" rel="noopener noreferrer" data-map-link><b>City</b>${esc(detailLocation.city)}</a>`
      : "",
    detail.venue ? `<span><b>Stadium</b>${esc(detail.venue)}</span>` : "",
    detail.attendance ? `<span><b>Attendance</b>${Number(detail.attendance).toLocaleString("en-IE")}</span>` : "",
    detail.referee ? `<span><b>Referee</b>${esc(detail.referee)}</span>` : "",
  ].filter(Boolean);
  return items.length ? `<div class="md-venue">${items.join("")}</div>` : "";
}

function locationCard(match) {
  const location = locationForMatch(match);
  if (!location?.city || !location.mapUrl) return "";
  const venue = location.venue ? `<span class="md-location__venue">${esc(location.venue)}</span>` : "";
  return `<a class="md-location" href="${esc(location.mapUrl)}" target="_blank" rel="noopener noreferrer" data-map-link>
      <span class="md-location__kicker">Maps</span>
      <strong>${esc(location.city)}</strong>
      ${venue}
    </a>`;
}

function scheduledNote(match) {
  if (isFinished(match.status)) return `<p class="md-note">Match detail is loading on the next data refresh.</p>`;
  return `<p class="md-note">Line-ups and events appear once the feed publishes them, usually about an hour before kick-off.</p>`;
}

// -- small helpers -----------------------------------------------------------

function contextLabel(match) {
  if (match.group) return match.group.replace("GROUP_", "Group ");
  if (Number.isFinite(match.matchday)) return `Matchday ${match.matchday}`;
  return formatStage(match.stage) || "Fixture";
}

function shortPos(pos) {
  if (!pos) return "";
  const map = { Goalkeeper: "GK", Defence: "DF", Midfield: "MF", Offence: "FW", Attacker: "FW", Defender: "DF", Midfielder: "MF" };
  return map[pos] ?? pos.slice(0, 3).toUpperCase();
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);
}

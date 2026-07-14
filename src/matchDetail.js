import { flagFor } from "./flags.js";
import { DATA_API, ENTRANTS, ownerOf } from "./data.js";
import { buildLeaderboard, buildTeamPerformance, normalizeTeamName } from "./domain.js";
import { dayLabel, formatStage, isFinished, isLive, timeLabel } from "./format.js";
import { locationForMatch } from "./locations.js";
import { banterAvailable, mountBanter, unmountBanter } from "./banter.js";

// Match detail drawer. Combines the real feed detail (scorers, lineups, subs, cards)
// with the Goon Squad framing from the Match Centre design: every fixture is a duel
// between two owners, and the panel spells out what the result does to the pot.

let model = null;
let root = null;
let panel = null;
let openId = null;

const ENTRANT_INDEX = new Map(ENTRANTS.map((entrant, index) => [entrant.name, index]));
const AVATARS = ["#2dd4a7", "#f5c84b", "#7aa2ff", "#ff8d6b", "#c08bff", "#4fd1c5", "#ffd166", "#e879a6"];

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
// hidden. The Worker pre-generates on a 10-minute cron during live play; this fetch
// only ever reads the stored copy, never triggers a generation.
async function loadAnalysis(match) {
  if (!DATA_API || match.id == null) return;
  if (!isLive(match.status) && !isFinished(match.status)) return;
  try {
    const response = await fetch(`${DATA_API}/analysis/${match.id}`, { cache: "no-store" });
    if (!response.ok) return;
    const analysis = await response.json();
    if (openId !== match.id) return; // a different match was opened meanwhile
    const slot = panel.querySelector("#mdAnalysis");
    if (!slot || !analysis?.match || !analysis?.sweepstake) return;
    slot.innerHTML = renderAnalysis(analysis);
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
    <span class="md-ai__kicker">✦ AI analysis</span>
    ${analysis.headline ? `<strong class="md-ai__headline">${esc(analysis.headline)}</strong>` : ""}
    <p>${esc(analysis.match)}</p>
    <p class="md-ai__stakes">${esc(analysis.sweepstake)}</p>
    <span class="md-ai__meta">${esc(stamp)} · AI-generated, it can slip up</span>
  `;
}

// -- sweepstake context ------------------------------------------------------

function leaderboardFrom(matches) {
  return buildLeaderboard(ENTRANTS, buildTeamPerformance(matches));
}

function rankOf(leaderboard, owner) {
  return leaderboard.find((row) => row.name === owner)?.rank ?? leaderboard.length;
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

function avatarColor(owner) {
  return AVATARS[(ENTRANT_INDEX.get(owner) ?? 0) % AVATARS.length];
}

function initials(name) {
  return (name ?? "?").slice(0, 2).toUpperCase();
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

  const now = leaderboardFrom(model.matches);
  const stake = stakeBuilder(match, live, finished, winner, now);

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
          <strong>${esc(groupName(match.group) || formatStage(match.stage))}</strong>
          <span>${esc(dayLabel(match.utcDate))} · ${esc(timeLabel(match.utcDate))}</span>
        </div>
        <div class="md-bar__right">${statusPill}<button class="md-close" data-md-close aria-label="Close">✕</button></div>
      </header>
      <div class="md-tabs" role="tablist">
        <button class="md-tab is-active" data-md-tab="match" type="button">Match</button>
        <button class="md-tab" data-md-tab="race" type="button">Race</button>
        ${banterAvailable() ? `<button class="md-tab" data-md-tab="banter" type="button">Banter</button>` : ""}
      </div>
    </div>

    <div class="md-scoreline">${centre}</div>
    ${locationCard(match)}

    <div class="md-pane" data-pane="race" hidden>
      <div class="md-duel">
        ${sideCard("home", match, winner, stake)}
        ${sideCard("away", match, winner, stake)}
      </div>
      <p class="md-story">${esc(storyline(match, live, finished, winner))}</p>
      <div class="md-facts">${facts(match, live, finished, winner, now).map(factCard).join("")}</div>
      ${groupTable(match)}
    </div>

    <div class="md-pane" data-pane="match">
      <section class="md-ai" id="mdAnalysis" hidden></section>
      <section class="md-events" id="mdEvents">
        <div class="md-loading">Loading match detail…</div>
      </section>
    </div>

    ${banterAvailable() ? `<div class="md-pane" data-pane="banter" hidden><div class="md-banter" data-banter></div></div>` : ""}
  `;
}

function stakeBuilder(match, live, finished, winner, now) {
  return (side) => {
    const team = side === "home" ? match.homeTeam : match.awayTeam;
    const owner = ownerOf(team);
    if (!owner) return { rank: "", line: "", tone: "flat" };
    const rNow = rankOf(now, owner);

    if (finished && winner) {
      const without = model.matches.filter((m) => m.id !== match.id);
      const before = leaderboardFrom(without);
      const rBefore = rankOf(before, owner);
      const pts = winner === "draw" ? 1 : winner === side ? 3 : 0;
      const move = rBefore - rNow;
      const moveTxt = move > 0 ? `▲ up ${move} to ${ordinal(rNow)}` : move < 0 ? `▼ down ${-move} to ${ordinal(rNow)}` : `held ${ordinal(rNow)}`;
      return { rank: `${ordinal(rNow)} in the pot`, line: `+${pts * 10} pts · ${moveTxt}`, tone: move > 0 ? "good" : move < 0 ? "bad" : "flat" };
    }
    if (live && winner) {
      const ifNow = leaderboardFrom(model.matches.map((m) => (m.id === match.id ? { ...m, status: "FINISHED" } : m)));
      const rIf = rankOf(ifNow, owner);
      const pts = winner === "draw" ? 1 : winner === side ? 3 : 0;
      return { rank: `${ordinal(rNow)} now`, line: `If it ends here: +${pts * 10} pts → ${ordinal(rIf)}`, tone: rIf < rNow ? "good" : rIf > rNow ? "bad" : "flat" };
    }
    const win = leaderboardFrom(scored(match, side === "home" ? [1, 0] : [0, 1]));
    const lose = leaderboardFrom(scored(match, side === "home" ? [0, 1] : [1, 0]));
    return { rank: `${ordinal(rNow)} in the pot`, line: `Win → ${ordinal(rankOf(win, owner))} · Lose → ${ordinal(rankOf(lose, owner))}`, tone: "flat" };
  };
}

function scored(match, [home, away]) {
  return model.matches.map((m) => (m.id === match.id ? { ...m, status: "FINISHED", score: { home, away } } : m));
}

function sideCard(side, match, winner, stake) {
  const team = side === "home" ? match.homeTeam : match.awayTeam;
  const owner = ownerOf(team);
  const titleOdds = model.forecast?.teamTitleOdds?.get(team) ?? 0;
  const won = winner === side;
  const lost = winner && winner !== "draw" && winner !== side;
  const s = stake(side);
  const others = owner
    ? (ENTRANTS[ENTRANT_INDEX.get(owner)]?.teams ?? [])
        .map(normalizeTeamName)
        .filter((t) => t !== team)
        .map((t) => `<span class="md-other">${flagFor(t)} ${esc(t)}</span>`)
        .join("")
    : "";
  const pills = teamForm(team)
    .map((f) => `<span class="md-form md-form--${f.r}" title="${esc(f.title)}">${f.r}</span>`)
    .join("");

  return `<article class="md-side ${won ? "is-won" : ""} ${lost ? "is-lost" : ""} md-side--${side}">
      <div class="md-team">
        <span class="md-flag">${flagFor(team)}</span>
        <div><strong>${esc(team)}</strong><span class="md-odds">${titleOdds >= 0.1 ? `${Math.round(titleOdds)}% to win it` : "outsider"}</span></div>
      </div>
      <div class="md-formpills">${pills || `<span class="md-form md-form--D" title="Yet to play">–</span>`}</div>
      ${
        owner
          ? `<div class="md-owner">
              <span class="md-avatar" style="background:${avatarColor(owner)}">${esc(initials(owner))}</span>
              <div><strong>${esc(owner)}</strong><span>${esc(s.rank)}</span></div>
            </div>
            <div class="md-stake md-stake--${s.tone}">${esc(s.line)}</div>
            ${others ? `<div class="md-others"><span>also holds</span>${others}</div>` : ""}`
          : `<div class="md-owner md-owner--none">Unowned</div>`
      }
    </article>`;
}

function storyline(match, live, finished, winner) {
  const h = match.homeTeam;
  const a = match.awayTeam;
  const ho = ownerOf(h);
  const ao = ownerOf(a);
  const grp = groupName(match.group) || formatStage(match.stage);
  if (finished && winner === "draw") return `${h} and ${a} share the spoils, and ${ho} and ${ao} take a point each in the pot.`;
  if (finished && winner) {
    const wt = winner === "home" ? h : a;
    const wo = winner === "home" ? ho : ao;
    return `${wt} take it ${match.score.home}-${match.score.away}. A good day for ${wo} in the Squad standings.`;
  }
  if (live && winner === "draw") return `All square at ${match.score.home}-${match.score.away}, ${ho} and ${ao} both sweating it out.`;
  if (live && winner) {
    const lt = winner === "home" ? h : a;
    const lo = winner === "home" ? ho : ao;
    return `${match.homeTeam} ${match.score.home}-${match.score.away} ${match.awayTeam} and ${lo}'s ${lt} are ahead with everything to play for.`;
  }
  return `${h} (${ho}) meet ${a} (${ao}) in ${grp}. Bragging rights and a 10-point swing on the line.`;
}

function facts(match, live, finished, winner, now) {
  const out = [];
  const h = match.homeTeam;
  const a = match.awayTeam;
  if (finished && winner) {
    const gd = match.score.home - match.score.away;
    out.push({ label: "On the day", value: `${match.score.home}-${match.score.away}`, sub: winner === "draw" ? "honours even" : `${winner === "home" ? h : a} win`, tone: "" });
    const wo = winner === "draw" ? ownerOf(h) : ownerOf(winner === "home" ? h : a);
    out.push({ label: "Sweepstake call", value: winner === "draw" ? "Split" : `${ownerName(wo)}`, sub: winner === "draw" ? "a point each" : `${ordinal(rankOf(now, wo))} in the pot`, tone: "accent" });
    out.push({ label: "Goal diff swing", value: `${gd > 0 ? "+" : ""}${gd}`, sub: "for the winners", tone: "" });
  } else if (live && winner) {
    out.push({ label: "Clock", value: match.minute ? `${match.minute}'` : "Live", sub: "in play", tone: "live" });
    out.push({ label: "As it stands", value: winner === "draw" ? "Level" : `${winner === "home" ? h : a} ahead`, sub: `${match.score.home}-${match.score.away}`, tone: "" });
    const lo = winner === "draw" ? null : ownerOf(winner === "home" ? h : a);
    out.push({ label: "Pot watch", value: lo ? ownerName(lo) : "No change", sub: lo ? "gaining ground" : "level game", tone: "accent" });
  } else {
    out.push({ label: "Kick-off", value: timeLabel(match.utcDate), sub: dayLabel(match.utcDate), tone: "" });
    out.push({ label: "On the line", value: "10 pts", sub: "win vs lose", tone: "accent" });
    out.push({ label: "Group", value: (groupName(match.group) || formatStage(match.stage)).replace("Group ", "Grp "), sub: "could change hands", tone: "" });
  }
  return out;
}

function factCard(f) {
  return `<div class="md-fact"><span class="md-fact__label">${esc(f.label)}</span><strong class="md-fact__value md-fact__value--${f.tone}">${esc(f.value)}</strong><span class="md-fact__sub">${esc(f.sub)}</span></div>`;
}

function groupTable(match) {
  const table = model.groupTables.find((g) => g.name === groupName(match.group));
  if (!table) return "";
  const rows = table.rows
    .map((row) => {
      const here = row.team === match.homeTeam || row.team === match.awayTeam;
      return `<tr class="grp--${row.dangerLevel} ${here ? "is-here" : ""}">
          <td class="grp__pos">${row.position}</td>
          <td class="grp__team"><span class="team"><span class="team__flag">${flagFor(row.team)}</span><span class="team__name">${esc(row.team)}</span><span class="team__owner">${esc(ownerOf(row.team) ?? "")}</span></span></td>
          <td>${row.played}</td>
          <td>${row.goalDifference > 0 ? "+" : ""}${row.goalDifference}</td>
          <td class="grp__pts">${row.points}</td>
        </tr>`;
    })
    .join("");
  return `<section class="md-group">
      <h3>${esc(table.name)} table</h3>
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
        <div class="md-xi__head">${flagFor(normalizeTeamName(team.name))} <strong>${esc(team.name)}</strong> ${team.formation ? `<span class="md-form-tag">${esc(team.formation)}</span>` : ""}${team.coach ? `<span class="md-coach">${esc(team.coach)}</span>` : ""}</div>
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

function groupName(group) {
  if (!group) return "";
  return group.replace("GROUP_", "Group ");
}

function ownerName(owner) {
  return owner ?? "Unowned";
}

function shortPos(pos) {
  if (!pos) return "";
  const map = { Goalkeeper: "GK", Defence: "DF", Midfield: "MF", Offence: "FW", Attacker: "FW", Defender: "DF", Midfielder: "MF" };
  return map[pos] ?? pos.slice(0, 3).toUpperCase();
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);
}

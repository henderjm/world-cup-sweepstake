import { abbrFor, badgeFor } from "./badges.js";
import { DATA_API } from "./data.js";
import { normalizeTeamName } from "./domain.js";
import { dayLabel, formatStage, isFinished, isLive, timeLabel } from "./format.js";
import { banterAvailable, mountBanter, unmountBanter } from "./banter.js";

// Match drawer, Squad Goals style: a right slide-in with the score up top, then a
// single scroll of AI analysis, timeline (goals, cards, subs merged in match order),
// line-ups, and the shared banter feed. Detail (events, lineups) loads on open from
// the Worker with a static fallback; everything degrades to a note, never an error.

let model = null;
let root = null;
let panel = null;
let openId = null;

export function setupMatchDetail(activeModel, { drawer }) {
  model = activeModel;
  root = drawer;
  if (!root) return;
  panel = root.querySelector(".dz__panel");
  root.addEventListener("click", (event) => {
    if (event.target.closest("[data-md-close]")) close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !root.hidden) close();
  });
}

export function setMatchModel(activeModel) {
  model = activeModel;
}

export function openMatch(match) {
  if (!root || !panel || !match) return;
  unmountBanter(); // tear down any banter from a previously opened match
  openId = match.id;
  root.hidden = false;
  panel.scrollTop = 0;
  panel.innerHTML = renderShell(match);
  if (banterAvailable()) mountBanter(panel.querySelector("[data-banter]"), openId);
  loadDetail(match);
  loadAnalysis(match);
}

function close() {
  if (!root) return;
  unmountBanter();
  openId = null;
  root.hidden = true;
}

async function loadDetail(match) {
  const slot = panel.querySelector("#mdBody");
  if (!slot || match.id == null) {
    if (slot) slot.innerHTML = scheduledNote(match);
    return;
  }
  const sources = [];
  if (DATA_API) sources.push(`${DATA_API}/match/${match.id}`);
  sources.push(
    `./data/${encodeURIComponent(model.competition.code)}/matches/${match.id}.json?cache=${Date.now()}`,
  );

  for (const src of sources) {
    try {
      const response = await fetch(src, { cache: "no-store" });
      if (!response.ok) continue;
      const detail = await response.json();
      if (openId !== match.id) return; // a different match was opened meanwhile
      panel.querySelector("#mdBody").innerHTML = renderDetail(match, detail);
      return;
    } catch {
      // try the next source
    }
  }
  if (openId === match.id && panel.querySelector("#mdBody")) {
    panel.querySelector("#mdBody").innerHTML = scheduledNote(match);
  }
}

// AI analysis card (Worker /analysis/:id). Purely additive: any failure, missing
// config, or a match the Worker cron has not analysed yet just leaves the section
// hidden. This fetch only ever reads the stored copy, never triggers a generation.
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
    const live = isLive(analysis.status);
    const stamp = live
      ? `as of ${analysis.minute ? `${analysis.minute}'` : "now"}`
      : "full-time read";
    slot.innerHTML = `
      <p>Match analysis${live ? " · live" : ""}</p>
      ${analysis.headline ? `<p class="dz__aihead">${esc(analysis.headline)}</p>` : ""}
      <p>${esc(analysis.match)} ${esc(analysis.context)}</p>
      <p class="dz__aimeta">${esc(stamp)} · written by Claude, it can slip up</p>`;
    slot.hidden = false;
  } catch {
    // analysis is a bonus; the drawer works without it
  }
}

// -- shell (instant, no fetch) --------------------------------------------------

function renderShell(match) {
  const live = isLive(match.status);
  const finished = isFinished(match.status);
  const decided = Number.isFinite(match.score?.home) && Number.isFinite(match.score?.away);
  const pens = Number.isFinite(match.penalties?.home) && Number.isFinite(match.penalties?.away);

  const pill = live
    ? `<span class="dz__pill dz__pill--live">${esc(match.minute ? `${match.minute}'` : "Live")}</span>`
    : finished
      ? `<span class="dz__pill">${pens ? `FT · pens ${match.penalties.home}–${match.penalties.away}` : "Full time"}</span>`
      : `<span class="dz__pill">${esc(dayLabel(match.utcDate))} ${esc(timeLabel(match.utcDate))}</span>`;

  return `
    <div class="dz__bar">
      <span class="dz__tag">${contextLabel(match)}${match.utcDate ? ` · ${esc(dayLabel(match.utcDate))}` : ""}</span>
      <button class="dz__close" type="button" data-md-close aria-label="Close">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>
      </button>
    </div>
    <div class="dz__score">
      <div class="dz__team">${badgeFor(match.homeTeam, "xl")}<p>${esc(match.homeTeam)}</p></div>
      <div>
        <p class="dz__num">${decided ? `${match.score.home} – ${match.score.away}` : "v"}</p>
        ${pill}
      </div>
      <div class="dz__team">${badgeFor(match.awayTeam, "xl")}<p>${esc(match.awayTeam)}</p></div>
    </div>
    ${match.venue ? `<p class="dz__venue">${esc(match.venue)}</p>` : ""}
    <div class="dz__ai" id="mdAnalysis" hidden></div>
    <div id="mdBody"><p class="dz__loading">Loading match detail…</p></div>
    ${banterAvailable() ? `<h4>Banter</h4><div data-banter></div>` : ""}
  `;
}

// -- detail (after fetch) ---------------------------------------------------------

function renderDetail(match, detail) {
  const sideAbbr = (teamName) =>
    abbrFor(normalizeTeamName(teamName) === match.homeTeam ? match.homeTeam : match.awayTeam);

  const events = [
    ...(detail.goals ?? []).map((g) => ({
      minute: g.minute,
      mark: "goal",
      text: `${g.scorer}${g.type === "OWN" ? " (OG)" : g.type === "PENALTY" ? " (pen)" : ""}`,
      kind: `Goal${g.assist ? ` · assist ${g.assist}` : ""}${Number.isFinite(g.home) ? ` · ${g.home}–${g.away}` : ""}`,
      side: sideAbbr(g.team),
    })),
    ...(detail.cards ?? []).map((c) => ({
      minute: c.minute,
      mark: c.card === "RED" ? "red" : "yellow",
      text: c.player,
      kind: c.card === "RED" ? "Red card" : "Yellow card",
      side: sideAbbr(c.team),
    })),
    ...(detail.subs ?? []).map((s) => ({
      minute: s.minute,
      mark: "sub",
      text: s.in,
      kind: `on for ${s.out}`,
      side: sideAbbr(s.team),
    })),
  ].sort((a, b) => (a.minute ?? 0) - (b.minute ?? 0));

  const timeline = events.length
    ? `<h4>Timeline</h4>${events
        .map(
          (e) => `<div class="ev">
            <span class="ev__mn">${Number.isFinite(e.minute) ? `${e.minute}'` : ""}</span>
            <span class="ev__mark ev__mark--${e.mark}"></span>
            <span class="ev__txt">${esc(e.text)} <span class="ev__kind">${esc(e.kind)}</span></span>
            <span class="ev__side">${esc(e.side)}</span>
          </div>`,
        )
        .join("")}`
    : "";

  const xi = (team) => {
    if (!team?.lineup?.length) return "";
    const starters = team.lineup
      .map((p) => `<li><span class="xi__num">${p.num ?? ""}</span>${esc(p.name)}<span class="xi__pos">${esc(shortPos(p.pos))}</span></li>`)
      .join("");
    const bench = (team.bench ?? []).map((p) => esc(p.name)).join(", ");
    return `<div class="xi">
        <div class="xi__head">${badgeFor(normalizeTeamName(team.name))}<span>${esc(team.name)}</span>
          ${team.formation ? `<span class="xi__formation">${esc(team.formation)}</span>` : ""}
          ${team.coach ? `<span class="xi__coach">${esc(team.coach)}</span>` : ""}
        </div>
        <ol class="xi__players">${starters}</ol>
        ${bench ? `<p class="xi__bench"><span>Bench</span>${bench}</p>` : ""}
      </div>`;
  };
  const lineups = detail.home?.lineup?.length || detail.away?.lineup?.length
    ? `<h4>Line-ups</h4>${xi(detail.home)}${xi(detail.away)}`
    : "";

  const meta = [
    detail.venue ? `<span><b>Stadium</b>${esc(detail.venue)}</span>` : "",
    detail.attendance ? `<span><b>Attendance</b>${Number(detail.attendance).toLocaleString("en-IE")}</span>` : "",
    detail.referee ? `<span><b>Referee</b>${esc(detail.referee)}</span>` : "",
  ].filter(Boolean);

  if (!timeline && !lineups) return scheduledNote(match);

  return `
    ${timeline}
    ${lineups}
    ${meta.length ? `<div class="dz__meta">${meta.join("")}</div>` : ""}
    <p class="note--dim" style="margin-top:14px;">Lineups, scorers, substitutions and cards from football-data.org.</p>`;
}

function scheduledNote(match) {
  if (isFinished(match.status)) return `<p class="dz__loading">Match detail is loading on the next data refresh.</p>`;
  return `<p class="dz__loading">Line-ups and events appear once the feed publishes them, usually about an hour before kick-off.</p>`;
}

// -- small helpers ------------------------------------------------------------------

function contextLabel(match) {
  if (match.group) return esc(match.group.replace("GROUP_", "Group "));
  if (Number.isFinite(match.matchday)) return `Matchday ${match.matchday}`;
  return esc(formatStage(match.stage) || "Fixture");
}

function shortPos(pos) {
  if (!pos) return "";
  const map = { Goalkeeper: "GK", Defence: "DF", Midfield: "MF", Offence: "FW", Attacker: "FW", Defender: "DF", Midfielder: "MF" };
  return map[pos] ?? pos.slice(0, 3).toUpperCase();
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);
}

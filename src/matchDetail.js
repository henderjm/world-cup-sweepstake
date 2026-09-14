import { abbrFor, badgeFor } from "./badges.js";
import { DATA_API } from "./data.js";
import { displayTeamName, normalizeTeamName } from "./domain.js";
import { byPosition, dayLabel, formatStage, isFinished, isLive, statusLabel, timeLabel } from "./format.js";
import { banterAvailable, mountBanter, unmountBanter } from "./banter.js";
import { detailSubstanceScore, DETAIL_SECTION_COUNT, fillDetailSections } from "./matchDetailSubstance.js";

let model = null;
let root = null;
let panel = null;
let openId = null;
let request = null;
let lastDetail = null;
let opener = null;
let bodyOverflow = "";
let followButton = () => "";
let followNotice = () => "";

export function setupMatchDetail(activeModel, options) {
  const { drawer } = options;
  followButton = options.followButton ?? (() => "");
  followNotice = options.followNotice ?? (() => "");
  model = activeModel;
  root = drawer;
  if (!root) return;
  panel = root.querySelector(".dz__panel");
  root.addEventListener("click", (event) => {
    if (event.target.closest("[data-md-close]")) close();
    if (event.target.closest("[data-md-retry]")) refreshOpenMatch();
    const section = event.target.closest("[data-md-section]");
    if (section) {
      const target = document.getElementById(section.getAttribute("aria-controls"));
      target?.focus({ preventScroll: true });
      if (target) panel.scrollTop += target.getBoundingClientRect().top - panel.querySelector(".dz__tools").getBoundingClientRect().bottom - 12;
    }
  });
  document.addEventListener("keydown", (event) => {
    if (root.hidden) return;
    if (event.key === "Escape") close();
    if (event.key === "Tab") {
      const controls = [...panel.querySelectorAll('button:not(:disabled), a[href], input, textarea, select, [tabindex="0"]')]
        .filter(element => element.getClientRects().length > 0);
      const first = controls[0];
      const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
  });
}

export function setMatchModel(activeModel) {
  model = activeModel;
  if (!root || root.hidden) return;
  const match = model.matches?.find(item => item.id === openId);
  if (!match) return close();
  replaceContent(panel.querySelector("#mdScore"), renderScore(match));
  refreshOpenMatch();
}

export function refreshMatchFollows() {
  if (!root || root.hidden) return;
  const match = model.matches?.find(item => item.id === openId);
  if (!match) return;
  replaceContent(panel.querySelector("#mdScore"), renderScore(match));
  replaceContent(panel.querySelector("#mdFollowNotice"), followNotice());
}

export function openMatch(match) {
  if (!root || !panel || !match) return;
  if (root.hidden) {
    opener = document.activeElement;
    bodyOverflow = document.body.style.overflow;
  }
  unmountBanter(); // tear down any banter from a previously opened match
  openId = match.id;
  lastDetail = null;
  root.hidden = false;
  document.querySelector(".shell").inert = true;
  document.body.style.overflow = "hidden";
  panel.scrollTop = 0;
  panel.innerHTML = renderShell(match);
  if (banterAvailable()) mountBanter(panel.querySelector("[data-banter]"), openId);
  panel.querySelector("[data-md-close]").focus({ preventScroll: true });
  refreshOpenMatch();
}

function close() {
  if (!root) return;
  unmountBanter();
  request?.abort();
  request = null;
  const matchId = openId;
  openId = null;
  lastDetail = null;
  root.hidden = true;
  document.querySelector(".shell").inert = false;
  document.body.style.overflow = bodyOverflow;
  const target = opener?.isConnected ? opener
    : document.querySelector(`[data-match-id="${CSS.escape(String(matchId))}"]`) ?? document.querySelector(".brand");
  target?.focus({ preventScroll: true });
}

function refreshOpenMatch() {
  const match = model.matches?.find(item => item.id === openId);
  if (!match || root.hidden) return;
  request?.abort();
  request = new AbortController();
  const signal = request.signal;
  const retry = panel.querySelector("[data-md-retry]");
  if (retry) retry.disabled = true;
  loadDetail(match, signal);
  loadAnalysis(match, signal);
}

function replaceContent(slot, html, hidden = slot?.hidden) {
  if (!slot || (slot.innerHTML === html && slot.hidden === hidden)) return;
  const scrollTop = panel.scrollTop;
  const focused = slot.contains(document.activeElement) ? document.activeElement : null;
  const team = focused?.dataset.scoreFollow;
  const focusId = focused?.closest("[data-md-section-panel]")?.id;
  const edge = panel.querySelector(".dz__tools").getBoundingClientRect().bottom + 12;
  const focusedSection = document.activeElement.closest("[data-md-section-panel]");
  const focusedRect = focusedSection?.getBoundingClientRect();
  const visibleFocus = focusedRect && focusedRect.bottom > edge && focusedRect.top < panel.getBoundingClientRect().bottom;
  const anchor = (visibleFocus ? focusedSection : null) ?? [...panel.querySelectorAll("[data-md-section-panel]")].find(section => {
    const rect = section.getBoundingClientRect();
    return rect.top <= edge + 1 && rect.bottom > edge;
  });
  const anchorTop = anchor?.getBoundingClientRect().top;
  if (slot.innerHTML !== html) slot.innerHTML = html;
  slot.hidden = hidden;
  panel.scrollTop = scrollTop;
  if (team) slot.querySelector(`[data-score-follow="${CSS.escape(team)}"]`)?.focus({ preventScroll: true });
  else if (focusId) document.getElementById(focusId)?.focus({ preventScroll: true });
  // Keep the section being read in place when events or analysis grow above it.
  const restored = anchor && document.getElementById(anchor.id);
  if (restored) panel.scrollTop += restored.getBoundingClientRect().top - anchorTop;
}

async function loadDetail(match, signal) {
  const slot = panel.querySelector("#mdBody");
  if (!slot || match.id == null) {
    if (slot) replaceContent(slot, renderDetail(match));
    return;
  }
  const staticSrc = `./data/${encodeURIComponent(match.competitionCode ?? model.competition?.code)}/matches/${match.id}.json?cache=${Date.now()}`;

  // The Worker answers first, but a Worker 200 with empty sections must not
  // suppress the static bake: upstream soft-throttles the Worker's egress
  // per endpoint (players present, lineups and events empty, nothing flagged),
  // while the bake runs on GitHub's egress upstream trusts and so often holds
  // the more complete copy of a match that has kicked off. On the 2026-27
  // opening weekend the one match whose Worker read failed OUTRIGHT rendered
  // fine through this fallback, and the four partial 200s rendered broken.
  // So: for a started match whose Worker read is missing any section, fetch
  // the baked copy too and fill the gaps section by section
  // (fillDetailSections; the fresher Worker read always wins a section it has).
  let detail = DATA_API ? await fetchDetailJson(`${DATA_API}/match/${match.id}`, signal) : null;
  const started = isLive(match.status) || isFinished(match.status);
  if (!detail || (started && (detailSubstanceScore(detail) < DETAIL_SECTION_COUNT || !detail.home?.lineup?.length || !detail.away?.lineup?.length))) {
    if (signal.aborted) return;
    const baked = await fetchDetailJson(staticSrc, signal);
    if (baked) detail = fillDetailSections(detail, baked);
  }

  if (signal.aborted || openId !== match.id) return;
  const body = panel.querySelector("#mdBody");
  if (!body) return;
  const update = panel.querySelector("#mdUpdate");
  const retryFocused = update.contains(document.activeElement);
  replaceContent(update, update.innerHTML, Boolean(detail));
  update.querySelector("[data-md-retry]").disabled = false;
  if (detail) lastDetail = detail;
  replaceContent(body, renderDetail(match, lastDetail ?? {}));
  if (detail && retryFocused) panel.querySelector("[data-md-close]").focus({ preventScroll: true });
}

async function fetchDetailJson(src, signal) {
  try {
    const response = await fetch(src, { cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

// AI analysis card (Worker /analysis/:id). Purely additive: any failure, missing
// config, or a match the Worker cron has not analysed yet just leaves the section
// hidden. This fetch only ever reads the stored copy, never triggers a generation.
async function loadAnalysis(match, signal) {
  if (!DATA_API || match.id == null) return;
  if (!isLive(match.status) && !isFinished(match.status)) return;
  try {
    const response = await fetch(`${DATA_API}/analysis/${match.id}`, {
      cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
    });
    if (!response.ok) return;
    const analysis = await response.json();
    if (signal.aborted || openId !== match.id) return;
    const slot = panel.querySelector("#mdAnalysis");
    if (!slot || !analysis?.match || !analysis?.context) return;
    const live = isLive(analysis.status);
    const stamp = live
      ? `as of ${analysis.minute ? `${analysis.minute}'` : "now"}`
      : "full-time read";
    replaceContent(slot, `
      <p>Match analysis${live ? " · live" : ""}</p>
      ${analysis.headline ? `<p class="dz__aihead">${esc(analysis.headline)}</p>` : ""}
      <p>${esc(analysis.match)} ${esc(analysis.context)}</p>
      <p class="dz__aimeta">${esc(stamp)} · written by Claude, it can slip up</p>`, false);
  } catch {
    // analysis is a bonus; the drawer works without it
  }
}

// -- shell (instant, no fetch) --------------------------------------------------

function renderScore(match) {
  const live = isLive(match.status);
  const finished = isFinished(match.status);
  const decided = Number.isFinite(match.score?.home) && Number.isFinite(match.score?.away);
  const pens = Number.isFinite(match.penalties?.home) && Number.isFinite(match.penalties?.away);

  const pill = live
    ? `<span class="dz__pill dz__pill--live">${esc(statusLabel(match))}</span>`
    : finished
      ? `<span class="dz__pill">${pens ? `FT · pens ${match.penalties.home}–${match.penalties.away}` : "Full time"}</span>`
      : `<span class="dz__pill">${esc(["SCHEDULED", "TIMED"].includes(match.status) ? `${dayLabel(match.utcDate)} ${timeLabel(match.utcDate)}` : statusLabel(match))}</span>`;

  const competition = match.competitionCode ?? model.competition?.code;
  return `<div class="dz__team">${badgeFor(match.homeTeam, "xl")}<p>${esc(displayTeamName(match.homeTeam))}</p>${followButton(competition, match.homeTeam)}</div>
      <div>
        <p class="dz__num">${decided ? `${match.score.home} – ${match.score.away}` : "v"}</p>
        ${pill}
      </div>
      <div class="dz__team">${badgeFor(match.awayTeam, "xl")}<p>${esc(displayTeamName(match.awayTeam))}</p>${followButton(competition, match.awayTeam)}</div>`;
}

function renderShell(match) {
  return `
    <div class="dz__tools">
    <div class="dz__bar">
      <span class="dz__tag">${contextLabel(match)}${match.utcDate ? ` · ${esc(dayLabel(match.utcDate))}` : ""}</span>
      <button class="dz__close" type="button" data-md-close aria-label="Close">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>
      </button>
    </div>
    <nav class="dz__sections" aria-label="Match sections">
      ${[["mdOverview", "Overview"], ["mdTimeline", "Timeline"], ["mdLineups", "Line-ups"], ...(banterAvailable() ? [["mdBanter", "Banter"]] : [])].map(([id, label]) => `<button type="button" data-md-section aria-controls="${id}">${label}</button>`).join("")}
    </nav>
    </div>
    <section id="mdOverview" data-md-section-panel tabindex="-1" aria-label="Overview">
    <div class="dz__score" id="mdScore" aria-live="polite">${renderScore(match)}</div>
    <div id="mdFollowNotice" role="status">${followNotice()}</div>
    ${match.venue ? `<p class="dz__venue">${esc(match.venue)}</p>` : ""}
    <div class="dz__ai" id="mdAnalysis" hidden></div>
    </section>
    <div id="mdBody">${detailSection("mdTimeline", "Timeline", '<p class="dz__loading" data-md-loading>Loading timeline…</p>')}${detailSection("mdLineups", "Line-ups", '<p class="dz__loading">Loading line-ups…</p>')}</div>
    <div id="mdUpdate" role="status" hidden>
      <p class="note">Match details could not be refreshed. Any details shown are from the last available update.</p>
      <button class="seg" type="button" data-md-retry>Try again</button>
    </div>
    ${banterAvailable() ? detailSection("mdBanter", "Banter", '<div data-banter></div>') : ""}
  `;
}

// -- detail (after fetch) ---------------------------------------------------------

export function renderDetail(match, detail = {}) {
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
      mark: c.card === "RED" || c.card === "YELLOW_RED" ? "red" : "yellow",
      text: c.player,
      kind: c.card === "RED" || c.card === "YELLOW_RED" ? "Red card" : "Yellow card",
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
    ? `${events
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

  const lineups = [[detail.home, match.homeTeam], [detail.away, match.awayTeam]]
    .map(([team, name]) => renderLineup(team) || `<p class="note">${esc(displayTeamName(name))}: ${coverageNote(match, "Line-up")}</p>`).join("");

  const meta = [
    detail.venue ? `<span><b>Stadium</b>${esc(detail.venue)}</span>` : "",
    detail.attendance ? `<span><b>Attendance</b>${Number(detail.attendance).toLocaleString("en-IE")}</span>` : "",
    detail.referee ? `<span><b>Referee</b>${esc(detail.referee)}</span>` : "",
  ].filter(Boolean);

  const degraded = Array.isArray(detail.degraded) && detail.degraded.length > 0;

  return `
    ${detailSection("mdTimeline", "Timeline", timeline || `<p class="note">${coverageNote(match, "Timeline")}</p>`)}
    ${detailSection("mdLineups", "Line-ups", lineups)}
    ${meta.length ? `<div class="dz__meta">${meta.join("")}</div>` : ""}
    <p class="note--dim" style="margin-top:14px;">${
      degraded
        ? "Some match details are missing from the feed. Available details are shown above."
        : "Match detail depends on the coverage provided by the feed."
    }</p>`;
}

// One team's line-up block: header (badge, name, formation, coach), then the
// starters drawn on a pitch when the feed placed all eleven on its formation
// grid, else the flat two-column list, then the bench. Exported so the pitch
// markup can be exercised without a DOM.
export function renderLineup(team) {
  if (!team?.lineup?.length) return "";
  const rows = pitchRows(team.lineup);
  const starters = rows
    ? `<div class="xi-pitch">${rows
        .map(
          (line) =>
            `<div class="xi-pitch__row">${line
              .map(
                (p) =>
                  `<div class="xi-pitch__player"><span class="xi-pitch__num">${p.num ?? ""}</span><span class="xi-pitch__name">${esc(surname(p.name))}</span></div>`,
              )
              .join("")}</div>`,
        )
        .join("")}</div>`
    : `<ol class="xi__players">${team.lineup
        .map((p) => `<li><span class="xi__num">${p.num ?? ""}</span>${esc(p.name)}<span class="xi__pos">${esc(shortPos(p.pos))}</span></li>`)
        .join("")}</ol>`;
  // Keeper first, then defence, midfield, attack (issue #51). The feed lists
  // substitutes in its own order, which is not the order anyone reads a bench
  // in; the starting XI above already arrives grouped by position (or drawn on
  // the pitch), so a bench that is not makes the two lists look like they
  // follow different rules. Sorted here rather than in mapApiFootball.js, which
  // is the ingestion contract and should keep transporting what the provider
  // actually sent.
  const bench = [...(team.bench ?? [])]
    .sort(byPosition)
    .map((p) => esc(p.name))
    .join(", ");
  return `<div class="xi">
      <div class="xi__head">${badgeFor(normalizeTeamName(team.name))}<span>${esc(displayTeamName(normalizeTeamName(team.name)))}</span>
        ${team.formation ? `<span class="xi__formation">${esc(team.formation)}</span>` : ""}
        ${team.coach ? `<span class="xi__coach">${esc(team.coach)}</span>` : ""}
      </div>
      ${starters}
      ${bench ? `<p class="xi__bench"><span>Bench</span>${bench}</p>` : ""}
    </div>`;
}

function detailSection(id, title, content) {
  return `<section id="${id}" data-md-section-panel tabindex="-1" aria-labelledby="${id}Title"><h4 id="${id}Title">${title}</h4>${content}</section>`;
}

function coverageNote(match, section) {
  if (["SCHEDULED", "TIMED"].includes(match.status))
    return section === "Timeline" ? "The match has not started. Events appear when published by the feed." : "Not published yet.";
  return `${section} unavailable from the feed${isLive(match.status) ? " at the moment" : ""}.`;
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

// Formation rows from the provider's per-player grid ("row:col", row 1 the
// keeper). All eleven or nothing: one unplaced starter and the drawn shape
// would lie about the formation, so any gap falls back to the flat list. Old
// static match files carry no grid at all and take that fallback wholesale.
export function pitchRows(lineup) {
  if (!lineup?.length) return null;
  const rows = new Map();
  for (const p of lineup) {
    const placed = /^(\d+):(\d+)$/.exec(String(p.grid ?? ""));
    if (!placed) return null;
    const row = Number(placed[1]);
    if (!rows.has(row)) rows.set(row, []);
    rows.get(row).push({ ...p, col: Number(placed[2]) });
  }
  return [...rows.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, line]) => line.sort((a, b) => a.col - b.col));
}

// A pitch tile fits a surname, not "Konstantinos Tzolakis". Everything after
// the first word survives so "van Dijk" stays whole; a single-word name is
// already as short as it gets.
export function surname(name) {
  const parts = String(name ?? "").trim().split(/\s+/);
  return parts.length > 1 ? parts.slice(1).join(" ") : (parts[0] ?? "");
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);
}

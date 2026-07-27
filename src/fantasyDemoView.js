// HTML-string renderers for the signed-out "try a draft" demo (setup, the
// draft itself, the manager desk between chunks, the compressed-season roll,
// and the report card). The draft screen and the desk's lineup editor are
// NOT rendered here from scratch: they reuse renderFantasyDraftRoom and
// renderFantasyRosterPanel from fantasyView.js directly (see app.js), so the
// demo looks and behaves like the real product rather than a separate toy -
// the desk's waiver wire below is the one genuinely new screen, since the
// real product has no equivalent "browse the wire ranked by what players
// have actually scored" view today. Every renderer here is pure (no DOM, no
// fetch); all user-supplied text (the manager name) is escaped before it
// ever reaches the DOM.

import { abbrFor, badgeFor } from "./badges.js";
import { formatOrdinal } from "./fantasyDraft.js";
import {
  DEFAULT_DEMO_MANAGER_NAME,
  DEMO_LEAGUE_SIZES,
  DEFAULT_DEMO_LEAGUE_SIZE,
  DEMO_CLOCK_SECONDS_OPTIONS,
  DEMO_CLOCK_UNTIMED,
  DEFAULT_DEMO_CLOCK_SECONDS,
} from "./fantasyDemo.js";

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

// -- Setup ----------------------------------------------------------------------

export function renderDemoSetup({ name = "", size = DEFAULT_DEMO_LEAGUE_SIZE, clock = DEFAULT_DEMO_CLOCK_SECONDS, busy = false } = {}) {
  const sizeButtons = DEMO_LEAGUE_SIZES.map(
    (option) =>
      `<button class="seg ${option === size ? "is-active" : ""}" type="button" data-demo-size="${option}" ${busy ? "disabled" : ""}>${option} managers</button>`,
  ).join("");

  const clockButtons = [...DEMO_CLOCK_SECONDS_OPTIONS, DEMO_CLOCK_UNTIMED]
    .map((option) => {
      const label = option === DEMO_CLOCK_UNTIMED ? "Untimed" : `${option}s`;
      const isActive = String(option) === String(clock);
      return `<button class="seg ${isActive ? "is-active" : ""}" type="button" data-demo-clock="${option}" ${busy ? "disabled" : ""}>${label}</button>`;
    })
    .join("");

  return `
    <div class="demo-setup">
      <div class="hero__head">
        <div class="hero__lead">
          <p class="hero__eyebrow">Try it free</p>
          <h1 class="hero__title">Draft a squad in 5 minutes</h1>
        </div>
      </div>
      <p class="note demo-setup__lede">Draft 15 players snake-style against computer managers, then watch a full season play out and get your report card. No sign-in needed.</p>
      <section class="card demo-setup__card">
        <h3 class="card__title">Your manager name</h3>
        <input
          class="fantasy-input demo-setup__name"
          type="text"
          maxlength="40"
          placeholder="${esc(DEFAULT_DEMO_MANAGER_NAME)}"
          value="${esc(name)}"
          data-demo-name
          autocomplete="off"
          ${busy ? "disabled" : ""}
        />
        <h3 class="card__title demo-setup__sizelabel">League size</h3>
        <div class="segrow">${sizeButtons}</div>
        <h3 class="card__title demo-setup__sizelabel">Pick clock</h3>
        <div class="segrow">${clockButtons}</div>
        <button class="btn btn--primary demo-setup__start" type="button" data-demo-start ${busy ? "disabled" : ""}>
          ${busy ? "Setting up…" : "Start draft"}
        </button>
      </section>
    </div>`;
}

// -- Manager desk (between chunks) ------------------------------------------------
//
// The interactive core: a pause between chunks with results/news, the waiver
// wire, and a lineup/captain editor, plus a "sim to the end" escape. Every
// number here comes straight off the season state app.js already holds
// (season.history's last entry, standingsThroughGameweek, demoManagerForm,
// availableWaiverPlayers) - this module only lays it out.

function renderDeskResults({ season, humanId, fromGw, toGw, standings, form }) {
  const results = (season.fixtures ?? [])
    .filter(
      (fixture) =>
        fixture.gameweek >= fromGw &&
        fixture.gameweek <= toGw &&
        (fixture.homeUserId === humanId || fixture.awayUserId === humanId),
    )
    .sort((a, b) => a.gameweek - b.gameweek);
  const rows = results
    .map((fixture) => {
      const isHome = fixture.homeUserId === humanId;
      const mine = isHome ? fixture.homeScore : fixture.awayScore;
      const theirs = isHome ? fixture.awayScore : fixture.homeScore;
      const opponentId = isHome ? fixture.awayUserId : fixture.homeUserId;
      const opponentName = season.members?.find?.((member) => member.userId === opponentId)?.name ?? "Opponent";
      const outcome = mine > theirs ? "W" : mine < theirs ? "L" : "D";
      return `<div class="demo-desk-result demo-desk-result--${outcome.toLowerCase()}">
          <span class="demo-desk-result__gw">GW${esc(fixture.gameweek)}</span>
          <span class="demo-desk-result__score">${esc(mine)} - ${esc(theirs)}</span>
          <span class="demo-desk-result__opp">${esc(opponentName)}</span>
          <span class="demo-desk-result__outcome">${outcome}</span>
        </div>`;
    })
    .join("");

  const position = standings.findIndex((row) => row.userId === humanId) + 1;
  const formChips = (form ?? [])
    .map((letter) => `<span class="demo-desk-form__chip demo-desk-form__chip--${letter.toLowerCase()}">${letter}</span>`)
    .join("");

  return `
    <section class="card demo-desk__card">
      <div class="demo-desk__headrow">
        <div>
          <p class="fantasy-eyebrow">Gameweeks ${esc(fromGw)}-${esc(toGw)}</p>
          <p class="demo-desk__position">${formatOrdinal(position)} <span class="note--dim">of ${standings.length}</span></p>
        </div>
        <div class="demo-desk-form">${formChips || `<span class="note--dim">No results yet</span>`}</div>
      </div>
      <div class="demo-desk-results">${rows || `<p class="note">No fixtures this stretch.</p>`}</div>
    </section>`;
}

function renderDeskNewsEntry(icon, label, entries, detail) {
  if (!entries?.length) return "";
  const rows = entries
    .map(
      (entry) => `<div class="demo-desk-news__row">
          ${badgeFor(entry.player.team)}
          <span class="demo-desk-news__name">${esc(entry.player.name)}</span>
          <span class="note--dim">${detail(entry)}</span>
        </div>`,
    )
    .join("");
  return `<div class="demo-desk-news__group">
      <p class="demo-desk-news__label">${icon} ${esc(label)}</p>
      ${rows}
    </div>`;
}

function renderDeskNews(news) {
  if (!news) return "";
  const groups = [
    renderDeskNewsEntry("🩹", "Injuries", news.injuries, (entry) => `Out GW${entry.start}-${entry.end}`),
    renderDeskNewsEntry("🔥", "Breakout on the wire", news.breakouts, (entry) => `${entry.points} pts this stretch`),
    renderDeskNewsEntry("📉", "Quiet stretch", news.underperformers, (entry) => `${entry.points} pts this stretch`),
  ].join("");
  if (!groups) return "";
  return `<section class="card demo-desk__card demo-desk-news">${groups}</section>`;
}

function renderLastWaiverResult(result, playerName) {
  if (!result) return "";
  const won = result.status === "processed";
  return `<p class="note demo-desk-waiver__lastresult demo-desk-waiver__lastresult--${won ? "won" : "lost"}">
      ${won ? "Your last claim went through" : `Your last claim missed out${result.reason ? `: ${esc(result.reason)}` : ""}`}${playerName ? ` (${esc(playerName)})` : ""}.
    </p>`;
}

function renderWaiverRow(player, points, { queued, dropCandidates }) {
  if (queued) {
    return `<div class="fantasy-fa-row demo-desk-wire__row is-queued">
        ${badgeFor(player.team)}
        <span class="fantasy-fa-row__id"><strong>${esc(player.name)}</strong><span class="note--dim">${esc(abbrFor(player.team))} · ${esc(points)} pts</span></span>
        <span class="fantasy-pos">${esc(player.position)}</span>
        <span class="fantasy-fa-row__action"><span class="chip fantasy-chip">Queued</span></span>
      </div>`;
  }
  const disabled = !dropCandidates?.length;
  return `<div class="fantasy-fa-row demo-desk-wire__row">
      ${badgeFor(player.team)}
      <span class="fantasy-fa-row__id"><strong>${esc(player.name)}</strong><span class="note--dim">${esc(abbrFor(player.team))} · ${esc(points)} pts this season</span></span>
      <span class="fantasy-pos">${esc(player.position)}</span>
      <span class="fantasy-fa-row__action">
        <button class="btn fantasy-draft-btn" type="button" data-demo-waiver-claim="${player.id}" ${disabled ? "disabled" : ""}>Claim</button>
      </span>
    </div>`;
}

function renderWaiverClaimFlow(target, { roster, dropPlayerId }) {
  const candidates = (roster ?? []).filter((player) => player.position === target.position);
  const drops = candidates.length
    ? candidates
        .map(
          (player) => `<button class="fantasy-claim-drop ${player.id === dropPlayerId ? "is-selected" : ""}" type="button" data-demo-claim-drop="${player.id}">
              ${badgeFor(player.team)}
              <span>${esc(player.name)}</span>
            </button>`,
        )
        .join("")
    : `<p class="note">You have no ${esc(target.position)} to drop, so this claim isn't possible.</p>`;
  return `
    <section class="card fantasy-claim-flow demo-desk-wire__flow">
      <div class="fantasy-claim-flow__head">
        ${badgeFor(target.team)}
        <div>
          <strong>${esc(target.name)}</strong>
          <p class="note--dim">${esc(target.position)} · ${esc(abbrFor(target.team))}</p>
        </div>
      </div>
      <p class="note">Every squad slot is always full: claiming a ${esc(target.position)} means queuing a same-position drop. Bots are deciding their own claims too - the wire is contested, not first come first served.</p>
      <div class="fantasy-claim-flow__drops">${drops}</div>
      <div class="fantasy-claim-flow__actions">
        <button class="seg" type="button" data-demo-claim-cancel>Cancel</button>
        <button class="btn btn--primary" type="button" data-demo-claim-confirm ${dropPlayerId != null ? "" : "disabled"}>Queue claim</button>
      </div>
    </section>`;
}

function renderDeskWaivers({
  waiverWire,
  roster,
  waiverTarget,
  pendingDropId,
  waiverPick,
  lastWaiverResult,
  lastWaiverPlayerName,
}) {
  const rows = (waiverWire ?? [])
    .slice(0, 12)
    .map((entry) =>
      renderWaiverRow(entry.player, entry.points, {
        queued: waiverPick?.addPlayerId === entry.player.id,
        dropCandidates: (roster ?? []).filter((player) => player.position === entry.player.position),
      }),
    )
    .join("");

  return `
    <section class="card demo-desk__card demo-desk-wire">
      <h3 class="card__title">Waiver wire</h3>
      <p class="note">Ranked by what they have actually scored this season, not preseason tier. Rolling priority: whoever hasn't won a claim recently gets first pick of a contested player.</p>
      ${renderLastWaiverResult(lastWaiverResult, lastWaiverPlayerName)}
      ${waiverPick ? `<p class="note demo-desk-wire__queued">One claim queued for this desk - it resolves once you continue.</p>` : ""}
      <div class="demo-desk-wire__rows">${rows || `<p class="note">Nothing worth claiming right now.</p>`}</div>
      ${waiverTarget ? renderWaiverClaimFlow(waiverTarget, { roster, dropPlayerId: pendingDropId }) : ""}
    </section>`;
}

// `rosterPanel` is the ALREADY-RENDERED renderFantasyRosterPanel HTML (app.js
// calls it directly with the real fantasyLineups.js/fantasyDraft.js-backed
// editor state, since this view module deliberately stays parallel to, not
// duplicating, fantasyView.js's pitch renderer - the exact division CLAUDE.md
// describes for the draft screen itself).
export function renderDemoDesk({
  season,
  humanId,
  fromGw,
  toGw,
  standings,
  form,
  news,
  waiverWire,
  roster,
  waiverTarget,
  pendingDropId,
  waiverPick,
  lastWaiverResult,
  lastWaiverPlayerName,
  rosterPanelHtml,
  isFinal,
}) {
  return `
    <div class="demo-desk">
      <div class="hero__head">
        <div class="hero__lead">
          <p class="hero__eyebrow">Manager desk</p>
          <h1 class="hero__title">Set your team for gameweek ${esc(fromGw)}${isFinal ? "" : ` onward`}</h1>
        </div>
      </div>
      ${renderDeskResults({ season, humanId, fromGw, toGw, standings, form })}
      ${renderDeskNews(news)}
      ${renderDeskWaivers({ waiverWire, roster, waiverTarget, pendingDropId, waiverPick, lastWaiverResult, lastWaiverPlayerName })}
      <section class="card demo-desk__card">
        <h3 class="card__title">Team and captain</h3>
        ${rosterPanelHtml}
      </section>
      <div class="demo-desk__actions">
        <button class="btn btn--primary" type="button" data-demo-desk-continue>${isFinal ? "Play the final gameweeks →" : "Continue to next gameweeks →"}</button>
        <button class="seg" type="button" data-demo-sim-to-end>Sim to the end</button>
      </div>
    </div>`;
}

// -- Compressed season roll -------------------------------------------------------

// `standings` is already-derived (standingsThroughGameweek), rendered with the
// same row shape/classes as the real Standings tab so the roll looks like the
// product's own table animating, not a bespoke widget. The rank is by
// head-to-head record (win 3, draw 1, loss 0), same as the real Standings
// tab (fantasyGameweek.js's standingsFromFixtures), not by points-for; the
// PTS column shows that record so the ordering reads correctly against its
// own numbers instead of looking mis-sorted next to PF.
export function renderDemoRoll({ gameweek, totalGameweeks, standings, humanId, done = false }) {
  const rows = (standings ?? [])
    .map((row, index) => {
      const isMe = row.userId === humanId;
      return `<div class="fantasy-standings-row demo-roll-row ${isMe ? "is-me" : ""}">
          <span class="fantasy-standings-row__rank">${index + 1}</span>
          <span class="fantasy-standings-row__name">${esc(row.name)}${isMe ? ` <span class="note--dim">(you)</span>` : ""}</span>
          <span class="fantasy-standings-row__pts">${esc(row.recordPoints)}</span>
          <span>${esc(row.pointsFor)}</span>
        </div>`;
    })
    .join("");

  const percent = totalGameweeks ? Math.round((gameweek / totalGameweeks) * 100) : 0;

  return `
    <div class="demo-roll">
      <div class="hero__head">
        <div class="hero__lead">
          <p class="hero__eyebrow">Trial season</p>
          <h1 class="hero__title">${done ? "Season complete" : "Playing out the season…"}</h1>
        </div>
      </div>
      <section class="card demo-roll__card">
        <div class="demo-roll__meter"><span class="demo-roll__meter-fill" style="width:${percent}%"></span></div>
        <p class="note demo-roll__label">Gameweek ${esc(gameweek)} of ${esc(totalGameweeks)}</p>
        <div class="fantasy-standings__table demo-roll__table">
          <div class="fantasy-standings__cols demo-roll__cols">
            <span>Rank</span><span>Manager</span><span>PTS</span><span>PF</span>
          </div>
          <div class="fantasy-standings__rows">${rows}</div>
        </div>
        <p class="note--dim demo-roll__footnote">Ranked by PTS, the head-to-head record (win 3, draw 1, loss 0), not by PF. A higher PF can still sit below a lower one.</p>
        ${done ? "" : `<button class="seg demo-roll__skip" type="button" data-demo-skip>Skip ahead →</button>`}
      </section>
    </div>`;
}

// -- Report card -------------------------------------------------------------------

function factCard(label, value, detail) {
  return `<div class="demo-report__fact">
      <p class="demo-report__fact-label">${esc(label)}</p>
      <p class="demo-report__fact-value">${value}</p>
      ${detail ? `<p class="note demo-report__fact-detail">${detail}</p>` : ""}
    </div>`;
}

export function renderDemoReportCard({ reportCard, isSignedIn = false, shareStatus = "" }) {
  const rc = reportCard;
  const record = `${rc.wins}W ${rc.draws}D ${rc.losses}L`;
  const finishLabel = `${formatOrdinal(rc.position)} of ${rc.leagueSize}`;

  const mvpBlock = rc.mvp
    ? factCard(
        "MVP",
        `${badgeFor(rc.mvp.player.team)}<span class="demo-report__fact-name">${esc(rc.mvp.player.name)}</span>`,
        `${esc(rc.mvp.points)} pts for you this season`,
      )
    : factCard("MVP", `<span class="note--dim">•</span>`, "");

  const weakLinkBlock = rc.weakLink
    ? factCard(
        "Weak link",
        `${badgeFor(rc.weakLink.player.team)}<span class="demo-report__fact-name">${esc(rc.weakLink.player.name)}</span>`,
        `Only ${esc(rc.weakLink.points)} pts all season`,
      )
    : factCard("Weak link", `<span class="note--dim">•</span>`, "");

  const bestGwBlock = rc.bestGameweek
    ? factCard("Best gameweek", `GW${esc(rc.bestGameweek.gameweek)} · ${esc(rc.bestGameweek.points)} pts`, "")
    : factCard("Best gameweek", `<span class="note--dim">•</span>`, "");

  const rivalBlock = rc.rival
    ? factCard("Your rival", esc(rc.rival.name), `Beat you ${rc.rival.losses} time${rc.rival.losses === 1 ? "" : "s"}`)
    : factCard("Your rival", "Nobody", "You went unbeaten against the whole league");

  const bestTransferBlock = rc.bestTransfer
    ? factCard(
        "Best transfer",
        `${badgeFor(rc.bestTransfer.player.team)}<span class="demo-report__fact-name">${esc(rc.bestTransfer.player.name)}</span>`,
        `${esc(rc.bestTransfer.points)} pts since you claimed them`,
      )
    : factCard("Best transfer", `<span class="note--dim">•</span>`, "No waiver claims this season");

  const worstInjuryBlock = rc.worstInjuryLuck
    ? factCard(
        "Worst injury luck",
        `${badgeFor(rc.worstInjuryLuck.player.team)}<span class="demo-report__fact-name">${esc(rc.worstInjuryLuck.player.name)}</span>`,
        `Missed ${esc(rc.worstInjuryLuck.gameweeksMissed)} gameweek${rc.worstInjuryLuck.gameweeksMissed === 1 ? "" : "s"} this season`,
      )
    : factCard("Worst injury luck", "Clean bill of health", "Nobody on your squad missed time");

  const createLeagueButton = isSignedIn
    ? `<button class="btn btn--primary" type="button" data-section-nav="fantasy">Create a real league</button>`
    : `<button class="btn btn--primary" type="button" data-section-nav="you">Create a real league</button>`;

  return `
    <div class="demo-report">
      <div class="hero__head">
        <div class="hero__lead">
          <p class="hero__eyebrow">Your report card</p>
          <h1 class="hero__title">${esc(finishLabel)}</h1>
        </div>
      </div>
      <section class="card demo-report__headline">
        <div class="demo-report__headline-row">
          <div>
            <p class="note--dim">Record</p>
            <p class="demo-report__headline-value">${esc(record)}</p>
          </div>
          <div>
            <p class="note--dim">Points for</p>
            <p class="demo-report__headline-value demo-report__headline-value--accent">${esc(rc.pointsFor)}</p>
          </div>
          <div>
            <p class="note--dim">Points against</p>
            <p class="demo-report__headline-value">${esc(rc.pointsAgainst)}</p>
          </div>
        </div>
      </section>
      <div class="demo-report__grid">
        ${mvpBlock}
        ${weakLinkBlock}
        ${bestGwBlock}
        ${rivalBlock}
        ${bestTransferBlock}
        ${worstInjuryBlock}
      </div>
      <p class="note--dim demo-report__honesty">This trial season is simulated with invented results (the real 2026/27 season hasn't kicked off yet), not a prediction of anything.</p>
      <div class="demo-report__actions">
        <button class="btn" type="button" data-demo-share>${shareStatus || "Share your result"}</button>
        ${createLeagueButton}
        <button class="seg" type="button" data-demo-restart>Draft again</button>
      </div>
    </div>`;
}

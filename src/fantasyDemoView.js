// HTML-string renderers for the signed-out "try a draft" demo (setup, the
// compressed-season roll, and the report card). The draft screen itself is
// NOT rendered here: it reuses renderFantasyDraftRoom from fantasyView.js
// directly (see app.js), so the demo looks like the real product rather than
// a separate toy; the moment the draft completes app.js hands off straight
// into the season simulation rather than pausing on a "draft complete"
// screen. Every renderer here is pure (no DOM, no fetch); all user-supplied
// text (the manager name) is escaped before it ever reaches the DOM.

import { badgeFor } from "./badges.js";
import { formatOrdinal } from "./fantasyDraft.js";
import { DEFAULT_DEMO_MANAGER_NAME, DEMO_LEAGUE_SIZES, DEFAULT_DEMO_LEAGUE_SIZE } from "./fantasyDemo.js";

function esc(value) {
  return String(value ?? "").replace(/[&<>"]/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
  })[char]);
}

// -- Setup ----------------------------------------------------------------------

export function renderDemoSetup({ name = "", size = DEFAULT_DEMO_LEAGUE_SIZE, busy = false } = {}) {
  const sizeButtons = DEMO_LEAGUE_SIZES.map(
    (option) =>
      `<button class="seg ${option === size ? "is-active" : ""}" type="button" data-demo-size="${option}" ${busy ? "disabled" : ""}>${option} managers</button>`,
  ).join("");

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
        <button class="btn btn--primary demo-setup__start" type="button" data-demo-start ${busy ? "disabled" : ""}>
          ${busy ? "Setting up…" : "Start draft"}
        </button>
      </section>
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
        ${done ? "" : `<button class="seg demo-roll__skip" type="button" data-demo-skip>Skip to result →</button>`}
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
      </div>
      <p class="note--dim demo-report__honesty">This trial season is simulated with invented results (the real 2026/27 season hasn't kicked off yet), not a prediction of anything.</p>
      <div class="demo-report__actions">
        <button class="btn" type="button" data-demo-share>${shareStatus || "Share your result"}</button>
        ${createLeagueButton}
        <button class="seg" type="button" data-demo-restart>Draft again</button>
      </div>
    </div>`;
}

import { abbrFor, badgeFor } from "./badges.js";
import { dateLabel } from "./format.js";
import { MAX_LEAGUE_SIZE } from "./fantasy.js";
import {
  canDraftPlayer,
  currentSeasonLabel,
  draftOrderEntries,
  formatCountdown,
  formatOrdinal,
  formatPickNumber,
  formSparklineBars,
  legalSwapTargets,
  matchupBarWidths,
  matchupLeadSide,
  normalizePlayerStats,
  squadBucketCounts,
  suggestedPick,
  suggestedPickReason,
} from "./fantasyDraft.js";

function esc(value) {
  return String(value ?? "").replace(/[&<>"]/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
  })[char]);
}

function nameForUser(userId, members) {
  return members?.find((member) => member.userId === userId)?.name ?? "Someone";
}

// Small four-point sparkle, inline SVG (no external asset) for the suggested-pick
// eyebrow. currentColor so it always matches the purple eyebrow text around it.
const SPARKLE_ICON = `<svg class="fantasy-sparkle" viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M8 0c.4 2.9 1.1 4.6 2.2 5.8C11.4 6.9 13.1 7.6 16 8c-2.9.4-4.6 1.1-5.8 2.2C9.1 11.4 8.4 13.1 8 16c-.4-2.9-1.1-4.6-2.2-5.8C4.6 9.1 2.9 8.4 0 8c2.9-.4 4.6-1.1 5.8-2.2C7 4.6 7.6 2.9 8 0z"/></svg>`;

// One decimal for AVG/XP, whole number for ADP; a dim placeholder bullet (never
// a fabricated number) when the pool file doesn't carry that field yet (see
// normalizePlayerStats in fantasyDraft.js for the field contract).
function renderStatCell(value, digits) {
  if (value == null) return `<span class="fantasy-stat fantasy-stat--empty">•</span>`;
  return `<span class="fantasy-stat">${digits == null ? value : value.toFixed(digits)}</span>`;
}

// FORM mini-sparkline: up to 5 bars scaled to this player's own max (see
// formSparklineBars), lime for the stronger recent games, purple-tint otherwise.
// A single dim placeholder bullet when there is no form data at all, matching
// the other stat cells rather than drawing a fake flat line.
function renderFormSparkline(form) {
  const bars = formSparklineBars(form);
  if (!bars.length) return `<span class="fantasy-stat fantasy-stat--empty">•</span>`;
  return `<span class="fantasy-sparkline">${bars
    .map(({ height, strong }) => `<span class="fantasy-sparkline__bar ${strong ? "is-strong" : ""}" style="height:${Math.round(3 + height * 15)}px"></span>`)
    .join("")}</span>`;
}

// -- Signed-out / not-configured / error states --------------------------------

// Same card shape as the You section's sign-in prompt; the actual GIS button
// lives in the You section, so this points there rather than duplicating it.
export function renderFantasySignedOut() {
  return `
    <div class="you you--signin">
      <span class="brand__mark you__mark">SG</span>
      <h2 class="you__title">Sign in for Fantasy</h2>
      <p class="note">Create or join a head-to-head draft league with your mates: sign in to get started.</p>
      <button class="seg" type="button" data-section-nav="you">Go to sign in →</button>
      <p class="note--dim">We only use Google to sign you in. No posts, no contacts.</p>
    </div>`;
}

// A revoked/expired session (401 from the fantasy API) is distinct from a
// generic load failure: retrying the same call will just 401 again, so this
// points at the You section's sign-in instead of offering a Retry button.
export function renderFantasySessionExpired() {
  return `
    <div class="you you--signin">
      <span class="brand__mark you__mark">SG</span>
      <h2 class="you__title">Your session expired</h2>
      <p class="note">Sign in again from the You section to keep using Fantasy.</p>
      <button class="seg" type="button" data-section-nav="you">Go to sign in →</button>
    </div>`;
}

export function renderFantasyNotConfigured() {
  return `
    <div class="pending">
      <p class="hero__eyebrow">Fantasy</p>
      <h1 class="hero__title">Fantasy isn't switched on yet</h1>
      <p class="note">This deployment doesn't have the fantasy service configured. It appears here as soon as it does.</p>
    </div>`;
}

export function renderFantasyError(message) {
  return `
    <div class="pending">
      <p class="hero__eyebrow">Fantasy</p>
      <h1 class="hero__title">Couldn't load Fantasy</h1>
      <p class="note">${esc(message || "Something went wrong. Try again shortly.")}</p>
      <div class="hero__meta"><button class="seg" type="button" data-fantasy-retry>Retry</button></div>
    </div>`;
}

// -- Create / join forms, shared by the empty state and the league list --------

function renderFantasyForms({ createBusy = false, createError = "", joinBusy = false, joinError = "" } = {}) {
  return `
    <div class="fantasy-forms">
      <section class="card fantasy-form">
        <h3 class="card__title">Create a league</h3>
        <p class="note">Start a head-to-head draft league and invite friends with a code.</p>
        <div class="fantasy-form__row">
          <input class="fantasy-input" type="text" maxlength="60" placeholder="League name" data-fantasy-create-name ${createBusy ? "disabled" : ""} />
          <button class="btn btn--primary" type="button" data-fantasy-create-submit ${createBusy ? "disabled" : ""}>${createBusy ? "Creating…" : "Create"}</button>
        </div>
        ${createError ? `<p class="note fantasy-form__error">${esc(createError)}</p>` : ""}
      </section>
      <section class="card fantasy-form">
        <h3 class="card__title">Join a league</h3>
        <p class="note">Have an invite code? Join your friends' league.</p>
        <div class="fantasy-form__row">
          <input class="fantasy-input" type="text" maxlength="10" placeholder="Invite code" data-fantasy-join-code ${joinBusy ? "disabled" : ""} />
          <button class="seg" type="button" data-fantasy-join-submit ${joinBusy ? "disabled" : ""}>${joinBusy ? "Joining…" : "Join"}</button>
        </div>
        ${joinError ? `<p class="note fantasy-form__error">${esc(joinError)}</p>` : ""}
      </section>
    </div>`;
}

// No leagues yet: hero-style empty state, forms front and centre.
export function renderFantasyEmptyState(formState = {}) {
  return `
    <div class="fantasy">
      <div class="hero__head">
        <div class="hero__lead">
          <p class="hero__eyebrow">Fantasy</p>
          <h1 class="hero__title">Start a draft league</h1>
        </div>
      </div>
      <p class="note" style="margin-bottom:14px;">Draft a 15-player squad head-to-head against your mates, snake style, live.</p>
      ${renderFantasyForms(formState)}
    </div>`;
}

function leagueStatusChip(status) {
  const label = { pending: "Lobby", drafting: "Drafting", complete: "Complete" }[status] ?? status;
  return `<span class="chip fantasy-chip fantasy-chip--${esc(status)}">${esc(label)}</span>`;
}

function renderLeagueCard(league) {
  return `<button class="card fantasy-league-card" type="button" data-fantasy-league="${league.id}">
      <div class="fantasy-league-card__head">
        <strong>${esc(league.name)}</strong>
        ${leagueStatusChip(league.draftStatus)}
      </div>
      <p class="note">${league.memberCount}/${MAX_LEAGUE_SIZE} manager${league.memberCount === 1 ? "" : "s"}${league.isCommissioner ? " · You're commissioner" : ""}</p>
    </button>`;
}

// Has leagues: cards to click through, plus the same create/join forms below
// so a manager already in a league can still start or join another.
export function renderFantasyLeagueList(leagues, formState = {}) {
  return `
    <div class="fantasy">
      <div class="hero__head">
        <div class="hero__lead">
          <p class="hero__eyebrow">Fantasy</p>
          <h1 class="hero__title">Your leagues</h1>
        </div>
      </div>
      <div class="fantasy-leagues">${leagues.map(renderLeagueCard).join("")}</div>
      ${renderFantasyForms(formState)}
    </div>`;
}

// -- Once inside a league: shared header (eyebrow, title, chips, sub-tabs) ------

// All four sub-tabs are live as of Phase 4.3 (H2H scoring). The active tab's
// label doubles as the view's display title (see renderFantasyLeagueHeader).
const FANTASY_SUBTAB_LABELS = { matchup: "Matchup", myteam: "My team", draftroom: "Draft room", standings: "Standings" };

function renderFantasySubtabs(activeSubTab) {
  return `
    <div class="fantasy-subtabs">
      <button class="fantasy-subtab ${activeSubTab === "matchup" ? "is-active" : ""}" type="button" data-fantasy-subtab="matchup">Matchup</button>
      <button class="fantasy-subtab ${activeSubTab === "myteam" ? "is-active" : ""}" type="button" data-fantasy-subtab="myteam">My team</button>
      <button class="fantasy-subtab ${activeSubTab === "draftroom" ? "is-active" : ""}" type="button" data-fantasy-subtab="draftroom">Draft room</button>
      <button class="fantasy-subtab ${activeSubTab === "standings" ? "is-active" : ""}" type="button" data-fantasy-subtab="standings">Standings</button>
    </div>`;
}

// League header: purple uppercase eyebrow ("<LEAGUE NAME> · H2H"), a big italic
// display title tracking whichever sub-tab is active, and a chip row (manager
// count, draft type). Shared by every in-league state (lobby, live draft,
// complete, my team) so switching sub-tabs never reflows the page around it.
export function renderFantasyLeagueHeader(league, members, activeSubTab) {
  const count = (members ?? []).length;
  return `
    <div class="fantasy-panel-head">
      <button class="seg" type="button" data-fantasy-back>← Leagues</button>
    </div>
    <div class="fantasy-league-head">
      <p class="fantasy-eyebrow">${esc(league.name)} · H2H</p>
      <h1 class="hero__title">${esc(FANTASY_SUBTAB_LABELS[activeSubTab] ?? "Draft room")}</h1>
      <div class="hero__meta">
        <span class="chip">${count} manager${count === 1 ? "" : "s"}</span>
        <span class="chip">Snake draft</span>
      </div>
    </div>
    ${renderFantasySubtabs(activeSubTab)}`;
}

// Wraps a sub-tab's body with the shared header inside the standard .fantasy
// shell, so app.js only needs to pick the right body renderer per (draftStatus,
// subTab) and never re-implements the header/tabs itself.
export function renderFantasyLeagueShell(league, members, activeSubTab, bodyHtml) {
  return `
    <div class="fantasy fantasy-leaguepanel">
      ${renderFantasyLeagueHeader(league, members, activeSubTab)}
      <div class="fantasy-panel-body">${bodyHtml}</div>
    </div>`;
}

// -- Matchup tab (Phase 4.3) -----------------------------------------------------

const MATCHUP_STATUS_LABEL = { scheduled: "Scheduled", live: "Live", final: "Final" };

// Single centerpiece card: gameweek header, a status chip, both managers' names
// and scores side by side with a lead indicator (highlight + comparison bar),
// and a clear bye-week / not-yet-started state instead of a bare 0-0. `matchup`
// is the raw GET /fantasy/league/:id/matchup response (src/fantasyApi.js) or
// null while the first load for this league is still in flight; `error` is a
// load failure distinct from "not loaded yet", with its own retry control
// (mirrors the lineup card's own retry, see renderFantasyRosterPanel).
export function renderFantasyMatchupPanel(matchup, { error = "" } = {}) {
  if (!matchup) {
    return error
      ? `<div class="card"><p class="fantasy-form__error">${esc(error)}</p><button class="seg" type="button" data-fantasy-matchup-retry>Retry</button></div>`
      : `<p class="note">Loading your matchup…</p>`;
  }

  const { gameweek, status, me, opponent } = matchup;
  const statusLabel = MATCHUP_STATUS_LABEL[status] ?? status;

  if (!opponent) {
    return `
      <section class="card fantasy-matchup fantasy-matchup--bye">
        <p class="fantasy-eyebrow">Gameweek ${esc(gameweek)}</p>
        <h2 class="fantasy-matchup__bye-title">Bye week</h2>
        <p class="note">No fixture for you this gameweek. Everyone in the league can't always be paired up evenly, so this round you sit out; you're back in the schedule from next gameweek.</p>
      </section>`;
  }

  // A "scheduled" matchup hasn't kicked off, so its 0-0 score would read as a
  // final result rather than "not started" - show a dim placeholder bullet
  // instead (the same convention normalizePlayerStats/renderStatCell already
  // use for "no real number yet") and skip the lead bar entirely.
  const started = status !== "scheduled";
  const leader = started ? matchupLeadSide(me.score, opponent.score) : "tied";
  const widths = started ? matchupBarWidths(me.score, opponent.score) : null;

  return `
    <section class="card fantasy-matchup">
      <div class="fantasy-matchup__head">
        <p class="fantasy-eyebrow">Gameweek ${esc(gameweek)}</p>
        <span class="chip fantasy-status-chip fantasy-status-chip--${esc(status)}">${esc(statusLabel)}</span>
      </div>
      <div class="fantasy-matchup__row">
        <div class="fantasy-matchup__side ${leader === "me" ? "is-ahead" : ""}">
          <p class="fantasy-matchup__name">${esc(me.name)}</p>
          <p class="fantasy-matchup__score">${started ? esc(me.score) : `<span class="fantasy-stat--empty">•</span>`}</p>
        </div>
        <span class="fantasy-matchup__vs">vs</span>
        <div class="fantasy-matchup__side fantasy-matchup__side--opponent ${leader === "opponent" ? "is-ahead" : ""}">
          <p class="fantasy-matchup__name">${esc(opponent.name)}</p>
          <p class="fantasy-matchup__score">${started ? esc(opponent.score) : `<span class="fantasy-stat--empty">•</span>`}</p>
        </div>
      </div>
      ${
        started
          ? `<div class="fantasy-matchup__bar"><span class="fantasy-matchup__bar-me" style="width:${widths.me}%"></span><span class="fantasy-matchup__bar-opp" style="width:${widths.opponent}%"></span></div>`
          : `<p class="note fantasy-matchup__pending">Not started yet: scores will fill in once this gameweek's matches kick off.</p>`
      }
    </section>`;
}

// -- Standings tab (Phase 4.3) ----------------------------------------------------

// Full-league table through the last completed gameweek. `standings` is the
// raw GET /fantasy/league/:id/standings response (src/fantasyApi.js) or null
// while the first load for this league is still in flight. `myUserId` (already
// tracked on state.fantasy elsewhere in app.js) highlights the caller's own
// row. throughGameweek === 0 means no gameweek has completed yet anywhere in
// the season, not specifically "gameweek 1" (a league could start mid-season),
// so the empty state stays generic rather than naming a gameweek number.
export function renderFantasyStandingsPanel(standings, { error = "", myUserId } = {}) {
  if (!standings) {
    return error
      ? `<div class="card"><p class="fantasy-form__error">${esc(error)}</p><button class="seg" type="button" data-fantasy-standings-retry>Retry</button></div>`
      : `<p class="note">Loading standings…</p>`;
  }

  const { throughGameweek, standings: rows } = standings;

  if (throughGameweek === 0) {
    return `
      <section class="card fantasy-standings-empty">
        <h3 class="card__title">Standings</h3>
        <p class="note">Standings appear once your league's first gameweek finishes. Nobody has a completed gameweek yet.</p>
      </section>`;
  }

  const body = (rows ?? [])
    .map((row, index) => {
      const isMe = myUserId != null && row.userId === myUserId;
      return `<div class="fantasy-standings-row ${isMe ? "is-me" : ""}">
          <span class="fantasy-standings-row__rank">${index + 1}</span>
          <span class="fantasy-standings-row__name">${esc(row.name)}${isMe ? ` <span class="note--dim">(you)</span>` : ""}</span>
          <span>${esc(row.played)}</span>
          <span>${esc(row.wins)}</span>
          <span>${esc(row.draws)}</span>
          <span>${esc(row.losses)}</span>
          <span>${esc(row.pointsFor)}</span>
          <span>${esc(row.pointsAgainst)}</span>
          <span class="fantasy-standings-row__pts">${esc(row.recordPoints)}</span>
        </div>`;
    })
    .join("");

  return `
    <section class="card fantasy-standings">
      <div class="fantasy-standings__head">
        <h3 class="card__title">Standings</h3>
        <p class="note">Through gameweek ${esc(throughGameweek)}</p>
      </div>
      <div class="fantasy-standings__table">
        <div class="fantasy-standings__cols">
          <span>Rank</span><span>Manager</span><span>P</span><span>W</span><span>D</span><span>L</span><span>PF</span><span>PA</span><span>PTS</span>
        </div>
        <div class="fantasy-standings__rows">${body}</div>
      </div>
      <p class="note--dim fantasy-standings__footnote">PTS is the head-to-head record (win 3, draw 1, loss 0), not football points.</p>
    </section>`;
}

// -- Lobby (draftStatus: pending) -----------------------------------------------

// Meta line above the scouting list: when squads were last baked, and (per
// the players.json `complete` flag) whether the pool is still an incomplete
// accumulation from match lineups rather than the full published squads.
function renderPoolMeta(playerPool) {
  const bits = [];
  if (playerPool.lastUpdated) bits.push(`Squads updated ${esc(dateLabel(playerPool.lastUpdated))}`);
  if (playerPool.complete === false) {
    bits.push("still accumulating from match lineups, not every squad is complete yet");
  }
  return bits.length ? `<p class="note">${bits.join(" · ")}</p>` : "";
}

// Pre-draft scouting: the same searchable/filterable player pool card the live
// draft room uses, reused as-is with an inert context (isMyTurn: false, no
// roster, nobody drafted) so canDraftPlayer never lights up a Draft button -
// read-only rows, not a parallel renderer to keep in sync. It therefore also
// inherits the pool's position pills, club filter, search and sticky header for
// free. The pool is supplementary here, so its own absence (fetch 404, never
// baked in production) degrades to a quiet note rather than hiding the rest of
// the lobby or looking like a bug.
function renderScoutingSection(playerPool, filter) {
  if (!playerPool) {
    return `<section class="card"><h3 class="card__title">Player pool</h3><p class="note">Loading player pool…</p></section>`;
  }
  if (playerPool.unavailable || !(playerPool.players ?? []).length) {
    return `<section class="card"><h3 class="card__title">Player pool</h3><p class="note">Player pool not available yet.</p></section>`;
  }
  return `
    ${renderPoolMeta(playerPool)}
    ${renderFantasyPlayerPool(playerPool.players, filter, { isMyTurn: false, myRoster: [], draftedIds: new Set() })}`;
}

export function renderFantasyLobby(league, members, { playerPool, filter } = {}) {
  const sorted = [...members].sort(
    (a, b) => (a.draftPosition ?? 999) - (b.draftPosition ?? 999) || a.name.localeCompare(b.name),
  );
  const rows = sorted
    .map(
      (member, index) => `<div class="fantasy-member-row">
        <span class="fantasy-member-row__pos">${member.draftPosition ?? index + 1}</span>
        <span class="fantasy-member-row__name">${esc(member.name)}${member.userId === league.commissionerUserId ? ` <span class="note--dim">(commissioner)</span>` : ""}</span>
      </div>`,
    )
    .join("");

  const canStart = members.length >= 2;
  const startControl = league.isCommissioner
    ? `<button class="btn btn--primary" type="button" data-fantasy-start-draft ${canStart ? "" : "disabled"}>Start draft</button>
       ${canStart ? "" : `<p class="note">Need at least 2 managers to start.</p>`}`
    : `<p class="note">Waiting for the commissioner to start the draft.</p>`;

  return `
    <section class="card">
      <h3 class="card__title">Managers · ${members.length}/${MAX_LEAGUE_SIZE}</h3>
      <div class="fantasy-members">${rows}</div>
    </section>
    <section class="card fantasy-invite">
      <h3 class="card__title">Invite code</h3>
      <div class="fantasy-invite__row">
        <code class="fantasy-invite__code">${esc(league.inviteCode)}</code>
        <button class="seg" type="button" data-fantasy-copy-invite="${esc(league.inviteCode)}">Copy</button>
      </div>
      <p class="note">Share this code so friends can join before the draft starts.</p>
    </section>
    <section class="card fantasy-start">${startControl}</section>
    ${renderScoutingSection(playerPool, filter ?? { position: "All", club: "All", search: "" })}`;
}

// -- Live draft room (draftStatus: drafting) ------------------------------------

// A transient server-pushed {type:"error"} (e.g. a stale/duplicate pick
// attempt): stashed on draft.lastError by reduceDraftMessage, cleared
// automatically on the next pick/clock message, and dismissable by hand via
// data-fantasy-dismiss-error. Styled with existing classes only (no new CSS
// added here): the card shell plus the same error-red text style the create/
// join forms already use.
function renderDraftErrorNotice(message) {
  return `<div class="card" role="alert" style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
      <p class="fantasy-form__error" style="margin:0;">${esc(message)}</p>
      <button class="seg" type="button" data-fantasy-dismiss-error>Dismiss</button>
    </div>`;
}

// Draft status card: "SNAKE DRAFT · <season>" eyebrow, and "Round R · Pick N"
// on the SAME row as the manager chip strip (headline left, chips right,
// wrapping below only at narrow widths) - the countdown itself lives in its own
// On the clock card now (see renderOnClockCard), not here.
function renderDraftStatusCard({ members, draft, myUserId, season, entries }) {
  const { round, overallPick } = draft;
  const chips = entries
    .map((entry) => {
      const isMe = entry.userId === myUserId;
      return `<div class="fantasy-orderchip ${entry.isOnClock ? "is-onclock" : ""}">
          ${esc(nameForUser(entry.userId, members))}${isMe ? ` <span class="fantasy-orderchip__you">(you)</span>` : ""}
        </div>`;
    })
    .join("");
  return `
    <section class="card fantasy-draftstatus">
      <p class="fantasy-eyebrow">Snake draft · ${esc(season)}</p>
      <div class="fantasy-draftstatus__head">
        <h2 class="fantasy-draftstatus__headline">Round ${round} · Pick ${overallPick}</h2>
        <div class="fantasy-orderstrip">${chips}</div>
      </div>
    </section>`;
}

// On the clock: its own card (mockup order: suggested pick, on the clock,
// recent picks, your squad). Small purple eyebrow, the manager's name large and
// bold on the left with the countdown right-aligned on the same row, and a
// one-line context sentence: "You're on the clock." when it's the caller's
// turn, otherwise who's picking and, honestly derived from the snake order,
// either which upcoming pick in this round is the caller's or that it falls in
// the next round instead.
function renderOnClockCard({ members, draft, myUserId, entries, isMyTurn }) {
  const { onClockUserId, remainingMs } = draft;
  const name = onClockUserId == null ? "Next pick…" : isMyTurn ? "You" : nameForUser(onClockUserId, members);
  let context = "";
  if (isMyTurn) {
    context = "You're on the clock.";
  } else if (onClockUserId != null) {
    const onClockName = esc(nameForUser(onClockUserId, members));
    const onClockIdx = entries.findIndex((entry) => entry.isOnClock);
    const myIdx = entries.findIndex((entry) => entry.userId === myUserId);
    if (onClockIdx !== -1 && myIdx !== -1 && myIdx > onClockIdx) {
      context = `${onClockName} is picking. You pick ${formatOrdinal(myIdx - onClockIdx)} in this round.`;
    } else if (onClockIdx !== -1 && myIdx !== -1) {
      context = `${onClockName} is picking. You're up again next round.`;
    } else {
      context = `${onClockName} is picking.`;
    }
  }
  return `
    <section class="card fantasy-onclock ${isMyTurn ? "is-mine" : ""}">
      <p class="fantasy-eyebrow">On the clock</p>
      <div class="fantasy-onclock__row">
        <h2 class="fantasy-onclock__name">${esc(name)}</h2>
        <span class="fantasy-onclock__time" data-fantasy-clock>${formatCountdown(remainingMs)}</span>
      </div>
      <p class="fantasy-onclock__context">${context}</p>
    </section>`;
}

// Suggested pick: a purple-tinted card naming the player the deterministic
// autoPick heuristic (src/draftLogic.js, via suggestedPick in fantasyDraft.js)
// would take for the caller's own roster right now. Not AI, not a projection:
// the same scarcest-bucket-first rule the server falls back to on a timeout,
// with a one-line rationale walking that exact decision path (suggestedPickReason
// in fantasyDraft.js). The Draft button uses the exact same gating as a pool
// row (my turn, legal pick), so it never offers an action the pool itself would
// refuse.
function renderSuggestedPickCard(player, context) {
  if (!player) return "";
  const legal = Boolean(context?.isMyTurn) && canDraftPlayer(player, context);
  const action = legal
    ? `<button class="btn fantasy-draft-btn" type="button" data-fantasy-draft-player="${player.id}">Draft</button>`
    : "";
  const reason = suggestedPickReason(player, context?.myRoster);
  return `
    <section class="card fantasy-suggest">
      <p class="fantasy-eyebrow">${SPARKLE_ICON} Squad suggests</p>
      <div class="fantasy-suggest__row">
        ${badgeFor(player.team)}
        <span class="fantasy-suggest__name"><strong>${esc(player.name)}</strong></span>
        <span class="chip fantasy-suggest__chip">${esc(player.position)} · ${esc(abbrFor(player.team))}</span>
      </div>
      <p class="fantasy-suggest__reason">${esc(reason)}</p>
      ${action}
    </section>`;
}

function renderPickFeed(picks, members) {
  const recent = [...(picks ?? [])].sort((a, b) => b.overallPick - a.overallPick).slice(0, 20);
  if (!recent.length) return `<p class="note">No picks yet.</p>`;
  return `<div class="fantasy-feed">${recent
    .map(
      (pick) => `<div class="fantasy-feed__row">
        <span class="fantasy-feed__pick">${formatPickNumber(pick.round, pick.pickInRound)}</span>
        ${badgeFor(pick.player.team)}
        <span class="fantasy-feed__player"><strong>${esc(pick.player.name)}</strong><span class="note--dim">${esc(pick.player.position)} · ${esc(abbrFor(pick.player.team))}</span></span>
        <span class="fantasy-feed__by">${esc(nameForUser(pick.userId, members))}</span>
      </div>`,
    )
    .join("")}</div>`;
}

// Your squad: R.PP pick number, player name, club abbreviation, POS chip, plus a
// compact bucket meter (GK n/2, DEF n/5, MID n/5, FWD n/3) in the card header so
// legality stays glanceable. Driven from `picks` (not a bare roster array) so the
// R.PP numbers are always derivable; `compact` controls the sidebar's internal
// scroll cap versus the My team tab's full-height display of the same card.
export function renderMySquad(picks, myUserId, { compact = true } = {}) {
  const myPicks = [...(picks ?? [])].filter((pick) => pick.userId === myUserId).sort((a, b) => a.overallPick - b.overallPick);
  const roster = myPicks.map((pick) => pick.player);
  const buckets = squadBucketCounts(roster);
  const meter = Object.entries(buckets)
    .map(
      ([position, { filled, total }]) =>
        `<span class="fantasy-bucket ${filled >= total ? "is-full" : ""}">${esc(position)} <strong>${filled}/${total}</strong></span>`,
    )
    .join("");
  const rows = myPicks
    .map(
      (pick) => `<div class="fantasy-squad-row">
        <span class="fantasy-squad-row__pick">${formatPickNumber(pick.round, pick.pickInRound)}</span>
        ${badgeFor(pick.player.team)}
        <span class="fantasy-squad-row__name"><strong>${esc(pick.player.name)}</strong><span class="note--dim">${esc(abbrFor(pick.player.team))}</span></span>
        <span class="fantasy-pos">${esc(pick.player.position)}</span>
      </div>`,
    )
    .join("");
  return `
    <section class="card fantasy-myteam ${compact ? "" : "fantasy-myteam--full"}">
      <div class="fantasy-myteam__head">
        <h3 class="card__title">Your squad</h3>
        <div class="fantasy-bucketmeter">${meter}</div>
      </div>
      <div class="fantasy-squad-rows">${rows || `<p class="note">No players drafted yet.</p>`}</div>
    </section>`;
}

// My team tab: the caller's roster (see renderMySquad) at full width, once the
// draft has at least one pick for them; otherwise a quiet nudge back to the
// Draft room rather than an empty-looking card.
export function renderFantasyMyTeamPanel(picks, myUserId) {
  const hasPicks = (picks ?? []).some((pick) => pick.userId === myUserId);
  if (!hasPicks) {
    return `<div class="fantasy-myteam-empty"><p class="note">You haven't drafted anyone yet. Head to the Draft room to make your first pick.</p></div>`;
  }
  return renderMySquad(picks, myUserId, { compact: false });
}

// -- My team pitch view (draftStatus: complete) ---------------------------------
//
// Once a draft is complete a manager's 15-man squad is fixed for the season, so
// the My team tab stops showing the draft-era "Your squad" pick list (that stays
// for pending/drafting leagues via renderFantasyMyTeamPanel above) and instead
// shows this gameweek's starting XI on a pitch, the bench below it, and a Squad
// xP rail card, wired to GET/POST /fantasy/league/:id/lineup (src/fantasyApi.js)
// and the swap-legality helpers in fantasyDraft.js. Every renderer here is pure:
// app.js owns the edit-mode working copy (state.fantasy.lineupEdit) and the
// open player-drawer id, passed in as plain data.

// Attacker-to-keeper, matching how a real formation reads top-to-bottom on a
// pitch graphic (mirrors the Squad Goals design export's own pitchRows order).
const PITCH_ROW_ORDER = ["FWD", "MID", "DEF", "GK"];

// A tile (starter or bench row) dims once a swap is pending and this tile is in
// the opposite group from the pending selection but would not produce a legal
// XI if tapped. Tiles in the SAME group as the pending selection (including the
// pending tile itself) are never dimmed - tapping one just moves the focus,
// it never attempts an invalid same-group "swap" (see handleFantasyLineupTileClick
// in app.js).
function isTileDimmed(playerId, { pending, legalTargets, starterIds }) {
  if (pending == null || pending === playerId) return false;
  const pendingIsStarter = starterIds.includes(pending);
  const tileIsStarter = starterIds.includes(playerId);
  if (pendingIsStarter === tileIsStarter) return false;
  return !legalTargets.has(playerId);
}

function renderPitchTile(player, { isCaptain, isPending, isDimmed, editing }, statsById) {
  const stats = normalizePlayerStats(statsById.get(player.id) ?? {});
  const xpText = stats.xp != null ? `xP ${stats.xp.toFixed(1)}` : "xP •";
  const classes = ["fantasy-pitch__player"];
  if (isPending) classes.push("is-pending");
  if (isDimmed) classes.push("is-dimmed");
  return `
    <div class="${classes.join(" ")}" data-fantasy-player-id="${player.id}" data-fantasy-slot="starter" role="button" tabindex="0">
      ${isCaptain ? `<span class="fantasy-pitch__capbadge" aria-label="Captain">C</span>` : ""}
      <span class="fantasy-pitch__crest">${badgeFor(player.team)}</span>
      <p class="fantasy-pitch__name">${esc(player.name)}</p>
      <p class="fantasy-pitch__club">${esc(abbrFor(player.team))}</p>
      <p class="fantasy-pitch__xp ${stats.xp == null ? "is-empty" : ""}">${xpText}</p>
      ${editing && isPending ? `<button class="fantasy-pitch__captainbtn" type="button" data-fantasy-make-captain="${player.id}">Make captain</button>` : ""}
    </div>`;
}

function renderPitch({ roster, starterIds, benchIds, captainId, editState, statsById }) {
  const byId = new Map(roster.map((player) => [player.id, player]));
  const editing = Boolean(editState);
  const pending = editState?.pendingId ?? null;
  const legalTargets =
    editing && pending != null
      ? legalSwapTargets({ starters: starterIds, captainId, bench: benchIds, roster }, pending)
      : new Set();

  const rows = PITCH_ROW_ORDER.map((position) => {
    const players = starterIds.map((id) => byId.get(id)).filter((player) => player && player.position === position);
    if (!players.length) return "";
    const tiles = players
      .map((player) =>
        renderPitchTile(
          player,
          {
            isCaptain: player.id === captainId,
            isPending: pending === player.id,
            isDimmed: isTileDimmed(player.id, { pending, legalTargets, starterIds }),
            editing,
          },
          statsById,
        ),
      )
      .join("");
    return `<div class="fantasy-pitch__row">${tiles}</div>`;
  }).join("");

  return `<div class="fantasy-pitch__field">${rows}</div>`;
}

function renderLineupSourceNote(lineup) {
  if (!lineup) return "";
  // The lineup API's "gameweek" field is always the current gameweek, even
  // when source is "inherited" (see worker/worker.js's handleFantasyLineupGet):
  // it does not surface which earlier gameweek the carried-over XI was actually
  // set for. Naming a specific GW number here would be a guess, not a fact, so
  // this stays honest about *that* a lineup was inherited rather than claiming
  // to know exactly *when* it was last set.
  if (lineup.source === "inherited") {
    return `<p class="note fantasy-lineup-note">Carried over from an earlier gameweek.</p>`;
  }
  if (lineup.source === "default") {
    return `<p class="note fantasy-lineup-note">Auto-picked XI: set your own.</p>`;
  }
  return "";
}

function renderPitchHead(currentGameweek, lineup, editState) {
  const editing = Boolean(editState);
  const controls = editing
    ? `<div class="fantasy-pitch__editcontrols">
        <button class="seg" type="button" data-fantasy-lineup-cancel ${editState.saving ? "disabled" : ""}>Cancel</button>
        <button class="btn btn--primary" type="button" data-fantasy-lineup-save ${editState.saving ? "disabled" : ""}>${editState.saving ? "Saving…" : "Save"}</button>
      </div>`
    : `<button class="seg" type="button" data-fantasy-lineup-edit>Edit lineup</button>`;
  return `
    <div class="fantasy-pitch__head">
      <div>
        <p class="fantasy-eyebrow">Gameweek ${currentGameweek ?? "?"}</p>
        ${renderLineupSourceNote(lineup)}
      </div>
      ${controls}
    </div>
    ${editState?.error ? `<p class="fantasy-form__error">${esc(editState.error)}</p>` : ""}`;
}

function renderBenchRow(player, { isPending, isDimmed }, statsById) {
  const stats = normalizePlayerStats(statsById.get(player.id) ?? {});
  const xpCell = stats.xp != null ? `<span class="fantasy-bench-row__xp">xP ${stats.xp.toFixed(1)}</span>` : renderStatCell(null);
  const classes = ["fantasy-bench-row"];
  if (isPending) classes.push("is-pending");
  if (isDimmed) classes.push("is-dimmed");
  return `
    <div class="${classes.join(" ")}" data-fantasy-player-id="${player.id}" data-fantasy-slot="bench" role="button" tabindex="0">
      ${badgeFor(player.team)}
      <span class="fantasy-bench-row__name"><strong>${esc(player.name)}</strong><span class="note--dim">${esc(abbrFor(player.team))}</span></span>
      <span class="fantasy-pos">${esc(player.position)}</span>
      ${xpCell}
    </div>`;
}

function renderBench({ roster, starterIds, benchIds, captainId, editState, statsById }) {
  const byId = new Map(roster.map((player) => [player.id, player]));
  const editing = Boolean(editState);
  const pending = editState?.pendingId ?? null;
  const legalTargets =
    editing && pending != null
      ? legalSwapTargets({ starters: starterIds, captainId, bench: benchIds, roster }, pending)
      : new Set();

  const rows = benchIds
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((player) =>
      renderBenchRow(
        player,
        {
          isPending: pending === player.id,
          isDimmed: isTileDimmed(player.id, { pending, legalTargets, starterIds }),
        },
        statsById,
      ),
    )
    .join("");

  return `
    <section class="card fantasy-bench">
      <h3 class="card__title">Bench</h3>
      <div class="fantasy-bench__rows">${rows || `<p class="note">No bench players.</p>`}</div>
    </section>`;
}

// Squad xP: one horizontal bar row per starter (name, a bar scaled to this
// squad's own highest real xP, and the number), using only the real xp field
// from normalizePlayerStats - never a fabricated figure. The explainer
// sentence only appears once at least one starter actually has a real xp
// value; otherwise a single honest placeholder line replaces it so the card
// never implies a projection model is running when the pool has no stats yet.
function renderSquadXp({ roster, starterIds, statsById }) {
  const byId = new Map(roster.map((player) => [player.id, player]));
  const entries = starterIds
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((player) => ({ player, xp: normalizePlayerStats(statsById.get(player.id) ?? {}).xp }));
  const maxXp = Math.max(0.0001, ...entries.map((entry) => entry.xp ?? 0));
  const hasAny = entries.some((entry) => entry.xp != null);

  const rows = entries
    .map(({ player, xp }) => {
      const width = xp != null ? `${Math.max(4, Math.round((xp / maxXp) * 100))}%` : "0%";
      const value = xp != null ? `<span class="fantasy-squadxp__value">${xp.toFixed(1)}</span>` : `<span class="fantasy-squadxp__value fantasy-stat--empty">•</span>`;
      return `
        <div class="fantasy-squadxp__row">
          <span class="fantasy-squadxp__name">${esc(player.name)}</span>
          <span class="fantasy-squadxp__bar"><span style="width:${width};"></span></span>
          ${value}
        </div>`;
    })
    .join("");

  return `
    <section class="card fantasy-squadxp-card">
      <h3 class="fantasy-eyebrow">${SPARKLE_ICON} Squad xP</h3>
      <div class="fantasy-squadxp">${rows || `<p class="note">No starters yet.</p>`}</div>
      <p class="note--dim" style="margin-top:8px;">${
        hasAny ? "Expected points from last-5 form, minutes and fixture difficulty." : "xP arrives with player stats."
      }</p>
    </section>`;
}

// Player stats drawer: a simplified match-drawer-style right slide-in (same .dz
// shell as matchDetail.js) with crest, name, club, position, draft pick (from
// the picks log, when this manager's own pick - other members' picks are also
// in `picks` but a player is only ever on one roster) and whichever of
// avg/form/xp/adp exist. Always rendered (hidden when no player is open) so
// app.js can toggle it by re-rendering the panel rather than managing a second
// piece of imperative DOM state.
function renderPlayerDrawer(player, { picks, statsById }) {
  if (!player) return `<div class="dz fantasy-player-drawer" data-fantasy-player-drawer hidden></div>`;

  const pick = (picks ?? []).find((entry) => entry.player?.id === player.id);
  const pickLabel = pick ? formatPickNumber(pick.round, pick.pickInRound) : null;
  const stats = normalizePlayerStats(statsById.get(player.id) ?? {});
  const hasStats = stats.avg != null || stats.form != null || stats.xp != null || stats.adp != null;

  const statRows = hasStats
    ? `<div class="fantasy-drawer__stats">
        <div class="fantasy-drawer__stat"><span class="note--dim">Avg</span>${renderStatCell(stats.avg, 1)}</div>
        <div class="fantasy-drawer__stat"><span class="note--dim">Form</span>${renderFormSparkline(stats.form)}</div>
        <div class="fantasy-drawer__stat"><span class="note--dim">xP</span>${renderStatCell(stats.xp, 1)}</div>
        <div class="fantasy-drawer__stat"><span class="note--dim">ADP</span>${renderStatCell(stats.adp, 0)}</div>
      </div>`
    : `<p class="note">More stats coming with live player data.</p>`;

  return `
    <div class="dz fantasy-player-drawer" data-fantasy-player-drawer>
      <div class="dz__scrim" data-fantasy-player-drawer-close></div>
      <div class="dz__panel">
        <div class="dz__bar">
          <span class="dz__tag">Player</span>
          <button class="dz__close" type="button" data-fantasy-player-drawer-close aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>
          </button>
        </div>
        <div class="fantasy-drawer__head">
          ${badgeFor(player.team, "xl")}
          <p class="fantasy-drawer__name">${esc(player.name)}</p>
          <p class="note">${esc(player.team)} · ${esc(player.position)}</p>
          ${pickLabel ? `<span class="chip">Pick ${esc(pickLabel)}</span>` : ""}
        </div>
        <h4>Stats</h4>
        ${statRows}
      </div>
    </div>`;
}

// Top-level My team body for a completed-draft league: pitch + bench in the
// main column, Squad xP in the rail (CSS reflows the rail below on mobile, see
// .fantasy-myteam-grid in styles.css), plus the (usually hidden) player drawer.
// `lineup` is the last loaded/saved GET response; `editState` is the working
// copy while editing (state.fantasy.lineupEdit in app.js) or null when not
// editing - every id array/captainId this function reads comes from editState
// when present, else straight off `lineup`, so there is exactly one source of
// truth for "what the pitch currently shows" at any given moment.
export function renderFantasyRosterPanel({ currentGameweek, roster, lineup, playerPool, picks, editState, drawerPlayerId, lineupError }) {
  if (!lineup) {
    return lineupError
      ? `<div class="card"><p class="fantasy-form__error">${esc(lineupError)}</p><button class="seg" type="button" data-fantasy-lineup-retry>Retry</button></div>`
      : `<p class="note">Loading your lineup…</p>`;
  }

  const statsById = new Map((playerPool ?? []).map((player) => [player.id, player]));
  const starterIds = editState ? editState.starters : lineup.starters.map((entry) => entry.playerId);
  const captainId = editState ? editState.captainId : (lineup.starters.find((entry) => entry.isCaptain)?.playerId ?? null);
  const benchIds = editState ? editState.bench : lineup.bench;

  const pitchCard = `
    <section class="card fantasy-pitch">
      ${renderPitchHead(currentGameweek, lineup, editState)}
      ${renderPitch({ roster, starterIds, benchIds, captainId, editState, statsById })}
    </section>`;

  const drawerPlayer = drawerPlayerId != null ? (roster ?? []).find((player) => player.id === drawerPlayerId) ?? null : null;

  return `
    <div class="fantasy-myteam-grid">
      <div class="fantasy-myteam-grid__main">
        ${pitchCard}
        ${renderBench({ roster, starterIds, benchIds, captainId, editState, statsById })}
      </div>
      <div class="fantasy-myteam-grid__rail">
        ${renderSquadXp({ roster, starterIds, statsById })}
      </div>
    </div>
    ${renderPlayerDrawer(drawerPlayer, { picks, statsById })}`;
}

const POSITION_FILTERS = ["All", "GK", "DEF", "MID", "FWD"];

function filterPlayers(players, filter) {
  const search = (filter?.search ?? "").trim().toLowerCase();
  const club = filter?.club ?? "All";
  return (players ?? []).filter((player) => {
    if (filter?.position && filter.position !== "All" && player.position !== filter.position) return false;
    if (club !== "All" && player.team !== club) return false;
    if (!search) return true;
    return player.name.toLowerCase().includes(search) || player.team.toLowerCase().includes(search);
  });
}

// The available-player rows only: exported separately so app.js can re-render
// just this list on every keystroke/filter change without rebuilding (and
// stealing focus from) the search input above it.
export function renderFantasyPlayerRows(players, filter, context) {
  const filtered = filterPlayers(players, filter);
  if (!filtered.length) return `<p class="note">No players match.</p>`;
  const { isMyTurn, myRoster, draftedIds, suggestedId } = context ?? {};
  return filtered
    .map((player) => {
      const drafted = draftedIds?.has?.(player.id);
      const legal = !drafted && canDraftPlayer(player, { isMyTurn, myRoster, draftedIds });
      const isSuggested = suggestedId != null && player.id === suggestedId;
      const action = legal
        ? `<button class="btn fantasy-draft-btn" type="button" data-fantasy-draft-player="${player.id}">Draft</button>`
        : drafted
          ? `<span class="note--dim">Drafted</span>`
          : "";
      const suggestedBadge = isSuggested ? `<span class="chip fantasy-chip--suggested">Pick</span>` : "";
      const stats = normalizePlayerStats(player);
      return `<div class="fantasy-player-row ${drafted ? "is-drafted" : ""} ${isSuggested ? "is-suggested" : ""}">
          ${badgeFor(player.team)}
          <span class="fantasy-player-row__id"><strong>${esc(player.name)}${suggestedBadge}</strong><span class="note--dim">${esc(abbrFor(player.team))}</span></span>
          <span class="fantasy-pos">${esc(player.position)}</span>
          <span class="fantasy-player-row__stat">${renderStatCell(stats.avg, 1)}</span>
          <span class="fantasy-player-row__stat">${renderFormSparkline(stats.form)}</span>
          <span class="fantasy-player-row__stat">${renderStatCell(stats.xp, 1)}</span>
          <span class="fantasy-player-row__stat">${renderStatCell(stats.adp, 0)}</span>
          <span class="fantasy-player-row__action">${action}</span>
        </div>`;
    })
    .join("");
}

// Distinct clubs represented in the pool, alphabetised: fed straight from the
// player data (never a hardcoded team list, matching the "flows from the feed"
// rule the rest of the app follows for badges/teams).
function renderClubOptions(players, selectedClub) {
  const clubs = [...new Set((players ?? []).map((player) => player.team).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const selected = selectedClub ?? "All";
  const allOption = `<option value="All"${selected === "All" ? " selected" : ""}>All clubs</option>`;
  return (
    allOption +
    clubs.map((club) => `<option value="${esc(club)}"${selected === club ? " selected" : ""}>${esc(club)}</option>`).join("")
  );
}

// Player pool as a data-table card: PLAYER POOL label, position pills, club
// filter and search all live in a sticky header inside the single scrolling
// region, so they stay reachable no matter how far down a 500-row pool you've
// scrolled. Column header row (Player / Pos / action) sits in the same sticky
// block, directly above the rows it labels.
export function renderFantasyPlayerPool(players, filter, context) {
  const activePosition = filter?.position ?? "All";
  const positionPills = POSITION_FILTERS.map(
    (position) =>
      `<button class="seg ${position === activePosition ? "is-active" : ""}" type="button" data-fantasy-position-filter="${position}">${position}</button>`,
  ).join("");

  return `
    <section class="card fantasy-pool">
      <div class="fantasy-pool__scroll">
        <div class="fantasy-pool__sticky">
          <h3 class="card__title">Player pool</h3>
          <div class="fantasy-pool__filters">
            <div class="segrow fantasy-pool__positions">${positionPills}</div>
            <select class="fantasy-select" data-fantasy-club-filter>${renderClubOptions(players, filter?.club)}</select>
            <input class="fantasy-input" type="text" placeholder="Search players or clubs" value="${esc(filter?.search ?? "")}" data-fantasy-search autocomplete="off" />
          </div>
        </div>
        <div class="fantasy-pool__table">
          <div class="fantasy-pool__cols">
            <span></span><span>Player</span><span>Pos</span><span>Avg</span><span>Form</span><span>xP</span><span>ADP</span><span></span>
          </div>
          <div class="fantasy-pool__rows" data-fantasy-pool-list>${renderFantasyPlayerRows(players, filter, context)}</div>
        </div>
      </div>
    </section>`;
}

export function renderFantasyDraftRoom({ members, draft, playerPool, filter, myUserId, season = currentSeasonLabel() }) {
  const myRoster = draft.rosters?.[myUserId] ?? [];
  const draftedIds = new Set(
    Object.values(draft.rosters ?? {})
      .flat()
      .map((player) => player.id),
  );
  const isMyTurn = draft.onClockUserId != null && draft.onClockUserId === myUserId;
  const suggested = suggestedPick(playerPool, myRoster, draftedIds);
  const context = { isMyTurn, myRoster, draftedIds, suggestedId: suggested?.id ?? null };
  const entries = draftOrderEntries(draft.memberIds, draft.round, draft.onClockUserId, draft.overallPick);

  return `
    ${draft.lastError ? renderDraftErrorNotice(draft.lastError) : ""}
    ${renderDraftStatusCard({ members, draft, myUserId, season, entries })}
    <div class="fantasy-draftgrid">
      <div class="fantasy-draftgrid__main">${renderFantasyPlayerPool(playerPool, filter, context)}</div>
      <div class="fantasy-draftgrid__side">
        ${renderSuggestedPickCard(suggested, context)}
        ${renderOnClockCard({ members, draft, myUserId, entries, isMyTurn })}
        <section class="card fantasy-feed-card">
          <h3 class="card__title">Recent picks</h3>
          ${renderPickFeed(draft.picks, members)}
        </section>
        ${renderMySquad(draft.picks, myUserId, { compact: true })}
      </div>
    </div>`;
}

// -- Draft complete --------------------------------------------------------------

// All-rosters view, restyled to the same squad-row card language as Your squad
// (point 6): manager name as the card header, R.PP numbers derived from the
// picks log, POS chips.
export function renderFantasyComplete(members, picks) {
  const groups = (members ?? [])
    .map((member) => {
      const memberPicks = [...(picks ?? [])].filter((pick) => pick.userId === member.userId).sort((a, b) => a.overallPick - b.overallPick);
      const rows = memberPicks
        .map(
          (pick) => `<div class="fantasy-squad-row">
              <span class="fantasy-squad-row__pick">${formatPickNumber(pick.round, pick.pickInRound)}</span>
              ${badgeFor(pick.player.team)}
              <span class="fantasy-squad-row__name"><strong>${esc(pick.player.name)}</strong><span class="note--dim">${esc(abbrFor(pick.player.team))}</span></span>
              <span class="fantasy-pos">${esc(pick.player.position)}</span>
            </div>`,
        )
        .join("");
      return `<section class="card fantasy-roster-card">
          <h3 class="card__title">${esc(member.name)}</h3>
          <div class="fantasy-squad-rows">${rows || `<p class="note">No players.</p>`}</div>
        </section>`;
    })
    .join("");

  return `<div class="fantasy-rosters">${groups}</div>`;
}

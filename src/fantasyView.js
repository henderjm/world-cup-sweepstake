import { badgeFor } from "./badges.js";
import { MAX_LEAGUE_SIZE, SQUAD_SIZE, SQUAD_SLOTS } from "./fantasy.js";
import { canDraftPlayer, draftOrderEntries, formatCountdown, squadBucketCounts } from "./fantasyDraft.js";

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

// -- Lobby (draftStatus: pending) -----------------------------------------------

export function renderFantasyLobby(league, members) {
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
    <div class="fantasy">
      <div class="fantasy-panel-head">
        <button class="seg" type="button" data-fantasy-back>← Leagues</button>
        <h1 class="hero__title">${esc(league.name)}</h1>
      </div>
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
    </div>`;
}

// -- Live draft room (draftStatus: drafting) ------------------------------------

function renderClockBanner(members, onClockUserId, remainingMs, isMyTurn) {
  // onClockUserId is briefly null between a "pick" and its paired "clock"
  // message (see reduceDraftMessage in fantasyDraft.js); a neutral label reads
  // better here than falling back to nameForUser's "Someone".
  const who = onClockUserId == null ? "Next pick…" : isMyTurn ? "Your pick" : `${esc(nameForUser(onClockUserId, members))} is picking`;
  return `
    <div class="fantasy-clock ${isMyTurn ? "is-mine" : ""}">
      <span class="fantasy-clock__who">${who}</span>
      <span class="fantasy-clock__time" data-fantasy-clock>${formatCountdown(remainingMs)}</span>
    </div>`;
}

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

function renderOrderStrip(members, memberIds, round, onClockUserId, overallPick) {
  const entries = draftOrderEntries(memberIds, round, onClockUserId, overallPick);
  return `<div class="fantasy-orderstrip">${entries
    .map((entry) => {
      const cls = entry.isOnClock ? "is-onclock" : entry.isNext ? "is-next" : "";
      const tag = entry.isOnClock ? "On the clock" : entry.isNext ? "Next" : "";
      return `<div class="fantasy-orderchip ${cls}">
          <span class="fantasy-orderchip__name">${esc(nameForUser(entry.userId, members))}</span>
          ${tag ? `<span class="fantasy-orderchip__tag">${tag}</span>` : ""}
        </div>`;
    })
    .join("")}</div>`;
}

function renderPickFeed(picks, members) {
  const recent = [...(picks ?? [])].sort((a, b) => b.overallPick - a.overallPick).slice(0, 20);
  if (!recent.length) return `<p class="note">No picks yet.</p>`;
  return `<div class="fantasy-feed">${recent
    .map(
      (pick) => `<div class="fantasy-feed__row">
        <span class="fantasy-feed__pick">#${pick.overallPick}</span>
        ${badgeFor(pick.player.team)}
        <span class="fantasy-feed__player"><strong>${esc(pick.player.name)}</strong><span class="note--dim">${esc(pick.player.position)} · ${esc(pick.player.team)}</span></span>
        <span class="fantasy-feed__by">${esc(nameForUser(pick.userId, members))}</span>
      </div>`,
    )
    .join("")}</div>`;
}

export function renderMySquad(roster) {
  const buckets = squadBucketCounts(roster);
  const rows = Object.entries(buckets)
    .map(
      ([position, { filled, total }]) => `<div class="fantasy-squadrow">
        <span class="fantasy-squadrow__pos">${position}</span>
        <span class="fantasy-squadrow__count ${filled >= total ? "is-full" : ""}">${filled}/${total}</span>
      </div>`,
    )
    .join("");
  const players = (roster ?? [])
    .map((player) => `<div class="fantasy-squad-player">${badgeFor(player.team)}<span>${esc(player.name)}</span></div>`)
    .join("");
  return `
    <section class="card fantasy-myteam">
      <h3 class="card__title">My squad · ${(roster ?? []).length}/${SQUAD_SIZE}</h3>
      <div class="fantasy-squadrows">${rows}</div>
      ${players ? `<div class="fantasy-squad-players">${players}</div>` : `<p class="note">No players drafted yet.</p>`}
    </section>`;
}

const POSITION_FILTERS = ["All", "GK", "DEF", "MID", "FWD"];

function filterPlayers(players, filter) {
  const search = (filter?.search ?? "").trim().toLowerCase();
  return (players ?? []).filter((player) => {
    if (filter?.position && filter.position !== "All" && player.position !== filter.position) return false;
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
  const { isMyTurn, myRoster, draftedIds } = context ?? {};
  return filtered
    .map((player) => {
      const drafted = draftedIds?.has?.(player.id);
      const legal = !drafted && canDraftPlayer(player, { isMyTurn, myRoster, draftedIds });
      const action = legal
        ? `<button class="btn btn--primary fantasy-draft-btn" type="button" data-fantasy-draft-player="${player.id}">Draft</button>`
        : drafted
          ? `<span class="note--dim">Drafted</span>`
          : "";
      return `<div class="fantasy-player-row ${drafted ? "is-drafted" : ""}">
          ${badgeFor(player.team)}
          <span class="fantasy-player-row__id"><strong>${esc(player.name)}</strong><span class="note--dim">${esc(player.position)} · ${esc(player.team)}</span></span>
          <span class="fantasy-player-row__action">${action}</span>
        </div>`;
    })
    .join("");
}

export function renderFantasyPlayerPool(players, filter, context) {
  return `
    <div class="fantasy-pool">
      <div class="fantasy-pool__controls">
        <div class="segrow">${POSITION_FILTERS.map(
          (position) =>
            `<button class="seg ${position === (filter?.position ?? "All") ? "is-active" : ""}" type="button" data-fantasy-position-filter="${position}">${position}</button>`,
        ).join("")}</div>
        <input class="fantasy-input" type="text" placeholder="Search players or clubs" value="${esc(filter?.search ?? "")}" data-fantasy-search autocomplete="off" />
      </div>
      <div class="fantasy-pool__list" data-fantasy-pool-list>${renderFantasyPlayerRows(players, filter, context)}</div>
    </div>`;
}

export function renderFantasyDraftRoom({ league, members, draft, playerPool, filter, myUserId }) {
  const myRoster = draft.rosters?.[myUserId] ?? [];
  const draftedIds = new Set(
    Object.values(draft.rosters ?? {})
      .flat()
      .map((player) => player.id),
  );
  const isMyTurn = draft.onClockUserId != null && draft.onClockUserId === myUserId;
  const context = { isMyTurn, myRoster, draftedIds };

  return `
    <div class="fantasy fantasy-draftroom">
      <div class="fantasy-panel-head">
        <button class="seg" type="button" data-fantasy-back>← Leagues</button>
        <h1 class="hero__title">${esc(league.name)} · Draft</h1>
      </div>
      ${draft.lastError ? renderDraftErrorNotice(draft.lastError) : ""}
      ${renderClockBanner(members, draft.onClockUserId, draft.remainingMs ?? 0, isMyTurn)}
      ${renderOrderStrip(members, draft.memberIds, draft.round, draft.onClockUserId, draft.overallPick)}
      <div class="fantasy-draftgrid">
        <div class="fantasy-draftgrid__main">${renderFantasyPlayerPool(playerPool, filter, context)}</div>
        <div class="fantasy-draftgrid__side">
          ${renderMySquad(myRoster)}
          <section class="card fantasy-feed-card">
            <h3 class="card__title">Recent picks</h3>
            ${renderPickFeed(draft.picks, members)}
          </section>
        </div>
      </div>
    </div>`;
}

// -- Draft complete --------------------------------------------------------------

export function renderFantasyComplete(league, members, rosters) {
  const groups = (members ?? [])
    .map((member) => {
      const roster = rosters?.[member.userId] ?? [];
      const players = roster
        .map(
          (player) =>
            `<div class="fantasy-squad-player">${badgeFor(player.team)}<span>${esc(player.name)}</span><span class="note--dim">${esc(player.position)}</span></div>`,
        )
        .join("");
      return `<section class="card fantasy-roster-card">
          <h3 class="card__title">${esc(member.name)}</h3>
          <div class="fantasy-squad-players">${players || `<p class="note">No players.</p>`}</div>
        </section>`;
    })
    .join("");

  return `
    <div class="fantasy">
      <div class="fantasy-panel-head">
        <button class="seg" type="button" data-fantasy-back>← Leagues</button>
        <h1 class="hero__title">${esc(league.name)} · Draft complete</h1>
      </div>
      <div class="fantasy-rosters">${groups}</div>
    </div>`;
}

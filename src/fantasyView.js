import { abbrFor, badgeFor } from "./badges.js";
import { dateLabel } from "./format.js";
import { MAX_LEAGUE_SIZE } from "./fantasy.js";
import { squadGameweekShape } from "./fantasyCalendar.js";
import { WAIVER_MODES } from "./fantasyWaivers.js";
import {
  canDraftPlayer,
  currentSeasonLabel,
  draftOrderEntries,
  formatCountdown,
  formatOrdinal,
  formatPickNumber,
  hasPriorSeasonData,
  legalSwapTargets,
  matchupBarWidths,
  matchupLeadSide,
  normalizePlayerStats,
  priorSeasonRangeLabel,
  queueEntries,
  squadBucketCounts,
  suggestedPick,
  suggestedPickReason,
  tierLabel,
  topQueuedPick,
  xpTooltip,
} from "./fantasyDraft.js";
import { DEFAULT_POOL_SORT, POOL_SORTS, rankDraftPool, sortPoolBy, startingUpgrade } from "./fantasyDraftRank.js";
import {
  DEFAULT_SCHEDULE_VIEW,
  SCHEDULE_VIEWS,
  byeNote,
  deadlineBanner,
  isDeadlineSoon,
  matchupTiming,
  scheduleRows,
} from "./fantasyScheduleView.js";
import {
  buildFreeAgentContext,
  buildWaiverPlayerLookup,
  claimStatusLabel,
  claimWindowNote,
  dropCandidates,
  partitionWaiverClaims,
  priorityOrdinalLabel,
  waiverModeExplanation,
  waiverModeLabel,
} from "./fantasyWaiversView.js";
import {
  formatLocalSchedule,
  formatScheduleCountdown,
  isDraftSoon,
  isoToLocalInputValue,
} from "./fantasyScheduling.js";

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

function nameForUser(userId, members) {
  return members?.find((member) => member.userId === userId)?.name ?? "Someone";
}

// A bot manager must be visibly a bot on every surface it appears on, which is
// both an honesty requirement and the product one: the point of filling seats
// is a credible practice league, not a league that looks busier than it is.
// The stored display name already begins with "Bot" (see BOT_SEAT_NAMES in
// src/fantasyBots.js) so the plain-string surfaces are honest on their own;
// this chip is what the structured ones add on top.
const BOT_CHIP = `<span class="chip fantasy-chip--bot" title="A bot manager filling an empty seat: it autopicks and always fields a legal XI">BOT</span>`;

function botChip(isBot) {
  return isBot ? ` ${BOT_CHIP}` : "";
}

function botChipForUser(userId, members) {
  return botChip(Boolean(members?.find((member) => member.userId === userId)?.isBot));
}

// Small four-point sparkle, inline SVG (no external asset) for the suggested-pick
// eyebrow. currentColor so it always matches the purple eyebrow text around it.
const SPARKLE_ICON = `<svg class="fantasy-sparkle" viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M8 0c.4 2.9 1.1 4.6 2.2 5.8C11.4 6.9 13.1 7.6 16 8c-2.9.4-4.6 1.1-5.8 2.2C9.1 11.4 8.4 13.1 8 16c-.4-2.9-1.1-4.6-2.2-5.8C4.6 9.1 2.9 8.4 0 8c2.9-.4 4.6-1.1 5.8-2.2C7 4.6 7.6 2.9 8 0z"/></svg>`;

// Whole number for Apps/Minutes, one decimal for xP; a dim placeholder bullet
// (never a fabricated number) when the value is null - a player with no
// prior-season record, or a pool file that doesn't carry xp yet.
function renderStatCell(value, digits) {
  if (value == null) return `<span class="fantasy-stat fantasy-stat--empty">•</span>`;
  return `<span class="fantasy-stat">${digits == null ? value : value.toFixed(digits)}</span>`;
}

// Small chip for a player's prior-season tier: Starter/Squad/Fringe read as
// plain fact, "New" for a player with no prior-season record at all (a new
// signing or a promoted club's player - genuinely unknown, never zero).
// Empty string when there's nothing to show (see hasPriorSeasonData), so a
// caller can drop it into a row without an extra presence check.
function renderTierChip(tier) {
  const label = tierLabel(tier);
  if (!label) return "";
  return `<span class="chip fantasy-tier-chip fantasy-tier-chip--${esc(tier)}">${esc(label)}</span>`;
}

// Draft-rank cell: "#N" plus a projected-round hint ("R3") when both are
// known, stacked the same compact way as the id cell's name/club. A player
// with no xP anywhere (see fantasyDraftRank.js's rankDraftPool - the whole
// pool is unranked until a real xP bake exists) has nothing to show here: a
// dim placeholder bullet, never a fabricated rank.
function renderRankCell(player) {
  if (player?.draftRank == null) {
    return `<span class="fantasy-player-row__rank fantasy-stat fantasy-stat--empty">•</span>`;
  }
  const round = player.projectedRound != null ? `<span class="note--dim">R${player.projectedRound}</span>` : "";
  return `<span class="fantasy-player-row__rank"><strong>#${player.draftRank}</strong>${round}</span>`;
}

// -- Signed-out / not-configured / error states --------------------------------

// Same card shape as the You section's sign-in prompt; the actual GIS button
// lives in the You section, so this points there rather than duplicating it.
export function renderFantasySignedOut() {
  return `
    <div class="you you--signin">
      <span class="brand__mark you__mark">KD</span>
      <h2 class="you__title">Sign in for Fantasy</h2>
      <p class="note">Create or join a head-to-head draft league with your mates: sign in to get started.</p>
      <button class="seg" type="button" data-section-nav="you">Go to sign in →</button>
      <p class="note--dim">We only use Google to sign you in. No posts, no contacts.</p>
      <button class="btn btn--primary fantasy-signedout__demo" type="button" data-section-nav="demo">Try a draft first, no sign-in needed →</button>
      <p class="note--dim">Draft against bots and see a full season play out in about 5 minutes.</p>
    </div>`;
}

// A revoked/expired session (401 from the fantasy API) is distinct from a
// generic load failure: retrying the same call will just 401 again, so this
// points at the You section's sign-in instead of offering a Retry button.
export function renderFantasySessionExpired() {
  return `
    <div class="you you--signin">
      <span class="brand__mark you__mark">KD</span>
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
      <p class="note">${league.memberCount}/${MAX_LEAGUE_SIZE} manager${league.memberCount === 1 ? "" : "s"}${league.botCount ? ` (${league.botCount} bot${league.botCount === 1 ? "" : "s"})` : ""}${league.isCommissioner ? " · You're commissioner" : ""}</p>
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

// All five sub-tabs are live as of Phase 4.4, except Waivers: free agency and
// waivers only exist once a season's 15-man squads are fixed (draftStatus
// "complete"), so that one button alone stays disabled until then (existing
// .fantasy-subtab[disabled] styling, no separate "Soon" copy needed). The
// active tab's label doubles as the view's display title (see
// renderFantasyLeagueHeader).
const FANTASY_SUBTAB_LABELS = {
  feed: "Feed",
  matchup: "Matchup",
  myteam: "My team",
  draftroom: "Draft room",
  waivers: "Waivers",
  standings: "Standings",
};

// Feed leads the bar, and is where a running league lands by default (see
// defaultFantasySubTab in app.js). League chat hidden behind a corner tab is
// the version managers abandon for WhatsApp; the one that gets used is the one
// they arrive on, where the moves and the talk about them share a timeline.
function renderFantasySubtabs(activeSubTab, waiversEnabled) {
  return `
    <div class="fantasy-subtabs">
      <button class="fantasy-subtab ${activeSubTab === "feed" ? "is-active" : ""}" type="button" data-fantasy-subtab="feed">Feed</button>
      <button class="fantasy-subtab ${activeSubTab === "matchup" ? "is-active" : ""}" type="button" data-fantasy-subtab="matchup">Matchup</button>
      <button class="fantasy-subtab ${activeSubTab === "myteam" ? "is-active" : ""}" type="button" data-fantasy-subtab="myteam">My team</button>
      <button class="fantasy-subtab ${activeSubTab === "draftroom" ? "is-active" : ""}" type="button" data-fantasy-subtab="draftroom">Draft room</button>
      <button class="fantasy-subtab ${activeSubTab === "waivers" ? "is-active" : ""}" type="button" data-fantasy-subtab="waivers" ${waiversEnabled ? "" : "disabled"}>Waivers</button>
      <button class="fantasy-subtab ${activeSubTab === "standings" ? "is-active" : ""}" type="button" data-fantasy-subtab="standings">Standings</button>
    </div>`;
}

// League header: purple uppercase eyebrow ("<LEAGUE NAME> · H2H"), a big italic
// display title tracking whichever sub-tab is active, and a chip row (manager
// count, draft type). Shared by every in-league state (lobby, live draft,
// complete, my team) so switching sub-tabs never reflows the page around it.
export function renderFantasyLeagueHeader(league, members, activeSubTab) {
  const count = (members ?? []).length;
  // Derived from members rather than taking a seat summary parameter, since
  // every caller already passes the member list and a second source for the
  // same number would be one more place to forget. A bare "5 managers" here
  // would imply five people in a league where three of them are bots.
  const bots = (members ?? []).filter((member) => member.isBot).length;
  const managerChip = bots
    ? `${count - bots} manager${count - bots === 1 ? "" : "s"} · ${bots} bot${bots === 1 ? "" : "s"}`
    : `${count} manager${count === 1 ? "" : "s"}`;
  return `
    <div class="fantasy-panel-head">
      <button class="seg" type="button" data-fantasy-back>← Leagues</button>
    </div>
    <div class="fantasy-league-head">
      <p class="fantasy-eyebrow">${esc(league.name)} · H2H</p>
      <h1 class="hero__title">${esc(FANTASY_SUBTAB_LABELS[activeSubTab] ?? "Draft room")}</h1>
      <div class="hero__meta">
        <span class="chip">${esc(managerChip)}</span>
        <span class="chip">Snake draft</span>
      </div>
    </div>
    ${renderFantasySubtabs(activeSubTab, league.draftStatus === "complete")}`;
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

// The squad-deadline banner, shown above the matchup and above the pitch. This
// is the surface the two-hour league-wide deadline needed: a manager cannot act
// on a deadline they have never been told. Pre-season it deliberately shows no
// countdown at all and names the season start instead (see
// src/fantasyScheduleView.js's deadlineBanner, which decides all of this).
//
// `data-fantasy-deadline` carries the raw instant so app.js can re-tick the
// countdown on a timer without a full re-render, exactly how the draft
// schedule's own countdown works.
export function renderSquadDeadlineBanner(source, now = Date.now()) {
  if (!source) return "";
  const { gameweek, deadline = null, locked = false, preseason = false, seasonStart = null } = source;
  const banner = deadlineBanner({ gameweek, deadline, locked, preseason, seasonStart, now });
  const soon = isDeadlineSoon(banner, { deadline, now });

  return `
    <section class="card fantasy-deadline fantasy-deadline--${esc(banner.kind)} ${soon ? "is-soon" : ""}"
      data-fantasy-deadline="${deadline == null ? "" : esc(deadline)}">
      <div class="fantasy-deadline__head">
        <p class="fantasy-deadline__headline">${esc(banner.headline)}</p>
        ${banner.countdown ? `<p class="fantasy-deadline__countdown" data-fantasy-deadline-countdown>${esc(banner.countdown)}</p>` : ""}
      </div>
      <p class="note fantasy-deadline__detail">${esc(banner.detail)}</p>
    </section>`;
}

// Single centerpiece card: gameweek header, a status chip, both managers' names
// and scores side by side with a lead indicator (highlight + comparison bar),
// and a clear bye-week / upcoming state instead of a bare 0-0. `matchup`
// is the raw GET /fantasy/league/:id/matchup response (src/fantasyApi.js) or
// null while the first load for this league is still in flight; `error` is a
// load failure distinct from "not loaded yet", with its own retry control
// (mirrors the lineup card's own retry, see renderFantasyRosterPanel).
//
// Whether scores may be shown at all is matchupTiming's decision, not this
// renderer's: a fixture nobody has played is upcoming, and rendering it as 0-0
// was the reported bug.
export function renderFantasyMatchupPanel(matchup, { error = "", leagueSize = null, now = Date.now() } = {}) {
  if (!matchup) {
    return error
      ? `<div class="card"><p class="fantasy-form__error">${esc(error)}</p><button class="seg" type="button" data-fantasy-matchup-retry>Retry</button></div>`
      : `<p class="note">Loading your matchup…</p>`;
  }

  const { gameweek, status, me, opponent } = matchup;
  const timing = matchupTiming(matchup, now);
  const banner = renderSquadDeadlineBanner(matchup, now);

  if (!opponent) {
    return `
      ${banner}
      <section class="card fantasy-matchup fantasy-matchup--bye">
        <p class="fantasy-eyebrow">Gameweek ${esc(gameweek)}</p>
        <h2 class="fantasy-matchup__bye-title">You have a bye</h2>
        <p class="note">${esc(byeNote(gameweek, leagueSize))}</p>
      </section>`;
  }

  // A not-yet-started matchup shows a dim placeholder bullet instead of its
  // 0-0 (the same convention normalizePlayerStats/renderStatCell already use
  // for "no real number yet") and skips the lead bar entirely.
  const { showScores } = timing;
  const leader = showScores ? matchupLeadSide(me.score, opponent.score) : "tied";
  const widths = showScores ? matchupBarWidths(me.score, opponent.score) : null;

  return `
    ${banner}
    <section class="card fantasy-matchup">
      <div class="fantasy-matchup__head">
        <p class="fantasy-eyebrow">Gameweek ${esc(gameweek)}</p>
        <span class="chip fantasy-status-chip fantasy-status-chip--${esc(status)}">${esc(timing.label)}</span>
      </div>
      <div class="fantasy-matchup__row">
        <div class="fantasy-matchup__side ${leader === "me" ? "is-ahead" : ""}">
          <p class="fantasy-matchup__name">${esc(me.name)}</p>
          <p class="fantasy-matchup__score">${showScores ? esc(me.score) : `<span class="fantasy-stat--empty">•</span>`}</p>
        </div>
        <span class="fantasy-matchup__vs">vs</span>
        <div class="fantasy-matchup__side fantasy-matchup__side--opponent ${leader === "opponent" ? "is-ahead" : ""}">
          <p class="fantasy-matchup__name">${esc(opponent.name)}${botChip(opponent.isBot)}</p>
          <p class="fantasy-matchup__score">${showScores ? esc(opponent.score) : `<span class="fantasy-stat--empty">•</span>`}</p>
        </div>
      </div>
      ${
        showScores
          ? `<div class="fantasy-matchup__bar"><span class="fantasy-matchup__bar-me" style="width:${widths.me}%"></span><span class="fantasy-matchup__bar-opp" style="width:${widths.opponent}%"></span></div>`
          : `<p class="note fantasy-matchup__pending">${esc(timing.note)}</p>`
      }
    </section>`;
}

// -- The league's season schedule ------------------------------------------------
//
// The concrete missing feature: 38 gameweeks of fixtures existed from the
// moment the draft completed and there was nowhere in the product to read
// them. Rendered under the matchup card rather than as a seventh sub-tab: the
// tab bar is already six wide and cramped at 375px, and the season schedule is
// the natural context for "who am I playing".
//
// One row per gameweek so it stays readable on a phone, rather than a table
// that needs horizontal scrolling.
function renderScheduleFixture(fixture, myUserId) {
  const { home, away, homeScore, awayScore, played } = fixture;
  const homeMine = home.userId === myUserId;
  const awayMine = away.userId === myUserId;
  const homeWon = played && homeScore > awayScore;
  const awayWon = played && awayScore > homeScore;
  const score = played
    ? `<span class="fantasy-sched-fixture__score">${esc(formatScheduleScore(homeScore))}<span class="fantasy-sched-fixture__dash">-</span>${esc(formatScheduleScore(awayScore))}</span>`
    : `<span class="fantasy-sched-fixture__score fantasy-stat--empty">v</span>`;

  return `<div class="fantasy-sched-fixture">
      <span class="fantasy-sched-fixture__side ${homeMine ? "is-me" : ""} ${homeWon ? "is-won" : ""}">${esc(home.name)}${botChip(home.isBot)}</span>
      ${score}
      <span class="fantasy-sched-fixture__side fantasy-sched-fixture__side--away ${awayMine ? "is-me" : ""} ${awayWon ? "is-won" : ""}">${esc(away.name)}${botChip(away.isBot)}</span>
    </div>`;
}

// Scores are REAL (fantasy points carry a decimal), so a whole number renders
// without a pointless ".0" while 61.5 keeps its half point.
function formatScheduleScore(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function renderScheduleWeek(row, myUserId) {
  const classes = ["fantasy-sched-week"];
  if (row.isCurrent) classes.push("is-current");
  if (row.isPast) classes.push("is-past");

  // A bye is stated plainly and by name. This is the manager who currently
  // sees nothing at all.
  const byes = row.byes.length
    ? `<p class="fantasy-sched-week__bye">${row.myBye ? "You have a bye" : `${esc(row.byes.map((bye) => bye.name).join(", "))} ${row.byes.length === 1 ? "has" : "have"} a bye`}</p>`
    : "";

  return `<div class="${classes.join(" ")}" data-fantasy-sched-gw="${esc(row.gameweek)}">
      <div class="fantasy-sched-week__head">
        <span class="fantasy-sched-week__gw">GW ${esc(row.gameweek)}</span>
        ${row.isCurrent ? `<span class="chip fantasy-sched-week__now">Now</span>` : ""}
        ${row.kickoff != null ? `<span class="fantasy-sched-week__when">${esc(formatLocalSchedule(row.kickoff))}</span>` : ""}
      </div>
      ${row.fixtures.map((fixture) => renderScheduleFixture(fixture, myUserId)).join("")}
      ${byes}
    </div>`;
}

// `schedule` is the raw GET /fantasy/league/:id/schedule response, or null
// while the first load is in flight. `view` is "mine" | "all" (see
// SCHEDULE_VIEWS), kept in app.js state like every other in-panel control.
export function renderFantasySchedulePanel(schedule, { error = "", myUserId, view = DEFAULT_SCHEDULE_VIEW } = {}) {
  if (!schedule) {
    return error
      ? `<div class="card"><p class="fantasy-form__error">${esc(error)}</p><button class="seg" type="button" data-fantasy-schedule-retry>Retry</button></div>`
      : `<p class="note">Loading the season schedule…</p>`;
  }

  const rows = scheduleRows(schedule, { myUserId, view });
  const pills = SCHEDULE_VIEWS.map(
    ([key, label]) =>
      `<button class="seg ${key === view ? "is-active" : ""}" type="button" data-fantasy-schedule-view="${key}">${label}</button>`,
  ).join("");

  return `
    <section class="card fantasy-sched">
      <div class="fantasy-sched__head">
        <h3 class="card__title">Season schedule</h3>
        <div class="segrow">${pills}</div>
      </div>
      <div class="fantasy-sched__weeks">
        ${rows.length ? rows.map((row) => renderScheduleWeek(row, myUserId)).join("") : `<p class="note">No fixtures to show.</p>`}
      </div>
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
          <span class="fantasy-standings-row__name">${esc(row.name)}${botChip(row.isBot)}${isMe ? ` <span class="note--dim">(you)</span>` : ""}</span>
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
function renderScoutingSection(playerPool, filter, queuedIds, leagueSize) {
  if (!playerPool) {
    return `<section class="card"><h3 class="card__title">Player pool</h3><p class="note">Loading player pool…</p></section>`;
  }
  if (playerPool.unavailable || !(playerPool.players ?? []).length) {
    return `<section class="card"><h3 class="card__title">Player pool</h3><p class="note">Player pool not available yet.</p></section>`;
  }
  return `
    ${renderPoolMeta(playerPool)}
    ${renderFantasyPlayerPool(playerPool.players, filter, { isMyTurn: false, myRoster: [], draftedIds: new Set(), queuedIds, leagueSize }, playerPool.priorSeasonStats)}`;
}

// Bot seats: the commissioner's answer to "we only ever found five people".
// Deliberately states in plain words what a bot does and does not do before
// asking anyone to add one, and never appears once the draft has started (a
// seat cannot be filled after the snake order is set).
function renderBotFillCard(league, members, seats, { botBusy = false, botError = "" } = {}) {
  if (!league.isCommissioner) {
    return seats.bots
      ? `<section class="card fantasy-bots">
          <h3 class="card__title">Bot managers</h3>
          <p class="note">${seats.bots} of the ${seats.total} seats ${seats.bots === 1 ? "is" : "are"} filled by a bot manager. Bots autopick their squad and always field a legal XI. They are labelled everywhere they appear.</p>
        </section>`
      : "";
  }

  const options = Array.from({ length: Math.min(seats.open, MAX_LEAGUE_SIZE) }, (_, i) => i + 1)
    .map((n) => `<option value="${n}">${n} bot${n === 1 ? "" : "s"}</option>`)
    .join("");

  const removable = seats.bots
    ? `<div class="fantasy-bots__list">${(members ?? [])
        .filter((member) => member.isBot)
        .map(
          (bot) => `<div class="fantasy-bots__row">
            <span>${esc(bot.name)}${BOT_CHIP}</span>
            <button class="seg" type="button" data-fantasy-remove-bot="${bot.userId}" ${botBusy ? "disabled" : ""}>Remove</button>
          </div>`,
        )
        .join("")}</div>`
    : "";

  return `
    <section class="card fantasy-bots">
      <h3 class="card__title">Fill empty seats with bots</h3>
      <p class="note">A draft league needs a full room. Rather than wait for people who may never join, fill the spare seats with bot managers and draft on schedule. A bot autopicks its squad when its clock runs out and always fields a legal XI, and it is labelled as a bot everywhere it appears, so nobody is ever misled into thinking they are playing a person.</p>
      ${
        seats.open
          ? `<div class="fantasy-bots__form">
              <select class="fantasy-input fantasy-bots__select" data-fantasy-bot-count ${botBusy ? "disabled" : ""}>${options}</select>
              <button class="btn btn--primary" type="button" data-fantasy-add-bots ${botBusy ? "disabled" : ""}>${botBusy ? "Adding…" : "Add bots"}</button>
            </div>
            <p class="note--dim">${seats.open} seat${seats.open === 1 ? "" : "s"} still open.</p>`
          : `<p class="note--dim">Every seat is taken.</p>`
      }
      ${removable}
      ${botError ? `<p class="note fantasy-form__error">${esc(botError)}</p>` : ""}
    </section>`;
}

export function renderFantasyLobby(
  league,
  members,
  {
    playerPool,
    filter,
    schedule,
    scheduleBusy = false,
    scheduleError = "",
    queuedIds,
    seats,
    inviteUrl = "",
    botBusy = false,
    botError = "",
  } = {},
) {
  const sorted = [...members].sort(
    (a, b) => (a.draftPosition ?? 999) - (b.draftPosition ?? 999) || a.name.localeCompare(b.name),
  );
  const rows = sorted
    .map(
      (member, index) => `<div class="fantasy-member-row">
        <span class="fantasy-member-row__pos">${member.draftPosition ?? index + 1}</span>
        <span class="fantasy-member-row__name">${esc(member.name)}${botChip(member.isBot)}${member.userId === league.commissionerUserId ? ` <span class="note--dim">(commissioner)</span>` : ""}</span>
      </div>`,
    )
    .join("");

  const canStart = members.length >= 2;
  const startControl = league.isCommissioner
    ? `<button class="btn btn--primary" type="button" data-fantasy-start-draft ${canStart ? "" : "disabled"}>Start draft</button>
       ${canStart ? "" : `<p class="note">Need at least 2 managers to start. Fill a seat with a bot if nobody else is coming.</p>`}`
    : `<p class="note">Waiting for the commissioner to start the draft.</p>`;

  // Never a bare total: a "6 managers" heading that quietly counts four bots
  // is exactly the implied-real-person number this feature must not produce.
  const seatLine = seats?.bots
    ? `${seats.humans} manager${seats.humans === 1 ? "" : "s"} · ${seats.bots} bot${seats.bots === 1 ? "" : "s"} · ${members.length}/${MAX_LEAGUE_SIZE} seats`
    : `${members.length}/${MAX_LEAGUE_SIZE}`;

  return `
    <section class="card">
      <h3 class="card__title">Managers · ${esc(seatLine)}</h3>
      <div class="fantasy-members">${rows}</div>
    </section>
    ${renderInviteCard(league, inviteUrl)}
    ${renderBotFillCard(league, sorted, seats ?? { total: members.length, humans: members.length, bots: 0, open: Math.max(0, MAX_LEAGUE_SIZE - members.length) }, { botBusy, botError })}
    ${renderFantasyScheduleCard(league, schedule, { scheduleBusy, scheduleError })}
    <section class="card fantasy-start">${startControl}</section>
    ${renderScoutingSection(playerPool, filter ?? { position: "All", club: "All", search: "", hideTaken: true }, queuedIds, members.length)}`;
}

// A LINK first, the raw code second. A code alone asks the recipient to find
// the app, find the Fantasy tab, sign in and then paste something; the link
// lands them on a page that shows the league and asks for the sign-in last
// (see renderFantasyInvitePreview). The code stays because it still works and
// because a link is awkward to read out loud.
function renderInviteCard(league, inviteUrl) {
  return `
    <section class="card fantasy-invite">
      <h3 class="card__title">Invite your mates</h3>
      ${
        inviteUrl
          ? `<div class="fantasy-invite__row">
              <code class="fantasy-invite__link">${esc(inviteUrl)}</code>
              <button class="btn btn--primary" type="button" data-fantasy-copy-invite="${esc(inviteUrl)}">Copy link</button>
            </div>
            <p class="note">Anyone opening this link sees the league before being asked to sign in.</p>`
          : ""
      }
      <div class="fantasy-invite__row fantasy-invite__row--code">
        <code class="fantasy-invite__code">${esc(league.inviteCode)}</code>
        <button class="seg" type="button" data-fantasy-copy-invite="${esc(league.inviteCode)}">Copy code</button>
      </div>
      <p class="note--dim">Or share the code on its own. Either works until the draft starts.</p>
    </section>`;
}

// -- Public invite preview (#join/<code>, signed out) ----------------------------
//
// The whole point of this screen is that it renders with NO session: what the
// league is, who is already in it and how many seats are left, with the
// sign-in as the last step rather than the first. `preview` is the raw GET
// /fantasy/invite/:code response, or null while the first fetch is in flight.
export function renderFantasyInvitePreview(preview, { loading, error, signedIn, joining, joinError } = {}) {
  if (loading || (!preview && !error)) {
    return `<div class="fantasy fantasy-invitepage"><p class="note">Loading invite…</p></div>`;
  }
  if (error) {
    return `
      <div class="fantasy fantasy-invitepage">
        <div class="pending">
          <p class="hero__eyebrow">Invite</p>
          <h1 class="hero__title">This invite doesn't work</h1>
          <p class="note">${esc(error)}</p>
          <div class="hero__meta"><button class="seg" type="button" data-section-nav="fantasy">Go to Fantasy</button></div>
        </div>
      </div>`;
  }

  const { league, managers } = preview;
  const seats = league.seats;
  const roster = (managers ?? [])
    .map(
      (manager) => `<div class="fantasy-member-row">
        <span class="fantasy-member-row__name">${esc(manager.name)}${botChip(manager.isBot)}${manager.isCommissioner ? ` <span class="note--dim">(commissioner)</span>` : ""}</span>
      </div>`,
    )
    .join("");

  const action = !league.joinable
    ? `<p class="note">${league.draftStatus === "pending" ? "This league is full." : "This league has already started its draft, so it can't take new managers."}</p>`
    : signedIn
      ? `<button class="btn btn--primary" type="button" data-fantasy-invite-join ${joining ? "disabled" : ""}>${joining ? "Joining…" : "Join this league"}</button>`
      : `<div class="fantasy-invitepage__signin" id="gisButton"></div>
         <p class="note--dim">Sign in with Google and you'll be dropped straight into the league. We only use Google to sign you in. No posts, no contacts.</p>`;

  return `
    <div class="fantasy fantasy-invitepage">
      <div class="hero__head">
        <div class="hero__lead">
          <p class="hero__eyebrow">You've been invited</p>
          <h1 class="hero__title">${esc(league.name)}</h1>
        </div>
      </div>
      <div class="hero__meta">
        <span class="chip">Head-to-head</span>
        <span class="chip">Snake draft</span>
        <span class="chip">15-player squads</span>
      </div>
      <section class="card fantasy-invitepage__what">
        <h3 class="card__title">What you're joining</h3>
        <p class="note">A head-to-head fantasy Premier League draft: every manager drafts their own 15-player squad in a live snake draft, nobody can own the same player twice, and you play one manager head to head each gameweek across the season.</p>
      </section>
      <section class="card">
        <h3 class="card__title">Managers · ${seats.humans}${seats.bots ? ` + ${seats.bots} bot${seats.bots === 1 ? "" : "s"}` : ""} · ${seats.open} seat${seats.open === 1 ? "" : "s"} open</h3>
        <div class="fantasy-members">${roster || `<p class="note">Nobody has joined yet. You'd be first.</p>`}</div>
      </section>
      <section class="card fantasy-invitepage__cta">
        ${action}
        ${joinError ? `<p class="note fantasy-form__error">${esc(joinError)}</p>` : ""}
      </section>
    </div>`;
}

// Draft scheduling card: a commissioner can pick/reschedule/clear a start
// time while the draft is still pending; everyone else sees the same time
// read-only, converted to their own local timezone (the stored value is
// always UTC - see src/fantasyScheduling.js), plus a countdown that
// app.js's updateFantasyScheduleCountdownDisplay keeps ticking without a
// full re-render (data-fantasy-schedule-countdown carries the raw ISO value
// for that timer to recompute from).
function renderFantasyScheduleCard(league, schedule, { scheduleBusy, scheduleError }) {
  const errorLine = scheduleError ? `<p class="fantasy-form__error">${esc(scheduleError)}</p>` : "";

  if (schedule?.scheduledAt) {
    const remainingMs = new Date(schedule.scheduledAt).getTime() - Date.now();
    const soon = isDraftSoon(remainingMs);
    const commissionerControls = league.isCommissioner
      ? `<div class="fantasy-schedule__form">
          <input type="datetime-local" class="fantasy-schedule__input" data-fantasy-schedule-input value="${esc(isoToLocalInputValue(schedule.scheduledAt))}" />
          <button class="btn" type="button" data-fantasy-schedule-save ${scheduleBusy ? "disabled" : ""}>Reschedule</button>
          <button class="seg" type="button" data-fantasy-schedule-clear ${scheduleBusy ? "disabled" : ""}>Clear</button>
        </div>`
      : `<p class="note">If you miss it, your squad will be auto-picked from the players still available.</p>`;
    return `
    <section class="card fantasy-schedule ${soon ? "is-soon" : ""}">
      <h3 class="card__title">Draft scheduled</h3>
      <p class="fantasy-schedule__when">${esc(formatLocalSchedule(schedule.scheduledAt))} <span class="note--dim">(your local time)</span></p>
      <p class="fantasy-schedule__countdown" data-fantasy-schedule-countdown data-scheduled-at="${esc(schedule.scheduledAt)}">${esc(formatScheduleCountdown(remainingMs))}</p>
      ${commissionerControls}
      ${errorLine}
    </section>`;
  }

  if (!league.isCommissioner) {
    return `
    <section class="card fantasy-schedule">
      <h3 class="card__title">Draft schedule</h3>
      <p class="note">The commissioner hasn't scheduled the draft yet.</p>
    </section>`;
  }

  return `
    <section class="card fantasy-schedule">
      <h3 class="card__title">Schedule the draft</h3>
      <p class="note">Pick a date and time so everyone shows up, instead of drafting the moment you click Start.</p>
      <div class="fantasy-schedule__form">
        <input type="datetime-local" class="fantasy-schedule__input" data-fantasy-schedule-input />
        <button class="btn btn--primary" type="button" data-fantasy-schedule-save ${scheduleBusy ? "disabled" : ""}>Schedule draft</button>
      </div>
      ${errorLine}
    </section>`;
}

// -- Live draft room (draftStatus: drafting) ------------------------------------

// A transient server-pushed {type:"error"} (e.g. a stale/duplicate pick
// attempt): stashed on draft.lastError by reduceDraftMessage, cleared
// automatically on the next pick/clock message, and dismissable by hand via
// data-fantasy-dismiss-error. Styled with existing classes only (no new CSS
// added here): the card shell plus the same error-red text style the create/
// join forms already use.
export function renderDraftErrorNotice(message) {
  return `<div class="card" role="alert" style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
      <p class="fantasy-form__error" style="margin:0;">${esc(message)}</p>
      <button class="seg" type="button" data-fantasy-dismiss-error>Dismiss</button>
    </div>`;
}

// Draft status card: "SNAKE DRAFT · <season>" eyebrow, and "Round R · Pick N"
// on the SAME row as the manager chip strip (headline left, chips right,
// wrapping below only at narrow widths) - the countdown itself lives in its own
// On the clock card now (see renderOnClockCard), not here.
export function renderDraftStatusCard({ members, draft, myUserId, season, entries }) {
  const { round, overallPick } = draft;
  const chips = entries
    .map((entry) => {
      const isMe = entry.userId === myUserId;
      return `<div class="fantasy-orderchip ${entry.isOnClock ? "is-onclock" : ""}">
          ${esc(nameForUser(entry.userId, members))}${botChipForUser(entry.userId, members)}${isMe ? ` <span class="fantasy-orderchip__you">(you)</span>` : ""}
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
  // remainingMs is null only for the demo's untimed pick clock (see
  // scheduleDemoTurn in app.js): a real draft room's clock is always a
  // number, since worker/draftRoom.js always runs a 60s alarm.
  const clockLabel = remainingMs == null ? "No clock" : formatCountdown(remainingMs);
  const onClockIsBot = onClockUserId != null && Boolean(members?.find((m) => m.userId === onClockUserId)?.isBot);
  let context = "";
  if (isMyTurn) {
    context = "You're on the clock.";
  } else if (onClockIsBot) {
    // Said out loud rather than left to the chip: somebody watching a clock
    // tick down should know nobody is deliberating, the app is.
    context = `${esc(nameForUser(onClockUserId, members))} is a bot manager. It autopicks in a few seconds.`;
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
        <h2 class="fantasy-onclock__name">${esc(name)}${onClockIsBot ? botChip(true) : ""}</h2>
        <span class="fantasy-onclock__time" data-fantasy-clock>${esc(clockLabel)}</span>
      </div>
      <p class="fantasy-onclock__context">${context}</p>
    </section>`;
}

// Suggested pick: a purple-tinted card naming the player who would be taken
// right now, either the top still-available player from the manager's own
// queue (fromQueue: true - see topQueuedPick in fantasyDraft.js, checked
// first so a manager's own shortlist always outranks the generic heuristic),
// or, when the queue is empty or has nothing legal left in it, the
// deterministic autoPick heuristic (src/draftLogic.js, via suggestedPick in
// fantasyDraft.js) - the same scarcest-bucket-first rule the server falls
// back to on a timeout. The Draft button uses the exact same gating as a
// pool row (my turn, legal pick), so it never offers an action the pool
// itself would refuse.
function renderSuggestedPickCard(player, context, fromQueue = false) {
  if (!player) return "";
  const legal = Boolean(context?.isMyTurn) && canDraftPlayer(player, context);
  const action = legal
    ? `<button class="btn fantasy-draft-btn" type="button" data-fantasy-draft-player="${player.id}">Draft</button>`
    : "";
  const reason = fromQueue ? "Next up in your queue." : suggestedPickReason(player, context?.myRoster);
  const eyebrow = fromQueue ? "Your queue suggests" : "Squad suggests";
  return `
    <section class="card fantasy-suggest">
      <p class="fantasy-eyebrow">${SPARKLE_ICON} ${eyebrow}</p>
      <div class="fantasy-suggest__row">
        ${badgeFor(player.team)}
        <span class="fantasy-suggest__name"><strong>${esc(player.name)}</strong></span>
        <span class="chip fantasy-suggest__chip">${esc(player.position)} · ${esc(abbrFor(player.team))}</span>
      </div>
      <p class="fantasy-suggest__reason">${esc(reason)}</p>
      ${action}
    </section>`;
}

// `pick.viaQueue` (set by the Durable Object's alarm autopick when it drafted
// from the on-clock manager's own shortlist rather than the generic
// scarcest-bucket fallback - see worker/draftRoom.js's alarm, and the demo's
// mirrored startDemoHumanClock in app.js) gets its own small badge so this
// never reads as a random autopick: a manager whose clock expired should
// recognise their own queue's work in the feed, not wonder why a stranger's
// heuristic happened to agree with them.
function renderPickFeed(picks, members) {
  const recent = [...(picks ?? [])].sort((a, b) => b.overallPick - a.overallPick).slice(0, 20);
  if (!recent.length) return `<p class="note">No picks yet.</p>`;
  return `<div class="fantasy-feed">${recent
    .map(
      (pick) => `<div class="fantasy-feed__row">
        <span class="fantasy-feed__pick">${formatPickNumber(pick.round, pick.pickInRound)}</span>
        ${badgeFor(pick.player.team)}
        <span class="fantasy-feed__player"><strong>${esc(pick.player.name)}</strong><span class="note--dim">${esc(pick.player.position)} · ${esc(abbrFor(pick.player.team))}</span></span>
        <span class="fantasy-feed__by">${esc(nameForUser(pick.userId, members))}${botChipForUser(pick.userId, members)}${pick.viaQueue ? ` <span class="chip fantasy-chip--queue" title="Autopicked from this manager's own queue">Queue</span>` : ""}</span>
      </div>`,
    )
    .join("")}</div>`;
}

// Personal pick queue: a manager's own ordered shortlist (fantasyDraft.js's
// addToQueue/removeFromQueue/moveQueueItem/queueEntries/topQueuedPick - this
// card is purely a view over that pure client-side state, never sent to the
// server). A queued player taken by someone else stays in the list, struck
// through and marked "Gone" rather than disappearing, so a manager can see
// what they lost and clear it deliberately instead of wondering where it
// went; up/down buttons (not drag-and-drop - more reliable on mobile) reorder
// it, and each entry has its own remove button alongside a bulk "Clear".
function renderFantasyQueueCard(queue, playerPool, draftedIds) {
  const entries = queueEntries(queue, playerPool, draftedIds).filter((entry) => entry.player);
  const rows = entries
    .map((entry, index) => {
      const player = entry.player;
      const classes = ["fantasy-queue-row"];
      if (!entry.available) classes.push("is-gone");
      return `<div class="${classes.join(" ")}">
          ${badgeFor(player.team)}
          <span class="fantasy-queue-row__name"><strong>${esc(player.name)}</strong><span class="note--dim">${esc(abbrFor(player.team))}</span></span>
          <span class="fantasy-pos">${esc(player.position)}</span>
          <span class="fantasy-queue-row__status">${entry.available ? "" : "Gone"}</span>
          <div class="fantasy-queue-row__actions">
            <button class="fantasy-queue-btn" type="button" data-fantasy-queue-up="${player.id}" ${index === 0 ? "disabled" : ""} aria-label="Move up in queue">▲</button>
            <button class="fantasy-queue-btn" type="button" data-fantasy-queue-down="${player.id}" ${index === entries.length - 1 ? "disabled" : ""} aria-label="Move down in queue">▼</button>
            <button class="fantasy-queue-btn fantasy-queue-btn--remove" type="button" data-fantasy-queue-remove="${player.id}" aria-label="Remove ${esc(player.name)} from queue">✕</button>
          </div>
        </div>`;
    })
    .join("");
  return `
    <section class="card fantasy-queue-card">
      <div class="fantasy-queue-card__head">
        <h3 class="card__title">Your queue</h3>
        ${entries.length ? `<button class="seg" type="button" data-fantasy-queue-clear>Clear</button>` : ""}
      </div>
      <div class="fantasy-queue-rows">${rows || `<p class="note">Star players in the pool below to queue them up.</p>`}</div>
    </section>`;
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

// A "measured" xP (history/blended) reads plain; an "estimate" gets its own
// modifier class (never invents a new visual language - reuses the existing
// xp token color, just dimmed/italicised, see .is-estimate in styles.css) and
// a title naming it a projection, so a manager can never mistake a cohort
// guess for this player's own record. `xpStats` is the pool's own xpStats
// header (data/PL/players.json), used only to name which seasons a measured
// figure came from.
function xpBadge(stats, position, xpStats) {
  if (stats.xp == null) return { text: "xP •", cls: "is-empty", title: "" };
  const cls = stats.xpBasis === "estimate" ? "is-estimate" : "";
  const title = xpTooltip(stats.xpBasis, { seasons: xpStats?.seasons, position });
  return { text: `xP ${stats.xp.toFixed(1)}`, cls, title };
}

function renderPitchTile(player, { isCaptain, isPending, isDimmed, editing }, statsById, xpStats) {
  const stats = normalizePlayerStats(statsById.get(player.id) ?? {});
  const badge = xpBadge(stats, player.position, xpStats);
  const classes = ["fantasy-pitch__player"];
  if (isPending) classes.push("is-pending");
  if (isDimmed) classes.push("is-dimmed");
  return `
    <div class="${classes.join(" ")}" data-fantasy-player-id="${player.id}" data-fantasy-slot="starter" role="button" tabindex="0">
      ${isCaptain ? `<span class="fantasy-pitch__capbadge" aria-label="Captain">C</span>` : ""}
      <span class="fantasy-pitch__crest">${badgeFor(player.team)}</span>
      <p class="fantasy-pitch__name">${esc(player.name)}</p>
      <p class="fantasy-pitch__club">${esc(abbrFor(player.team))}</p>
      <p class="fantasy-pitch__xp ${badge.cls}" ${badge.title ? `title="${esc(badge.title)}" aria-label="${esc(badge.title)}"` : ""}>${badge.text}</p>
      ${editing && isPending ? `<button class="fantasy-pitch__captainbtn" type="button" data-fantasy-make-captain="${player.id}">Make captain</button>` : ""}
    </div>`;
}

function renderPitch({ roster, starterIds, benchIds, captainId, editState, statsById, xpStats }) {
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
          xpStats,
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

// A gameweek is a window of time, so a club can play twice inside it (a
// postponed fixture replayed on top of the week's own) or not at all. Both are
// normal fantasy football, and both look like a bug to a manager who is not
// told: a blank club's players simply return zero. Named at squad level rather
// than per tile, since the fact is about the CLUB and repeating it on eleven
// player badges would say nothing extra.
function renderFixtureShapeNote(roster, clubFixtures) {
  const { blankTeams, doubleTeams } = squadGameweekShape(roster, clubFixtures);
  const parts = [];
  if (doubleTeams.length) parts.push(`${doubleTeams.map((team) => esc(team)).join(", ")} play twice`);
  if (blankTeams.length) parts.push(`${blankTeams.map((team) => esc(team)).join(", ")} have no fixture`);
  if (!parts.length) return "";
  return `<p class="note fantasy-lineup-note">This gameweek: ${parts.join("; ")}.</p>`;
}

function renderPitchHead(currentGameweek, lineup, editState, roster) {
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
        ${renderFixtureShapeNote(roster, lineup?.clubFixtures)}
      </div>
      ${controls}
    </div>
    ${editState?.error ? `<p class="fantasy-form__error">${esc(editState.error)}</p>` : ""}`;
}

function renderBenchRow(player, { isPending, isDimmed }, statsById, xpStats) {
  const stats = normalizePlayerStats(statsById.get(player.id) ?? {});
  const badge = xpBadge(stats, player.position, xpStats);
  const xpCell =
    stats.xp != null
      ? `<span class="fantasy-bench-row__xp ${badge.cls}" ${badge.title ? `title="${esc(badge.title)}" aria-label="${esc(badge.title)}"` : ""}>${badge.text}</span>`
      : renderStatCell(null);
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

function renderBench({ roster, starterIds, benchIds, captainId, editState, statsById, xpStats }) {
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
        xpStats,
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
function renderSquadXp({ roster, starterIds, statsById, xpStats }) {
  const byId = new Map(roster.map((player) => [player.id, player]));
  const entries = starterIds
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((player) => ({ player, stats: normalizePlayerStats(statsById.get(player.id) ?? {}) }));
  const maxXp = Math.max(0.0001, ...entries.map((entry) => entry.stats.xp ?? 0));
  const hasAny = entries.some((entry) => entry.stats.xp != null);

  const rows = entries
    .map(({ player, stats }) => {
      const { xp } = stats;
      const width = xp != null ? `${Math.max(4, Math.round((xp / maxXp) * 100))}%` : "0%";
      const badge = xpBadge(stats, player.position, xpStats);
      const value =
        xp != null
          ? `<span class="fantasy-squadxp__value ${badge.cls}" ${badge.title ? `title="${esc(badge.title)}" aria-label="${esc(badge.title)}"` : ""}>${xp.toFixed(1)}</span>`
          : `<span class="fantasy-squadxp__value fantasy-stat--empty">•</span>`;
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
// in `picks` but a player is only ever on one roster), the prior-season Tier/
// Apps/Minutes when the pool has that enrichment, and xP (data/PL/players.json's
// baked expected points, see src/fantasyExpectedPoints.js) with a tooltip
// naming its basis - which seasons for a measured figure, or that it's a
// same-position projection for an estimate (see xpTooltip). Always rendered
// (hidden when no player is open) so app.js can toggle it by re-rendering the
// panel rather than managing a second piece of imperative DOM state.
function renderPlayerDrawer(player, { picks, statsById, priorSeasonStats, xpStats }) {
  if (!player) return `<div class="dz fantasy-player-drawer" data-fantasy-player-drawer hidden></div>`;

  const pick = (picks ?? []).find((entry) => entry.player?.id === player.id);
  const pickLabel = pick ? formatPickNumber(pick.round, pick.pickInRound) : null;
  const source = statsById.get(player.id) ?? {};
  const stats = normalizePlayerStats(source);
  const enriched = hasPriorSeasonData([source]);
  const hasStats = enriched || stats.xp != null;
  const xpBadgeInfo = xpBadge(stats, player.position, xpStats);

  const seasonNote =
    enriched && priorSeasonStats?.season
      ? `<p class="note--dim">Appearances and minutes are from last season (${esc(priorSeasonRangeLabel(priorSeasonStats.season))}).</p>`
      : "";

  const xpCell =
    stats.xp != null
      ? `<span class="fantasy-stat ${xpBadgeInfo.cls}" ${xpBadgeInfo.title ? `title="${esc(xpBadgeInfo.title)}" aria-label="${esc(xpBadgeInfo.title)}"` : ""}>${stats.xp.toFixed(1)}</span>`
      : renderStatCell(null);

  const statRows = hasStats
    ? `<div class="fantasy-drawer__stats">
        ${enriched ? `<div class="fantasy-drawer__stat"><span class="note--dim">Tier</span>${renderTierChip(source.tier)}</div>` : ""}
        ${enriched ? `<div class="fantasy-drawer__stat"><span class="note--dim">Apps</span>${renderStatCell(source.appearances, 0)}</div>` : ""}
        ${enriched ? `<div class="fantasy-drawer__stat"><span class="note--dim">Minutes</span>${renderStatCell(source.minutes, 0)}</div>` : ""}
        <div class="fantasy-drawer__stat"><span class="note--dim">xP</span>${xpCell}</div>
      </div>
      ${seasonNote}`
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
export function renderFantasyRosterPanel({
  currentGameweek,
  roster,
  lineup,
  playerPool,
  picks,
  editState,
  drawerPlayerId,
  lineupError,
  priorSeasonStats,
  xpStats,
  now = Date.now(),
}) {
  if (!lineup) {
    return lineupError
      ? `<div class="card"><p class="fantasy-form__error">${esc(lineupError)}</p><button class="seg" type="button" data-fantasy-lineup-retry>Retry</button></div>`
      : `<p class="note">Loading your lineup…</p>`;
  }

  const statsById = new Map((playerPool ?? []).map((player) => [player.id, player]));
  const starterIds = editState ? editState.starters : lineup.starters.map((entry) => entry.playerId);
  const captainId = editState ? editState.captainId : (lineup.starters.find((entry) => entry.isCaptain)?.playerId ?? null);
  const benchIds = editState ? editState.bench : lineup.bench;

  // The deadline leads the pitch: it is the one thing a manager has to know
  // before deciding whether it is even worth opening the editor. The lineup
  // response carries the instant (see handleFantasyLineupGet).
  const deadlineCard = renderSquadDeadlineBanner(
    {
      gameweek: lineup.gameweek ?? currentGameweek,
      deadline: lineup.deadline ?? null,
      locked: Boolean(lineup.locked),
      preseason: Boolean(lineup.preseason),
      seasonStart: lineup.seasonStart ?? null,
    },
    now,
  );

  const pitchCard = `
    ${deadlineCard}
    <section class="card fantasy-pitch">
      ${renderPitchHead(currentGameweek, lineup, editState, roster)}
      ${renderPitch({ roster, starterIds, benchIds, captainId, editState, statsById, xpStats })}
    </section>`;

  const drawerPlayer = drawerPlayerId != null ? (roster ?? []).find((player) => player.id === drawerPlayerId) ?? null : null;

  return `
    <div class="fantasy-myteam-grid">
      <div class="fantasy-myteam-grid__main">
        ${pitchCard}
        ${renderBench({ roster, starterIds, benchIds, captainId, editState, statsById, xpStats })}
      </div>
      <div class="fantasy-myteam-grid__rail">
        ${renderSquadXp({ roster, starterIds, statsById, xpStats })}
      </div>
    </div>
    ${renderPlayerDrawer(drawerPlayer, { picks, statsById, priorSeasonStats, xpStats })}`;
}

const POSITION_FILTERS = ["All", "GK", "DEF", "MID", "FWD"];

// `hideTaken` defaults to on (the spec's "hide-taken filter, defaulting to
// on"): a caller must explicitly set it to `false` to see drafted players
// greyed out inline instead. `draftedIds` is required to apply it - callers
// without a live draft (the pre-draft lobby's read-only scouting list) pass
// an empty Set, so the filter is naturally a no-op there.
function filterPlayers(players, filter, draftedIds) {
  const search = (filter?.search ?? "").trim().toLowerCase();
  const club = filter?.club ?? "All";
  const hideTaken = filter?.hideTaken !== false;
  return (players ?? []).filter((player) => {
    if (hideTaken && draftedIds?.has?.(player.id)) return false;
    if (filter?.position && filter.position !== "All" && player.position !== filter.position) return false;
    if (club !== "All" && player.team !== club) return false;
    if (!search) return true;
    return player.name.toLowerCase().includes(search) || player.team.toLowerCase().includes(search);
  });
}

// The available-player rows only: exported separately so app.js can re-render
// just this list on every keystroke/filter/turn change without rebuilding
// (and stealing focus and scroll position from) the search input and scroll
// region above it. Whether the Tier/Apps cells render at all is decided once
// from the full (unfiltered) pool passed in, so a search that happens to
// match zero enriched players never flips columns on and off under the
// header sitting above this list (see renderFantasyPlayerPool, which must
// make the identical decision from the same `players` argument for the two
// to stay column-aligned).
// `context.leagueSize` drives the draft-board ranking (fantasyDraftRank.js's
// rankDraftPool): replacement level, and so every player's rank, depends on
// how many managers will actually draft from this pool, never a fixed
// constant. `rankDraftPool` runs against the FULL `players` array (not yet
// filtered) since a position's replacement level has to reflect the whole
// pool, then filterPlayers narrows to what the UI is asking for, then
// sortPoolBy applies the chosen column - in that order, or a search/position
// filter would silently change what "the 12th best" means.
export function renderFantasyPlayerRows(players, filter, context) {
  const { isMyTurn, myRoster, draftedIds, suggestedId, queuedIds, leagueSize } = context ?? {};
  const ranked = rankDraftPool(players, leagueSize ?? 1);
  const filtered = sortPoolBy(filterPlayers(ranked, filter, draftedIds), filter?.sort ?? DEFAULT_POOL_SORT);
  if (!filtered.length) return `<p class="note">No players match.</p>`;
  const enriched = hasPriorSeasonData(players);
  return filtered
    .map((player) => {
      const drafted = draftedIds?.has?.(player.id);
      const legal = !drafted && canDraftPlayer(player, { isMyTurn, myRoster, draftedIds });
      const isSuggested = suggestedId != null && player.id === suggestedId;
      const isQueued = Boolean(queuedIds?.has?.(player.id));
      const action = legal
        ? `<button class="btn fantasy-draft-btn" type="button" data-fantasy-draft-player="${player.id}">Draft</button>`
        : drafted
          ? `<span class="note--dim">Drafted</span>`
          : "";
      // A drafted player can no longer usefully be queued/unqueued from the
      // pool row (the queue card's own remove button is where a stale entry
      // gets cleared), so the star only renders for a still-available player.
      const queueCell = drafted
        ? ""
        : `<button class="fantasy-queue-toggle ${isQueued ? "is-active" : ""}" type="button" data-fantasy-queue-toggle="${player.id}" aria-pressed="${isQueued}" aria-label="${isQueued ? "Remove from queue" : "Add to queue"}" title="${isQueued ? "Remove from queue" : "Add to queue"}">${isQueued ? "★" : "☆"}</button>`;
      const suggestedBadge = isSuggested ? `<span class="chip fantasy-chip--suggested">Pick</span>` : "";
      const tierCell = enriched ? `<span class="fantasy-player-row__tier">${renderTierChip(player.tier)}</span>` : "";
      const appsCell = enriched ? `<span class="fantasy-player-row__stat">${renderStatCell(player.appearances, 0)}</span>` : "";
      return `<div class="fantasy-player-row ${drafted ? "is-drafted" : ""} ${isSuggested ? "is-suggested" : ""}">
          ${badgeFor(player.team)}
          <span class="fantasy-player-row__id"><strong>${esc(player.name)}${suggestedBadge}</strong><span class="note--dim">${esc(abbrFor(player.team))}</span></span>
          <span class="fantasy-pos">${esc(player.position)}</span>
          ${renderRankCell(player)}
          ${tierCell}
          ${appsCell}
          <span class="fantasy-player-row__queue">${queueCell}</span>
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
// filter, search and the draft-rank sort control all live in a sticky header
// inside the single scrolling region, so they stay reachable no matter how
// far down a 500-row pool you've scrolled. Column header row (Player / Pos /
// Rank / Tier / Apps / action) sits in the same sticky block, directly above
// the rows it labels - Tier/Apps are present only when the pool actually
// carries prior-season enrichment (hasPriorSeasonData), so a failed bake
// never shows two empty-looking columns (see renderFantasyPlayerRows, which
// makes the identical decision so header and rows always agree on the column
// count); Rank is always shown - even with today's all-null xP it just reads
// as a dim placeholder for every row rather than disappearing.
// `priorSeasonStats` is the pool file's own header ({ available, season,
// playersWithoutRecord }), used only for the season note under the filters -
// a bare "37 appearances" is meaningless without knowing which season it's
// from. The sort control is CLAUDE.md's documented in-panel-control pattern
// (data-fantasy-pool-sort, reusing .segrow/.seg): app.js keeps the chosen key
// in state.fantasy.filter.sort / state.demo.filter.sort, exactly like every
// other pool filter here, defaulting to DEFAULT_POOL_SORT ("rank").
export function renderFantasyPlayerPool(players, filter, context, priorSeasonStats) {
  const activePosition = filter?.position ?? "All";
  const positionPills = POSITION_FILTERS.map(
    (position) =>
      `<button class="seg ${position === activePosition ? "is-active" : ""}" type="button" data-fantasy-position-filter="${position}">${position}</button>`,
  ).join("");
  const hideTaken = filter?.hideTaken !== false;
  const enriched = hasPriorSeasonData(players);
  const seasonLabel = enriched && priorSeasonStats?.season ? priorSeasonRangeLabel(priorSeasonStats.season) : "";
  const activeSort = POOL_SORTS[filter?.sort] ? filter.sort : DEFAULT_POOL_SORT;
  const sortPills = Object.entries(POOL_SORTS)
    .map(
      ([key, def]) =>
        `<button class="seg ${key === activeSort ? "is-active" : ""}" type="button" data-fantasy-pool-sort="${key}">${esc(def.label)}</button>`,
    )
    .join("");

  return `
    <section class="card fantasy-pool">
      <div class="fantasy-pool__scroll">
        <div class="fantasy-pool__sticky">
          <h3 class="card__title">Player pool</h3>
          ${seasonLabel ? `<p class="note--dim">Tier and appearances are from last season (${esc(seasonLabel)})</p>` : ""}
          <div class="fantasy-pool__filters">
            <div class="segrow fantasy-pool__positions">${positionPills}</div>
            <button class="seg ${hideTaken ? "is-active" : ""}" type="button" data-fantasy-hide-taken aria-pressed="${hideTaken}">Hide taken</button>
            <select class="fantasy-select" data-fantasy-club-filter>${renderClubOptions(players, filter?.club)}</select>
            <input class="fantasy-input" type="text" placeholder="Search players or clubs" value="${esc(filter?.search ?? "")}" data-fantasy-search autocomplete="off" />
          </div>
          <div class="fantasy-pool__filters fantasy-pool__sortrow">
            <span class="note--dim fantasy-pool__sort-label">Sort</span>
            <div class="segrow fantasy-pool__sort">${sortPills}</div>
          </div>
        </div>
        <div class="fantasy-pool__table ${enriched ? "" : "fantasy-pool__table--degraded"}">
          <div class="fantasy-pool__cols">
            <span></span><span>Player</span><span>Pos</span><span>Rank</span>${enriched ? `<span>Tier</span><span>Apps</span>` : ""}<span></span><span></span>
          </div>
          <div class="fantasy-pool__rows" data-fantasy-pool-list>${renderFantasyPlayerRows(players, filter, context)}</div>
        </div>
      </div>
    </section>`;
}

// The draft room's side column: suggested pick, on-the-clock, recent picks,
// your queue, your squad - everything a pick or clock update needs to
// refresh, exported as one unit so app.js can patch it in one shot (see
// patchDraftRoomDom) rather than recreating the whole draft-grid layout (and
// with it the pool's own scrolling container) on every WebSocket message or
// bot pick. `queue` is the caller's ordered array of queued player ids (see
// fantasyDraft.js); the queue's own top still-available legal pick outranks
// the generic suggestedPick heuristic for the suggested-pick card, exactly
// as it does for the demo's clock-expiry autopick in app.js.
export function renderFantasyDraftSide({ members, draft, playerPool, myUserId, entries, queue }) {
  const myRoster = draft.rosters?.[myUserId] ?? [];
  const draftedIds = new Set(
    Object.values(draft.rosters ?? {})
      .flat()
      .map((player) => player.id),
  );
  const isMyTurn = draft.onClockUserId != null && draft.onClockUserId === myUserId;
  const queuedTop = topQueuedPick(queue, playerPool, myRoster, draftedIds);
  const suggested = queuedTop ?? suggestedPick(playerPool, myRoster, draftedIds);
  const context = { isMyTurn, myRoster, draftedIds, suggestedId: suggested?.id ?? null };

  return `
    ${renderSuggestedPickCard(suggested, context, queuedTop != null)}
    ${renderOnClockCard({ members, draft, myUserId, entries, isMyTurn })}
    <section class="card fantasy-feed-card">
      <h3 class="card__title">Recent picks</h3>
      <div data-fantasy-feed-list>${renderPickFeed(draft.picks, members)}</div>
    </section>
    ${renderFantasyQueueCard(queue, playerPool, draftedIds)}
    <div data-fantasy-mysquad-card>${renderMySquad(draft.picks, myUserId, { compact: true })}</div>`;
}

export function renderFantasyDraftRoom({
  members,
  draft,
  playerPool,
  filter,
  myUserId,
  season = currentSeasonLabel(),
  priorSeasonStats,
  queue,
}) {
  const myRoster = draft.rosters?.[myUserId] ?? [];
  const draftedIds = new Set(
    Object.values(draft.rosters ?? {})
      .flat()
      .map((player) => player.id),
  );
  const isMyTurn = draft.onClockUserId != null && draft.onClockUserId === myUserId;
  // Queue-aware, matching renderFantasyDraftSide's own suggested-pick logic
  // exactly, so the pool's "Pick" badge always lands on the same player the
  // side column names as the suggestion rather than the plain heuristic.
  const suggested = topQueuedPick(queue, playerPool, myRoster, draftedIds) ?? suggestedPick(playerPool, myRoster, draftedIds);
  const context = {
    isMyTurn,
    myRoster,
    draftedIds,
    suggestedId: suggested?.id ?? null,
    queuedIds: new Set(queue ?? []),
    leagueSize: members?.length ?? 1,
  };
  const entries = draftOrderEntries(draft.memberIds, draft.round, draft.onClockUserId, draft.overallPick);

  return `
    <div data-fantasy-error-slot>${draft.lastError ? renderDraftErrorNotice(draft.lastError) : ""}</div>
    <div data-fantasy-draftstatus>${renderDraftStatusCard({ members, draft, myUserId, season, entries })}</div>
    <div class="fantasy-draftgrid">
      <div class="fantasy-draftgrid__main">${renderFantasyPlayerPool(playerPool, filter, context, priorSeasonStats)}</div>
      <div class="fantasy-draftgrid__side" data-fantasy-draft-side>${renderFantasyDraftSide({ members, draft, playerPool, myUserId, entries, queue })}</div>
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
          <h3 class="card__title">${esc(member.name)}${botChip(member.isBot)}</h3>
          <div class="fantasy-squad-rows">${rows || `<p class="note">No players.</p>`}</div>
        </section>`;
    })
    .join("");

  return `<div class="fantasy-rosters">${groups}</div>`;
}

// -- Waivers tab (Phase 4.4) -------------------------------------------------------
//
// Free agency and waivers once a league's draft is complete. Every acquisition,
// instant (free agent) or queued (waiver claim), is a same-position swap with
// the caller's own roster (SQUAD_SLOTS is always exactly full: see CLAUDE.md
// and src/fantasyWaivers.js), so both the free-agent and wire rows open the
// same confirm step (renderFantasyClaimFlow) rather than acting immediately,
// and that step only ever offers same-position drop candidates - and says so,
// rather than silently hiding every other position.

function renderFantasyWaiversStatus(waivers) {
  const { mode, faabBudget, myBudgetRemaining, myPriority, priorities, currentGameweek, claimWindow } = waivers;
  const { preseason, seasonStart, squadLocked } = waivers;
  const total = (priorities ?? []).length;
  const detail =
    mode === "faab"
      ? `<p class="fantasy-waivers-status__detail"><strong>${esc(myBudgetRemaining)}</strong> credits left <span class="note--dim">(league budget ${esc(faabBudget)})</span></p>`
      : `<p class="fantasy-waivers-status__detail">Your priority: <strong>${esc(priorityOrdinalLabel(myPriority, total) || "-")}</strong></p>`;

  // Pre-season this must NOT describe a deadline, a quiet period or a "next
  // run" three weeks away as though any of them were imminent. It names the
  // season start and says everything is open, which is the honest state.
  // In season it names the run a claim submitted right now belongs to, rather
  // than the current gameweek: inside the quiet period before a run those are
  // different numbers, and that difference is exactly what a manager needs.
  //
  // The pre-season wording is conditioned on the squad NOT being locked, since
  // both are true in the two hours before the opening kickoff, and "nothing is
  // locked" is flatly wrong there. Note a claim is still genuinely open in that
  // window: it resolves after the gameweek settles, so the squad deadline has
  // no bearing on it (see the reconciliation note in fantasyDeadlines.js).
  const windowNote =
    preseason && !squadLocked
      ? `Pre-season: transfers are open and nothing is locked. The season starts ${formatLocalSchedule(seasonStart)}.`
      : claimWindowNote(claimWindow) || `Claims resolve after gameweek ${esc(currentGameweek)} finishes.`;

  return `
    <section class="card fantasy-waivers-status">
      <div class="fantasy-waivers-status__head">
        <span class="chip fantasy-waivers-mode-chip fantasy-waivers-mode-chip--${esc(mode)}">${esc(waiverModeLabel(mode))}</span>
        <p class="note ${!preseason && claimWindow?.deferred ? "fantasy-waivers-status__deferred" : ""}">${esc(windowNote)}</p>
      </div>
      <p class="note">${esc(waiverModeExplanation(mode))}</p>
      ${detail}
      <button class="fantasy-waivers-status__help" type="button" data-tutorial-open="waivers">How do waivers work?</button>
    </section>`;
}

// -- Free agents: instant add, first come first served ------------------------

// The three numbers a manager actually needs to decide on a transfer, rendered
// as a meta line UNDER the player's name rather than as extra grid columns.
//
// That is a 375px decision, made deliberately. The row grid is already at its
// limit on a phone (24px crest + name + 44px position + 76px action) and three
// more columns would push it past the viewport into a sideways scroll. Making
// somebody scroll horizontally to reach the number the screen exists to show is
// worse than a second line, so the stats live inside the name cell and the grid
// is untouched. A wide screen simply gets a roomier name column.
//
// Honesty rules, inherited rather than restated:
//   - xP goes through the SAME xpBadge the draft board and the pitch use, so a
//     player can never be quoted two different ways in two places, and a
//     cohort-derived figure keeps its is-estimate treatment.
//   - A missing figure is the existing dim placeholder, never a zero.
//   - Season points are omitted entirely rather than shown as 0 before any
//     match has been played: "0" reads as "this player is worthless" when the
//     truth is "no games yet".
function renderFreeAgentStats(player, { statsById, starters, seasonPoints, xpStats }) {
  const stats = normalizePlayerStats(statsById?.get?.(player.id) ?? {});
  const badge = xpBadge(stats, player.position, xpStats);

  // "Should I add him" measured against the manager's own worst starter at that
  // position (src/fantasyDraftRank.js's startingUpgrade). Null whenever the
  // comparison cannot honestly be made, which includes having no lineup loaded.
  const upgrade = startingUpgrade({ position: player.position, xp: stats.xp }, starters);
  const upgradeHtml =
    upgrade == null
      ? ""
      : `<span class="fantasy-fa-row__delta ${upgrade >= 0 ? "is-up" : "is-down"}"
           title="${esc(`${upgrade >= 0 ? "Gains" : "Loses"} ${Math.abs(upgrade).toFixed(1)} expected points a gameweek against your worst starting ${player.position}`)}"
         >${upgrade >= 0 ? "+" : "-"}${esc(Math.abs(upgrade).toFixed(1))}</span>`;

  const points = seasonPoints?.get?.(player.id);
  const pointsHtml =
    typeof points === "number" && Number.isFinite(points)
      ? `<span class="fantasy-fa-row__pts" title="Fantasy points scored so far this season">${esc(formatScheduleScore(points))} pts</span>`
      : "";

  return `<span class="fantasy-fa-row__meta">
      <span class="fantasy-fa-row__xp ${badge.cls}" ${badge.title ? `title="${esc(badge.title)}" aria-label="${esc(badge.title)}"` : ""}>${badge.text}</span>
      ${upgradeHtml}
      ${pointsHtml}
    </span>`;
}

// `locked` is true once this player is locked for the gameweek: past the
// league-wide squad deadline that is everyone, and before it the kickoff
// backstop catches a club that has actually started (src/fantasyDeadlines.js).
// The Add button is replaced with a "Locked" chip either way.
function renderFreeAgentRow(player, locked, context) {
  const action = locked
    ? `<span class="chip fantasy-chip fantasy-chip--locked" title="Locked: the squad deadline for this gameweek has passed">Locked</span>`
    : `<button class="btn fantasy-draft-btn" type="button" data-fantasy-fa-add="${player.id}">Add</button>`;
  return `<div class="fantasy-fa-row">
      ${badgeFor(player.team)}
      <span class="fantasy-fa-row__id">
        <strong>${esc(player.name)}</strong>
        <span class="note--dim">${esc(abbrFor(player.team))}</span>
        ${renderFreeAgentStats(player, context)}
      </span>
      <span class="fantasy-pos">${esc(player.position)}</span>
      <span class="fantasy-fa-row__action">${action}</span>
    </div>`;
}

// The rows only, exported so app.js can refresh just this list on every
// filter keystroke/change (mirrors renderFantasyPlayerRows for the draft
// pool) - the search input itself lives outside this container, so a
// targeted refresh never has to fight for its own focus back. `lockedIds`
// (a Set, optional) comes straight off the waivers response; `context` carries
// the pool stats, the caller's own starters and the season-points map that
// renderFreeAgentStats reads.
export function renderFantasyFreeAgentRows(players, filter, lockedIds, context = {}) {
  const filtered = filterPlayers(players, filter);
  if (!filtered.length) return `<p class="note">No free agents match.</p>`;
  return filtered
    .map((player) => renderFreeAgentRow(player, Boolean(lockedIds?.has?.(player.id)), context))
    .join("");
}

function renderFantasyFreeAgents(freeAgents, filter, lockedIds, context = {}) {
  const activePosition = filter?.position ?? "All";
  const positionPills = POSITION_FILTERS.map(
    (position) =>
      `<button class="seg ${position === activePosition ? "is-active" : ""}" type="button" data-fantasy-fa-position-filter="${position}">${position}</button>`,
  ).join("");
  // The lock sentence must describe the rule that is actually enforced. It used
  // to name each club's own kickoff; the rule is now one league-wide deadline
  // two hours before the gameweek's first kickoff (see fantasyDeadlines.js).
  //
  // The locked branch is checked FIRST because pre-season and locked overlap
  // for two hours before the opening kickoff. Branching on pre-season alone put
  // "nothing is locked" directly above a list where every row said Locked.
  const lockNote = context.squadLocked
    ? "This gameweek's squad deadline has passed, so every player is locked until the next gameweek opens."
    : context.preseason
      ? "Pre-season, so nothing is locked and every add is instant."
      : "Everything locks two hours before the gameweek's first kickoff; a locked player shows Locked instead of Add, so nobody can bank a match that has already been decided.";
  return `
    <section class="card fantasy-pool fantasy-fa-pool">
      <div class="fantasy-pool__scroll">
        <div class="fantasy-pool__sticky">
          <h3 class="card__title">Free agents</h3>
          <p class="note">Unowned and available now: add one instantly for a same-position drop from your squad. ${esc(lockNote)}</p>
          ${
            context.starters?.length
              ? `<p class="note note--dim">The +/- figure is expected points a gameweek against your own worst starter at that position.</p>`
              : ""
          }
          <div class="fantasy-pool__filters">
            <div class="segrow fantasy-pool__positions">${positionPills}</div>
            <select class="fantasy-select" data-fantasy-fa-club-filter>${renderClubOptions(freeAgents, filter?.club)}</select>
            <input class="fantasy-input" type="text" placeholder="Search players or clubs" value="${esc(filter?.search ?? "")}" data-fantasy-fa-search autocomplete="off" />
          </div>
        </div>
        <div class="fantasy-pool__table">
          <div class="fantasy-fa-cols"><span></span><span>Player</span><span>Pos</span><span></span></div>
          <div class="fantasy-fa-rows" data-fantasy-fa-list>${renderFantasyFreeAgentRows(freeAgents, filter, lockedIds, context)}</div>
        </div>
      </div>
    </section>`;
}

// -- Waiver wire: locked until the next run, queued via a claim ---------------

function renderWireRow(entry) {
  const { player, clearsAfterGameweek } = entry;
  return `<div class="fantasy-wire-row">
      ${badgeFor(player.team)}
      <span class="fantasy-wire-row__id"><strong>${esc(player.name)}</strong><span class="note--dim">${esc(abbrFor(player.team))}</span></span>
      <span class="fantasy-pos">${esc(player.position)}</span>
      <span class="fantasy-wire-row__clears">Clears after GW ${esc(clearsAfterGameweek)}</span>
      <span class="fantasy-wire-row__action"><button class="btn fantasy-draft-btn" type="button" data-fantasy-wire-claim="${player.id}">Claim</button></span>
    </div>`;
}

// The wire is a list of { player, clearsAfterGameweek } entries rather than
// bare players (see src/fantasyApi.js's loadWaivers contract), so it needs its
// own filter pass rather than reusing filterPlayers directly.
function filterWireEntries(wire, filter) {
  const search = (filter?.search ?? "").trim().toLowerCase();
  const club = filter?.club ?? "All";
  return (wire ?? []).filter(({ player }) => {
    if (filter?.position && filter.position !== "All" && player.position !== filter.position) return false;
    if (club !== "All" && player.team !== club) return false;
    if (!search) return true;
    return player.name.toLowerCase().includes(search) || player.team.toLowerCase().includes(search);
  });
}

// Rows only, exported for the same targeted-refresh reason as
// renderFantasyFreeAgentRows above.
export function renderFantasyWireRows(wire, filter) {
  const filtered = filterWireEntries(wire, filter);
  if (!filtered.length) return `<p class="note">Nothing on the wire matches.</p>`;
  return filtered.map(renderWireRow).join("");
}

function renderFantasyWire(wire, filter) {
  const activePosition = filter?.position ?? "All";
  const positionPills = POSITION_FILTERS.map(
    (position) =>
      `<button class="seg ${position === activePosition ? "is-active" : ""}" type="button" data-fantasy-wire-position-filter="${position}">${position}</button>`,
  ).join("");
  const clubSource = (wire ?? []).map((entry) => entry.player);
  return `
    <section class="card fantasy-pool fantasy-wire-pool">
      <div class="fantasy-pool__scroll">
        <div class="fantasy-pool__sticky">
          <h3 class="card__title">Waiver wire</h3>
          <p class="note">Recently dropped, locked until the next run resolves every claim in priority order.</p>
          <div class="fantasy-pool__filters">
            <div class="segrow fantasy-pool__positions">${positionPills}</div>
            <select class="fantasy-select" data-fantasy-wire-club-filter>${renderClubOptions(clubSource, filter?.club)}</select>
            <input class="fantasy-input" type="text" placeholder="Search players or clubs" value="${esc(filter?.search ?? "")}" data-fantasy-wire-search autocomplete="off" />
          </div>
        </div>
        <div class="fantasy-pool__table">
          <div class="fantasy-wire-cols"><span></span><span>Player</span><span>Pos</span><span>Clears</span><span></span></div>
          <div class="fantasy-wire-rows" data-fantasy-wire-list>${renderFantasyWireRows(wire, filter)}</div>
        </div>
      </div>
    </section>`;
}

// -- Add/claim confirm step ----------------------------------------------------
//
// `flow` is { addPlayer, path: "free_agent" | "waiver", dropPlayerId } while
// a manager is mid-acquisition (state.fantasy.waiverFlow in app.js); `mode`
// is the league's current waiver mode, only consulted to decide whether a bid
// field belongs here (a free-agent add never bids, regardless of mode).
// `lockedIds` (a Set, optional) excludes any locked roster player from the
// drop candidates, the same composed rule the Worker enforces server-side
// (src/fantasyDeadlines.js: the league-wide squad deadline, with each club's
// own kickoff as the backstop underneath it) - but only for a free-agent add.
// A queued waiver claim is deliberately exempt: it resolves after this
// gameweek has settled, long after its matches are decided either way, so the
// lock has nothing meaningful to say about a drop that will not actually
// happen until then (see CLAUDE.md and worker.js's runLeagueWaiverRun).
export function renderFantasyClaimFlow(flow, { roster, mode, lockedIds } = {}) {
  const { addPlayer, path, dropPlayerId, busy = false, error = "" } = flow;
  const effectiveLockedIds = path === "free_agent" ? lockedIds : null;
  const allSamePosition = dropCandidates(roster, addPlayer.position, null);
  const candidates = dropCandidates(roster, addPlayer.position, effectiveLockedIds);
  const someLocked = candidates.length < allSamePosition.length;
  const drops = candidates.length
    ? candidates
        .map(
          (player) => `<button class="fantasy-claim-drop ${player.id === dropPlayerId ? "is-selected" : ""}" type="button" data-fantasy-claim-drop="${player.id}" ${busy ? "disabled" : ""}>
              ${badgeFor(player.team)}
              <span>${esc(player.name)}</span>
            </button>`,
        )
        .join("")
    : `<p class="note">You have no ${esc(addPlayer.position)} to drop${someLocked ? " that isn't locked" : ""}, so this swap isn't possible right now.</p>`;
  const bidField =
    path === "waiver" && mode === "faab"
      ? `<label class="fantasy-claim-flow__bid">Bid (credits)
          <input class="fantasy-input" type="number" min="0" step="1" value="0" data-fantasy-claim-bid ${busy ? "disabled" : ""} />
        </label>`
      : "";
  const actionLabel = path === "free_agent" ? "Add" : "Submit claim";
  const canSubmit = dropPlayerId != null && candidates.length > 0 && !busy;
  return `
    <section class="card fantasy-claim-flow">
      <div class="fantasy-claim-flow__head">
        ${badgeFor(addPlayer.team)}
        <div>
          <strong>${esc(addPlayer.name)}</strong>
          <p class="note--dim">${esc(addPlayer.position)} · ${esc(abbrFor(addPlayer.team))}</p>
        </div>
      </div>
      <p class="note">Every squad slot is always full, so adding a ${esc(addPlayer.position)} means dropping one of your own ${esc(addPlayer.position)}s. Choose which one below.</p>
      ${someLocked ? `<p class="note">This list is shorter than usual: a locked ${esc(addPlayer.position)} can't be dropped. Squads lock two hours before the gameweek's first kickoff, and a club that has already kicked off is locked regardless.</p>` : ""}
      <div class="fantasy-claim-flow__drops">${drops}</div>
      ${bidField}
      ${error ? `<p class="fantasy-form__error">${esc(error)}</p>` : ""}
      <div class="fantasy-claim-flow__actions">
        <button class="seg" type="button" data-fantasy-claim-cancel ${busy ? "disabled" : ""}>Cancel</button>
        <button class="btn btn--primary" type="button" data-fantasy-claim-submit ${canSubmit ? "" : "disabled"}>${busy ? "Submitting…" : actionLabel}</button>
      </div>
    </section>`;
}

// -- My claims: pending (cancellable) then resolved history --------------------

function playerLabel(playerId, playersById) {
  const player = playersById.get(playerId);
  return player ? esc(player.name) : `Player #${esc(playerId)}`;
}

function renderClaimRow(claim, playersById, { pending }) {
  const bidChip = claim.bid != null ? `<span class="chip fantasy-chip">${esc(claim.bid)} credits</span>` : "";
  const rightSide = pending
    ? `<button class="seg" type="button" data-fantasy-waiver-cancel-claim="${claim.claimId}">Cancel</button>`
    : `<span class="fantasy-claim-row__status fantasy-claim-row__status--${esc(claim.status)}">${esc(claimStatusLabel(claim.status))}</span>`;
  return `<div class="fantasy-claim-row">
      <div class="fantasy-claim-row__body">
        <p><strong>${playerLabel(claim.addPlayerId, playersById)}</strong> <span class="note--dim">for</span> ${playerLabel(claim.dropPlayerId, playersById)}</p>
        <p class="note--dim">Gameweek ${esc(claim.gameweek)}${pending ? ` · try order ${esc(claim.priority)}` : ""}</p>
        ${!pending && claim.reason ? `<p class="note fantasy-form__error">${esc(claim.reason)}</p>` : ""}
      </div>
      <div class="fantasy-claim-row__side">${bidChip}${rightSide}</div>
    </div>`;
}

function renderFantasyMyClaims(myClaims, playersById) {
  const { pending, resolved } = partitionWaiverClaims(myClaims);
  return `
    <section class="card fantasy-myclaims">
      <h3 class="card__title">My claims</h3>
      ${
        pending.length
          ? `<div class="fantasy-claim-rows">${pending.map((claim) => renderClaimRow(claim, playersById, { pending: true })).join("")}</div>`
          : `<p class="note">No pending claims.</p>`
      }
      ${
        resolved.length
          ? `<h4 class="fantasy-myclaims__subhead">Recent results</h4><div class="fantasy-claim-rows">${resolved
              .slice(0, 10)
              .map((claim) => renderClaimRow(claim, playersById, { pending: false }))
              .join("")}</div>`
          : ""
      }
    </section>`;
}

// -- League priority table ------------------------------------------------------

function renderFantasyPriorities(priorities, myUserId, mode) {
  const showBudget = mode === "faab";
  const rowModifier = showBudget ? "" : "fantasy-priority-row--no-budget";
  const rows = (priorities ?? [])
    .map((row) => {
      const isMe = row.userId === myUserId;
      return `<div class="fantasy-priority-row ${rowModifier} ${isMe ? "is-me" : ""}">
          <span>${esc(row.priority)}</span>
          <span>${esc(row.name)}${isMe ? ` <span class="note--dim">(you)</span>` : ""}</span>
          ${showBudget ? `<span>${esc(row.budgetRemaining)}</span>` : ""}
        </div>`;
    })
    .join("");
  return `
    <section class="card fantasy-priorities">
      <h3 class="card__title">League priority</h3>
      <div class="fantasy-priority-cols ${showBudget ? "" : "fantasy-priority-cols--no-budget"}"><span>Order</span><span>Manager</span>${showBudget ? "<span>Budget</span>" : ""}</div>
      <div class="fantasy-priority-rows">${rows || `<p class="note">No managers yet.</p>`}</div>
    </section>`;
}

// -- Commissioner settings ------------------------------------------------------
//
// The pending-claims restriction is surfaced proactively from the caller's
// OWN pending claims (myClaims is the only pending-claims visibility this
// view has - see CLAUDE.md/backend-contract notes: the waivers GET route
// does not expose other managers' claims). A save can still be rejected
// server-side by a pending claim belonging to someone else; that failure
// falls through to the same form-error style as any other save failure below,
// not a special second warning.
function renderFantasyWaiverSettings(waivers, { busy = false, error = "" } = {}) {
  const pendingOwnClaims = (waivers.myClaims ?? []).filter((claim) => claim.status === "pending").length;
  const blocked = pendingOwnClaims > 0;
  const disabledAttr = busy || blocked ? "disabled" : "";
  const options = WAIVER_MODES.map(
    (value) => `<option value="${esc(value)}"${value === waivers.mode ? " selected" : ""}>${esc(waiverModeLabel(value))}</option>`,
  ).join("");
  return `
    <section class="card fantasy-waiver-settings">
      <h3 class="card__title">Commissioner settings</h3>
      <p class="note">${esc(waiverModeExplanation(waivers.mode))}</p>
      <div class="fantasy-form__row">
        <select class="fantasy-select" data-fantasy-settings-mode ${disabledAttr}>${options}</select>
        <input class="fantasy-input" type="number" min="0" step="1" value="${esc(waivers.faabBudget)}" data-fantasy-settings-budget ${disabledAttr} />
        <button class="btn btn--primary" type="button" data-fantasy-settings-save ${disabledAttr}>${busy ? "Saving…" : "Save"}</button>
      </div>
      ${blocked ? `<p class="note fantasy-form__error">You have a pending claim this gameweek: settings can't change until it resolves.</p>` : ""}
      ${error ? `<p class="fantasy-form__error">${esc(error)}</p>` : ""}
    </section>`;
}

// -- Last run summary -----------------------------------------------------------

function renderFantasyLastRun(lastRun, playersById, members) {
  if (!lastRun) {
    return `
      <section class="card fantasy-lastrun">
        <h3 class="card__title">Last run</h3>
        <p class="note">No waiver run has resolved yet.</p>
      </section>`;
  }
  const rows = (lastRun.results ?? [])
    .map(
      (result) => `<div class="fantasy-lastrun-row fantasy-lastrun-row--${esc(result.status)}">
          <span>${esc(nameForUser(result.userId, members))}${botChipForUser(result.userId, members)}</span>
          <span>${playerLabel(result.addPlayerId, playersById)} <span class="note--dim">for ${playerLabel(result.dropPlayerId, playersById)}</span></span>
          <span class="fantasy-lastrun-row__status">${esc(claimStatusLabel(result.status))}${result.reason ? ` · ${esc(result.reason)}` : ""}</span>
        </div>`,
    )
    .join("");
  return `
    <section class="card fantasy-lastrun">
      <h3 class="card__title">Last run · Gameweek ${esc(lastRun.gameweek)}</h3>
      <div class="fantasy-lastrun-rows">${rows || `<p class="note">No claims were made that run.</p>`}</div>
    </section>`;
}

// -- Top-level panel -------------------------------------------------------------

export function renderFantasyWaiversPanel(
  waivers,
  {
    error = "",
    myUserId,
    members = [],
    isCommissioner = false,
    roster = [],
    freeAgentFilter = { position: "All", club: "All", search: "" },
    wireFilter = { position: "All", club: "All", search: "" },
    flow = null,
    settingsBusy = false,
    settingsError = "",
    playerPool = [],
    lineup = null,
    xpStats = null,
    now = Date.now(),
  } = {},
) {
  if (!waivers) {
    return error
      ? `<div class="card"><p class="fantasy-form__error">${esc(error)}</p><button class="seg" type="button" data-fantasy-waivers-retry>Retry</button></div>`
      : `<p class="note">Loading waivers…</p>`;
  }

  const playersById = buildWaiverPlayerLookup({ freeAgents: waivers.freeAgents, wire: waivers.wire, roster });
  const lockedIds = new Set(waivers.lockedPlayerIds ?? []);
  const freeAgentContext = buildFreeAgentContext({ waivers, roster, playerPool, lineup, xpStats });

  return `
    ${flow ? renderFantasyClaimFlow(flow, { roster, mode: waivers.mode, lockedIds }) : ""}
    ${renderSquadDeadlineBanner(
      {
        gameweek: waivers.currentGameweek,
        deadline: waivers.squadDeadline,
        locked: waivers.squadLocked,
        preseason: waivers.preseason,
        seasonStart: waivers.seasonStart,
      },
      now,
    )}
    ${renderFantasyWaiversStatus(waivers)}
    ${renderFantasyFreeAgents(waivers.freeAgents, freeAgentFilter, lockedIds, freeAgentContext)}
    ${renderFantasyWire(waivers.wire, wireFilter)}
    ${renderFantasyMyClaims(waivers.myClaims, playersById)}
    ${renderFantasyPriorities(waivers.priorities, myUserId, waivers.mode)}
    ${isCommissioner ? renderFantasyWaiverSettings(waivers, { busy: settingsBusy, error: settingsError }) : ""}
    ${renderFantasyLastRun(waivers.lastRun, playersById, members)}`;
}

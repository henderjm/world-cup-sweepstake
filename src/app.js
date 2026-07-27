import { loadModel } from "./data.js";
import { posthog } from "./telemetry.js";
import { COMPETITIONS, DEFAULT_COMPETITION_CODE } from "./competitions.js";
import {
  knockoutMatches,
  renderCompetitionChips,
  renderCompetitionSidebar,
  renderFixtures,
  renderFooter,
  renderHero,
  renderKnockout,
  renderLive,
  renderMiniTable,
  renderScoresTabs,
  renderStats,
  renderTable,
  renderTicker,
} from "./views.js";
import { renderSignedIn, renderSignedOut } from "./views.js";
import {
  GOOGLE_CLIENT_ID,
  accountAvailable,
  currentAccount,
  isFollowed,
  isSignedIn,
  mountSignIn,
  onAccountChange,
  restoreAccount,
  savePrefs,
  signOut,
  toggleFollow,
} from "./account.js";
import { disablePush, enablePush, pushState, sendTestPush } from "./push.js";
import { setMatchModel, setupMatchDetail, openMatch } from "./matchDetail.js";
import { isLive } from "./format.js";
import { todayPaperRunDate } from "./paperRunModel.js";
import {
  displayName,
  loadPaperRunDay,
  rememberName,
  sharePaperRun,
  submitPaperRunResult,
} from "./paperRunApi.js";
import { renderPaperRunPanel, updatePaperRunHud } from "./paperRunView.js";
import { mountPaperRunGame } from "./paperRunGame.js";
import {
  addFreeAgent as apiAddFreeAgent,
  cancelWaiverClaim as apiCancelWaiverClaim,
  createLeague as apiCreateLeague,
  fantasyAvailable,
  getLineup as apiGetLineup,
  isFantasyNotDeployed,
  joinLeague as apiJoinLeague,
  listLeagues as apiListLeagues,
  loadBlendedXp,
  loadLeague as apiLoadLeague,
  loadMatchup as apiLoadMatchup,
  loadPlayerPool,
  loadPlFixtureData,
  loadStandings as apiLoadStandings,
  loadWaivers as apiLoadWaivers,
  saveWaiverSettings as apiSaveWaiverSettings,
  scheduleDraft as apiScheduleDraft,
  setLineup as apiSetLineup,
  startDraft as apiStartDraft,
  submitWaiverClaim as apiSubmitWaiverClaim,
  unscheduleDraft as apiUnscheduleDraft,
} from "./fantasyApi.js";
import {
  applyBlendedXp,
  currentSeasonLabel,
  draftOrderEntries,
  formatCountdown,
  moveQueueItem,
  openDraftRoom,
  pruneQueue,
  reduceDraftMessage,
  removeFromQueue,
  suggestedPick,
  swapLineup,
  toggleQueue,
  topQueuedPick,
} from "./fantasyDraft.js";
import { formatScheduleCountdown, localInputValueToUtcIso } from "./fantasyScheduling.js";
import {
  renderDraftErrorNotice,
  renderDraftStatusCard,
  renderFantasyComplete,
  renderFantasyDraftRoom,
  renderFantasyDraftSide,
  renderFantasyEmptyState,
  renderFantasyError,
  renderFantasyFreeAgentRows,
  renderFantasyLeagueList,
  renderFantasyLeagueShell,
  renderFantasyLobby,
  renderFantasyMatchupPanel,
  renderFantasyMyTeamPanel,
  renderFantasyNotConfigured,
  renderFantasyPlayerRows,
  renderFantasyRosterPanel,
  renderFantasySessionExpired,
  renderFantasySignedOut,
  renderFantasyStandingsPanel,
  renderFantasyWaiversPanel,
  renderFantasyWireRows,
} from "./fantasyView.js";
import {
  applyDemoPick,
  autoBenchInjured,
  autoPickForRoom,
  availableWaiverPlayers,
  buildDemoReportCard,
  composeDemoShareText,
  createDemoMembers,
  DEFAULT_DEMO_CLOCK_SECONDS,
  DEFAULT_DEMO_LEAGUE_SIZE,
  DEMO_BOT_PICK_DELAY_MS,
  DEMO_SEASON_GAMEWEEKS,
  demoClockDurationMs,
  demoManagerForm,
  draftedPlayerIds,
  initDemoDraftRoom,
  initDemoSeason,
  isDemoDraftComplete,
  isDemoSeasonComplete,
  isFinalChunk,
  advanceDemoSeasonChunk,
  saveDemoLineup,
  simulateDemoSeasonToEnd,
  standingsThroughGameweek,
  submitDemoWaiverClaims,
} from "./fantasyDemo.js";
import { renderDemoDesk, renderDemoReportCard, renderDemoRoll, renderDemoSetup } from "./fantasyDemoView.js";
import { standingsMapFromRawPayload } from "./fantasyDemoFixtures.js";
import { tutorialBySlug, TUTORIALS } from "./tutorials.js";
import { renderTutorial, renderTutorialIndex } from "./tutorialsView.js";

const elements = {
  ticker: document.querySelector("#ticker"),
  layout: document.querySelector("#layout"),
  footer: document.querySelector("#footer"),
  sectionNav: document.querySelector("#sectionNav"),
  bottomNav: document.querySelector("#bottomNav"),
  matchDrawer: document.querySelector("#matchDrawer"),
  updated: document.querySelector("#updated"),
};

const SCORES_TABS = ["live", "tables", "knockout", "fixtures", "stats"];
const HASH_ALIASES = { goldenboot: "stats", paperrun: "play" };
const COMPETITION_STORAGE_KEY = "gs-competition";

const NON_SCORES_SECTIONS = ["play", "you", "fantasy", "learn", "demo"];

// "#learn" alone opens the tutorials index; "#learn/<slug>" deep-links straight
// into one. Parsed up front (mirroring how every other section reads its
// initial hash) so a direct link works on first paint, not just after a click;
// an unknown slug falls back to null (the index) rather than a blank Learn
// section - resolveInitialLearnHash never trusts the hash to name a real tutorial.
function resolveInitialLearnHash(rawHash) {
  const match = /^learn\/(.+)$/.exec(rawHash);
  if (!match) return { section: rawHash, slug: null };
  return { section: "learn", slug: tutorialBySlug(match[1]) ? match[1] : null };
}

const rawInitialHash = window.location.hash.replace("#", "");
const initialLearn = resolveInitialLearnHash(rawInitialHash);
const initialHash = initialLearn.section === "learn" ? "learn" : (HASH_ALIASES[rawInitialHash] ?? rawInitialHash);
const state = {
  section: NON_SCORES_SECTIONS.includes(initialHash) ? initialHash : "scores",
  tab: SCORES_TABS.includes(initialHash) ? initialHash : "live",
  competition: storedCompetition(),
  fixtureView: "results",
  statsSort: "goals",
  isMobile: window.matchMedia("(max-width: 760px)").matches,
  paperrun: {
    date: todayPaperRunDate(),
    day: null,
    loading: false,
    mount: null,
  },
  fantasy: initialFantasyState(),
  demo: initialDemoState(),
  learn: {
    slug: initialHash === "learn" ? initialLearn.slug : null,
    resolverMode: "faab",
  },
};

// Fresh signed-out demo state: used on boot and whenever "Draft again" resets
// the trial (name/size are kept across a reset - everything else is thrown
// away, including any timers, which teardownDemo() has already cleared).
function initialDemoState() {
  return {
    stage: "setup", // "setup" | "drafting" | "rolling" | "desk" | "report"
    name: "",
    size: DEFAULT_DEMO_LEAGUE_SIZE,
    clock: DEFAULT_DEMO_CLOCK_SECONDS, // seconds per pick, or DEMO_CLOCK_UNTIMED
    busy: false,
    pool: null,
    fixtureData: null, // { matches, standingsMap } from data/PL/live.json, or null if unavailable (see loadDemoFixtureData)
    members: null,
    humanId: null,
    seed: null,
    room: null, // draft room state, same shape as the real draft room's (see fantasyDemo.js)
    remainingMs: 0,
    filter: { position: "All", club: "All", search: "", hideTaken: true },
    queue: [], // ordered array of queued player ids (see fantasyDraft.js's toggleQueue/moveQueueItem)
    botTimer: null,
    clockTimer: null,
    season: null, // the stepwise season state from initDemoSeason/advanceDemoSeasonChunk
    reportCard: null,
    rollGameweek: 0, // the absolute gameweek number currently revealed by the roll
    rollFromGw: 0, // the gameweek this roll segment started revealing from
    rollToGw: 0, // the gameweek this roll segment stops at (a chunk boundary, or the season's last gameweek when sim-to-end is playing out the rest continuously)
    rollTimer: null,
    rollDone: false,
    pendingWaiverResult: null, // this desk's own claim outcome, shown at the TOP of the NEXT desk (see continueDemoDesk/openDemoDesk)
    pendingWaiverPlayerName: null,
    desk: null, // { fromGw, toGw, waiverTarget, pendingDropId, waiverPick, lastWaiverResult, lastWaiverPlayerName, lineupEdit, drawerPlayerId }
    shareStatus: "",
  };
}

// Fresh fantasy state: used on boot and whenever a signed-out transition (or a
// fully-closed league) needs to forget everything the previous session loaded.
function initialFantasyState() {
  return {
    leagues: null,
    leaguesLoading: false,
    activeLeagueId: null,
    league: null, // { league, members, picks, roster } from GET /fantasy/league/:id
    myUserId: null,
    playerPool: null,
    playerPoolLoading: false,
    draftRoom: null, // { controller, state, remainingMs } once a socket is open
    filter: { position: "All", club: "All", search: "", hideTaken: true },
    queue: [], // ordered array of queued player ids, personal shortlist (see fantasyDraft.js)
    subTab: "draftroom", // "draftroom" | "myteam" | "matchup" | "standings"
    lineup: null, // { gameweek, source, starters: [{playerId,isCaptain}], bench } from GET .../lineup
    lineupLoading: false,
    lineupError: "",
    lineupEdit: null, // working copy while editing: { starters, captainId, bench, pendingId, saving, error }
    playerDrawerId: null, // My team pitch/bench: id of the player whose stats drawer is open
    matchup: null, // { gameweek, status, me, opponent } from GET .../matchup
    matchupLoading: false,
    matchupError: "",
    standings: null, // { throughGameweek, standings } from GET .../standings
    standingsLoading: false,
    standingsError: "",
    waivers: null, // GET .../waivers response (mode, budgets, priorities, free agents, wire, my claims, last run)
    waiversLoading: false,
    waiversError: "",
    waiverFreeAgentFilter: { position: "All", club: "All", search: "" },
    waiverWireFilter: { position: "All", club: "All", search: "" },
    waiverFlow: null, // working copy while adding/claiming: { addPlayer, path, dropPlayerId, busy, error }
    waiverSettingsBusy: false,
    waiverSettingsError: "",
    scheduleBusy: false, // draft-schedule save/clear in flight
    scheduleError: "",
    createBusy: false,
    createError: "",
    joinBusy: false,
    joinError: "",
    loadError: "",
    sessionExpired: false, // 401 from the fantasy API: distinct from a generic loadError
    notDeployed: false, // 404/501: the Worker predates (or has disabled) the fantasy routes
  };
}

function storedCompetition() {
  try {
    const stored = window.localStorage.getItem(COMPETITION_STORAGE_KEY);
    if (stored && COMPETITIONS[stored]) return stored;
  } catch {
    // storage may be blocked; the default competition still works
  }
  return DEFAULT_COMPETITION_CODE;
}

let model = null;
let appLoadMetricSent = false;
let pollTimer = null;
let lastSignature = "";
let lastFetchAt = 0;

const SHELL_IDS = ["ticker", "layout", "footer", "updated", "sectionNav", "bottomNav", "accountBtn"];
const RELOAD_FLAG = "gs-shell-reloaded";

start();

async function start() {
  // A freshly deployed app.js can briefly load against a stale, cached index.html
  // that lacks the new elements. Rather than throw on a null element, reload once to
  // pull the matching HTML, then bail quietly so we never error or loop.
  if (!SHELL_IDS.every((id) => document.getElementById(id))) {
    try {
      if (!sessionStorage.getItem(RELOAD_FLAG)) {
        sessionStorage.setItem(RELOAD_FLAG, "1");
        window.location.reload();
      }
    } catch (error) {
      posthog.captureException(error);
    }
    return;
  }
  try {
    sessionStorage.removeItem(RELOAD_FLAG);
  } catch {
    // sessionStorage can be unavailable (private mode); the app still runs.
  }

  const buildStart = performance.now();
  model = await loadModel(state.competition);
  trackAppLoad(model, Math.round(performance.now() - buildStart));

  // Everything is wired regardless of whether the first load has data: a stored
  // competition whose season has not opened yet must still let the visitor switch
  // away, and polling lets it self-heal the moment the feed opens.
  setUpdatedLabel();
  window.setInterval(setUpdatedLabel, 1000);
  wireNav();
  wireLayoutControls();
  wireViewportChange();
  setupMatchDetail(model, { drawer: elements.matchDrawer });
  onAccountChange(() => {
    syncAccountButton();
    if (state.section === "you") renderLayout();
    if (!isSignedIn()) {
      // Signing out mid-draft must drop the socket, not just swap the panel for
      // the signed-out card underneath it.
      teardownFantasyDraftRoom();
      state.fantasy = initialFantasyState();
    } else if (state.fantasy.sessionExpired) {
      // A fresh sign-in (typically done from the You section, with the
      // Fantasy tab's "session expired" card left showing underneath) should
      // forget that stale failure so the next visit to Fantasy retries
      // instead of getting stuck on the same expired-session message forever.
      state.fantasy = initialFantasyState();
    }
    if (state.section === "fantasy") renderLayout();
  });
  restoreAccount().then(syncAccountButton);

  if (model.hasData) {
    lastFetchAt = Date.now();
    renderAll();
    const matchParam = new URLSearchParams(window.location.search).get("match");
    if (matchParam) {
      const match = model.matches.find((item) => String(item.id) === matchParam);
      if (match) openMatch(match);
    }
  } else {
    renderAll();
  }

  startPolling();
}

// Relative "updated Xs ago" that ticks every second, so it is always visibly live.
function setUpdatedLabel() {
  if (!lastFetchAt) {
    elements.updated.textContent = "loading";
    return;
  }
  const secs = Math.max(0, Math.round((Date.now() - lastFetchAt) / 1000));
  let label;
  if (secs < 5) label = "just now";
  else if (secs < 60) label = `${secs}s ago`;
  else if (secs < 3600) label = `${Math.floor(secs / 60)}m ago`;
  else label = new Intl.DateTimeFormat("en-IE", { hour: "2-digit", minute: "2-digit" }).format(new Date(lastFetchAt));
  elements.updated.textContent = label;
}

// Live refresh without a deploy: re-pull the model on an interval and re-render only
// when a match signature (id/status/score/minute) actually changed. Polls faster
// while a game is live, slower when nothing is on.
function matchSignature(data) {
  return (data.matches ?? [])
    .map((item) =>
      [
        item.id,
        item.status,
        item.homeTeam,
        item.awayTeam,
        item.score?.home,
        item.score?.away,
        item.winner ?? "",
        item.minute ?? "",
      ].join(":"),
    )
    .join("|");
}

function startPolling() {
  lastSignature = matchSignature(model);
  scheduleNextPoll();
}

function scheduleNextPoll() {
  const hasLive = (model.matches ?? []).some((item) => isLive(item.status));
  pollTimer = window.setTimeout(poll, hasLive ? 20000 : 60000);
}

async function poll() {
  const polledCompetition = state.competition;
  try {
    const fresh = await loadModel(polledCompetition);
    // A switch mid-flight makes this response stale; the switch already re-rendered.
    if (polledCompetition !== state.competition) return scheduleNextPoll();
    if (fresh.hasData) {
      lastFetchAt = Date.now();
      const signature = matchSignature(fresh);
      if (signature !== lastSignature) {
        lastSignature = signature;
        model = fresh;
        setMatchModel(model);
        if (state.section !== "play") renderAll();
        else elements.ticker.innerHTML = renderTicker(model);
      }
      setUpdatedLabel();
    }
  } catch {
    // keep the last good model and try again next cycle
  }
  scheduleNextPoll();
}

// -- Rendering -----------------------------------------------------------------

function renderAll() {
  syncNav();
  elements.ticker.innerHTML = model.hasData
    ? renderTicker(model)
    : `<div class="ticker__track" style="animation:none;"><span class="ticker__item ticker__item--idle">Live feed not available yet.</span></div>`;
  elements.footer.innerHTML = model.hasData
    ? renderFooter(model)
    : `<p>Data source: ${model.source ?? "pending"} · Kickoff Draft is a Goon Squad production.</p>`;
  renderLayout();
}

function renderLayout() {
  if (state.section === "play") {
    elements.layout.className = "layout";
    renderPaperRun();
    return;
  }
  destroyPaperRunMount();

  if (state.section === "fantasy") {
    elements.layout.className = "layout";
    renderFantasy();
    return;
  }
  teardownFantasyDraftRoom();

  if (state.section === "demo") {
    elements.layout.className = "layout";
    renderDemo();
    return;
  }
  teardownDemo();

  if (state.section === "learn") {
    elements.layout.className = "layout";
    renderLearn();
    return;
  }

  if (state.section === "you") {
    elements.layout.className = "layout";
    const account = currentAccount();
    elements.layout.innerHTML = account
      ? renderSignedIn(model, account, isFollowed)
      : renderSignedOut({ available: accountAvailable(), configured: Boolean(GOOGLE_CLIENT_ID) });
    if (account) updatePushControls();
    if (!account && accountAvailable() && GOOGLE_CLIENT_ID) {
      mountSignIn(document.getElementById("gisButton"), {
        onError: () => {
          const slot = document.getElementById("gisButton");
          if (slot) slot.innerHTML = `<p class="note">Sign-in is unavailable right now. Try again shortly.</p>`;
        },
      });
    }
    return;
  }

  if (!model.hasData) {
    elements.layout.className = "layout";
    elements.layout.innerHTML = `
      <div class="pending">
        <p class="hero__eyebrow">${model.competition?.name ?? "Football"}</p>
        <h1 class="hero__title">Waiting for the season</h1>
        <p class="note">${model.error ?? "This competition has no published fixtures yet. It appears here as soon as the feed opens the season."}</p>
        <div class="hero__meta">${renderCompetitionChips(state.competition)}</div>
      </div>`;
    return;
  }

  // A tab that makes no sense in this competition falls back to the live view.
  if (state.tab === "knockout" && knockoutMatches(model).length === 0) state.tab = "live";

  const panel = `
    <div class="panelcol">
      ${state.isMobile ? renderCompetitionChips(state.competition) : ""}
      ${renderHero(model)}
      ${renderScoresTabs(model, state.tab)}
      ${renderPanel()}
    </div>`;

  if (state.isMobile) {
    elements.layout.className = "layout";
    elements.layout.innerHTML = panel;
  } else {
    elements.layout.className = "layout layout--scores";
    elements.layout.innerHTML = `${renderCompetitionSidebar(state.competition)}${panel}${renderMiniTable(model)}`;
  }
}

function renderPanel() {
  switch (state.tab) {
    case "tables":
      return renderTable(model);
    case "knockout":
      return renderKnockout(model);
    case "fixtures":
      return renderFixtures(model, state.fixtureView);
    case "stats":
      return renderStats(model, state.statsSort);
    default:
      return renderLive(model);
  }
}

// -- Paper Run section -----------------------------------------------------------

function renderPaperRun() {
  const today = todayPaperRunDate();
  if (state.paperrun.date !== today) {
    destroyPaperRunMount();
    state.paperrun = { date: today, day: null, loading: false, mount: null };
  }
  if (!state.paperrun.day && !state.paperrun.loading) loadPaperRun();
  if (!state.paperrun.day) {
    elements.layout.innerHTML = `<div class="panelcol"><p class="note">Loading today's paper run...</p></div>`;
    return;
  }
  destroyPaperRunMount();
  elements.layout.innerHTML = `<div class="panelcol" id="playPanel">${renderPaperRunPanel(state.paperrun.day)}</div>`;
  mountPaperRun();
}

async function loadPaperRun() {
  const date = state.paperrun.date;
  state.paperrun.loading = true;
  try {
    const day = await loadPaperRunDay(date);
    if (state.paperrun.date !== date) return;
    state.paperrun.day = day;
  } catch (error) {
    posthog.captureException(error);
  } finally {
    state.paperrun.loading = false;
  }
  if (state.section === "play") renderLayout();
}

function mountPaperRun() {
  const day = state.paperrun.day;
  const host = document.getElementById("playPanel");
  if (!day || !host) return;
  // Mount even when locked so the canvas draws the static done-state street
  // instead of an undrawn black void.
  if (!day.result) metric("count", "paperrun_shown", 1);
  state.paperrun.mount = mountPaperRunGame(host, day, {
    onTick: (snap) => updatePaperRunHud(host, snap),
    onStart: () => {
      metric("count", "paperrun_started", 1);
      posthog.capture("paper_run_started", { date: state.paperrun.date });
    },
    onUnavailable: () => {
      const status = host.querySelector("[data-run-status]");
      if (status) status.innerHTML = `<strong>Game unavailable</strong><span>This browser cannot start the canvas game.</span>`;
    },
    onComplete: async (result) => {
      const name = displayName();
      metric("count", "paperrun_completed", 1, {
        tags: { score: String(result.score), deliveries: String(result.deliveries), finished: String(result.finished) },
      });
      posthog.capture("paper_run_completed", {
        date: state.paperrun.date,
        score: result.score,
        deliveries: result.deliveries,
        finished: result.finished,
      });
      await savePaperRun(day, { ...result, name });
    },
  });
}

// Lock the run, submit it, and re-render with the official result and board.
async function savePaperRun(day, result) {
  const submitted = await submitPaperRunResult(day.date, result);
  if (submitted.conflict) metric("count", "paperrun_replay_blocked", 1);
  state.paperrun.day = {
    ...day,
    alreadyPlayed: true,
    result: submitted.result,
    leaderboard: submitted.leaderboard,
    localOnly: submitted.localOnly,
    serverAvailable: submitted.localOnly ? day.serverAvailable : true,
  };
  if (state.section === "play") renderLayout();
}

function destroyPaperRunMount() {
  if (!state.paperrun.mount) return;
  state.paperrun.mount.destroy();
  state.paperrun.mount = null;
}

// -- Fantasy section -----------------------------------------------------------

function renderFantasy() {
  const f = state.fantasy;
  // Stopped unconditionally on every render and only restarted from the
  // pending-lobby branch below, so navigating away from a league with a
  // schedule (closing it, switching sub-tabs once the draft starts, signing
  // out) can never leave a stray interval ticking against a detached DOM node.
  stopFantasyScheduleCountdownTimer();

  if (!isSignedIn()) {
    elements.layout.innerHTML = renderFantasySignedOut();
    return;
  }
  if (!fantasyAvailable()) {
    elements.layout.innerHTML = renderFantasyNotConfigured();
    return;
  }
  if (f.notDeployed) {
    // Same card as fantasyAvailable() === false: a 404/501 from the fantasy
    // routes reads the same to the user (not ready yet), whether the Worker
    // isn't configured client-side or hasn't shipped the routes server-side.
    elements.layout.innerHTML = renderFantasyNotConfigured();
    return;
  }
  if (f.sessionExpired) {
    elements.layout.innerHTML = renderFantasySessionExpired();
    return;
  }
  if (f.loadError) {
    elements.layout.innerHTML = renderFantasyError(f.loadError);
    return;
  }

  if (f.activeLeagueId == null) {
    if (!f.leagues) {
      elements.layout.innerHTML = `<p class="note">Loading your leagues…</p>`;
      loadFantasyLeagues();
      return;
    }
    elements.layout.innerHTML = f.leagues.length
      ? renderFantasyLeagueList(f.leagues, fantasyFormState())
      : renderFantasyEmptyState(fantasyFormState());
    return;
  }

  if (!f.league) {
    elements.layout.innerHTML = `<p class="note">Loading league…</p>`;
    return; // openFantasyLeague already has the fetch in flight
  }

  const { league, members, schedule } = f.league;
  const subTab = f.subTab ?? "draftroom";

  if (league.draftStatus === "pending") {
    // Pre-draft scouting needs the player pool too, loaded lazily the moment
    // the lobby actually renders (mirrors renderPaperRun's "kick off the load
    // if it hasn't started, render what we have now" pattern) rather than
    // blocking the lobby itself behind an extra fetch.
    if (!f.playerPool && !f.playerPoolLoading) loadFantasyPlayerPoolForLobby();
    const body =
      subTab === "myteam"
        ? renderFantasyMyTeamPanel([], f.myUserId)
        : subTab === "matchup"
          ? renderFantasyMatchupBody()
          : subTab === "standings"
            ? renderFantasyStandingsBody()
            : subTab === "waivers"
              ? renderFantasyWaiversBody(league)
              : renderFantasyLobby(league, members, {
                  playerPool: f.playerPool,
                  filter: f.filter,
                  schedule,
                  scheduleBusy: f.scheduleBusy,
                  scheduleError: f.scheduleError,
                  queuedIds: new Set(f.queue ?? []),
                });
    elements.layout.innerHTML = renderFantasyLeagueShell(league, members, subTab, body);
    if (schedule?.scheduledAt) startFantasyScheduleCountdownTimer();
    return;
  }

  if (!f.draftRoom?.state) {
    elements.layout.innerHTML = `<p class="note">Connecting to the draft room…</p>`;
    return;
  }

  renderFantasyDraftPanel();
}

// Rendering the draft room replaces the search input (and the pool's scroll
// region) wholesale, which would normally steal focus/caret out from under
// someone typing and jump the pool back to the top; save and restore both
// across the swap since this path re-renders on every WS message.
function renderFantasyDraftPanel() {
  const f = state.fantasy;
  const wasSearchFocused = document.activeElement?.matches?.("[data-fantasy-search]");
  const caret = wasSearchFocused ? document.activeElement.selectionStart : null;
  const poolScrollTop = elements.layout.querySelector(".fantasy-pool__scroll")?.scrollTop ?? null;

  const room = f.draftRoom.state;
  const { league, members } = f.league;
  const subTab = f.subTab ?? "draftroom";

  const body =
    subTab === "myteam"
      ? renderFantasyMyTeamBody(league, room)
      : subTab === "matchup"
        ? renderFantasyMatchupBody()
        : subTab === "standings"
          ? renderFantasyStandingsBody()
          : subTab === "waivers"
            ? renderFantasyWaiversBody(league)
            : room.status === "complete"
              ? renderFantasyComplete(members, room.picks)
              : renderFantasyDraftRoom({
                league,
                members,
                draft: { ...room, remainingMs: f.draftRoom.remainingMs },
                playerPool: f.playerPool?.players ?? [],
                filter: f.filter,
                myUserId: f.myUserId,
                priorSeasonStats: f.playerPool?.priorSeasonStats,
                queue: f.queue,
              });
  elements.layout.innerHTML = renderFantasyLeagueShell(league, members, subTab, body);

  if (wasSearchFocused) {
    const input = elements.layout.querySelector("[data-fantasy-search]");
    if (input) {
      input.focus();
      input.setSelectionRange(caret, caret);
    }
  }
  if (poolScrollTop != null) {
    const scrollEl = elements.layout.querySelector(".fantasy-pool__scroll");
    if (scrollEl) scrollEl.scrollTop = poolScrollTop;
  }
}

// My team body: the draft-era simple squad list (renderFantasyMyTeamPanel) for
// a league still pending/drafting, or the pitch/bench/Squad xP roster panel
// once the draft is complete and the season's 15-man squads are fixed. The
// roster panel needs its own fetch (the lineup, not part of the draft room's
// WebSocket state), lazily kicked off here the first time it renders without
// one yet - the same "trigger the load, render what we have" shape as
// loadPaperRun/loadFantasyPlayerPoolForLobby.
function renderFantasyMyTeamBody(league, room) {
  if (league.draftStatus !== "complete") {
    return renderFantasyMyTeamPanel(room.picks, state.fantasy.myUserId);
  }
  const f = state.fantasy;
  if (!f.lineup && !f.lineupLoading && !f.lineupError) loadFantasyLineup(f.activeLeagueId);
  return renderFantasyRosterPanel({
    currentGameweek: f.league.currentGameweek,
    roster: f.league.roster,
    lineup: f.lineup,
    playerPool: f.playerPool?.players ?? [],
    picks: f.league.picks,
    editState: f.lineupEdit,
    drawerPlayerId: f.playerDrawerId,
    lineupError: f.lineupError,
    priorSeasonStats: f.playerPool?.priorSeasonStats,
    xpStats: f.playerPool?.xpStats,
  });
}

async function loadFantasyLineup(leagueId) {
  const f = state.fantasy;
  if (f.lineupLoading) return;
  f.lineupLoading = true;
  f.lineupError = "";
  try {
    const lineup = await apiGetLineup(leagueId);
    if (f.activeLeagueId !== leagueId) return; // navigated elsewhere mid-flight
    f.lineup = lineup;
  } catch (error) {
    if (f.activeLeagueId !== leagueId) return;
    f.lineupError = error.message || "Couldn't load your lineup.";
  } finally {
    if (f.activeLeagueId === leagueId) f.lineupLoading = false;
  }
  if (state.section === "fantasy") renderLayout();
}

// Matchup/Standings bodies: the same "trigger the load the first time it
// renders without data yet, render what we have now" shape as
// renderFantasyMyTeamBody's lineup fetch above (and loadPaperRun before it).
// Neither tab depends on the draft room's own data, so they fetch and cache
// independently of it and survive switching away to another sub-tab.
function renderFantasyMatchupBody() {
  const f = state.fantasy;
  if (!f.matchup && !f.matchupLoading && !f.matchupError) loadFantasyMatchup(f.activeLeagueId);
  return renderFantasyMatchupPanel(f.matchup, { error: f.matchupError });
}

function renderFantasyStandingsBody() {
  const f = state.fantasy;
  if (!f.standings && !f.standingsLoading && !f.standingsError) loadFantasyStandings(f.activeLeagueId);
  return renderFantasyStandingsPanel(f.standings, { error: f.standingsError, myUserId: f.myUserId });
}

async function loadFantasyMatchup(leagueId) {
  const f = state.fantasy;
  if (f.matchupLoading) return;
  f.matchupLoading = true;
  f.matchupError = "";
  try {
    const matchup = await apiLoadMatchup(leagueId);
    if (f.activeLeagueId !== leagueId) return; // navigated elsewhere mid-flight
    f.matchup = matchup;
  } catch (error) {
    if (f.activeLeagueId !== leagueId) return;
    f.matchupError = error.message || "Couldn't load your matchup.";
  } finally {
    if (f.activeLeagueId === leagueId) f.matchupLoading = false;
  }
  if (state.section === "fantasy") renderLayout();
}

async function loadFantasyStandings(leagueId) {
  const f = state.fantasy;
  if (f.standingsLoading) return;
  f.standingsLoading = true;
  f.standingsError = "";
  try {
    const standings = await apiLoadStandings(leagueId);
    if (f.activeLeagueId !== leagueId) return; // navigated elsewhere mid-flight
    f.standings = standings;
  } catch (error) {
    if (f.activeLeagueId !== leagueId) return;
    f.standingsError = error.message || "Couldn't load the standings.";
  } finally {
    if (f.activeLeagueId === leagueId) f.standingsLoading = false;
  }
  if (state.section === "fantasy") renderLayout();
}

// Waivers body: same lazy-load-once shape as Matchup/Standings above, but
// only meaningful once the draft is complete (the Waivers sub-tab itself is
// disabled until then - see renderFantasySubtabs - so this branch is really
// only reachable through the tab button, not a stale deep link).
function renderFantasyWaiversBody(league) {
  const f = state.fantasy;
  if (league.draftStatus !== "complete") {
    return `<p class="note">Waivers open once the draft is complete.</p>`;
  }
  if (!f.waivers && !f.waiversLoading && !f.waiversError) loadFantasyWaivers(f.activeLeagueId);
  return renderFantasyWaiversPanel(f.waivers, {
    error: f.waiversError,
    myUserId: f.myUserId,
    members: f.league?.members,
    isCommissioner: Boolean(league.isCommissioner),
    roster: f.league?.roster ?? [],
    freeAgentFilter: f.waiverFreeAgentFilter,
    wireFilter: f.waiverWireFilter,
    flow: f.waiverFlow,
    settingsBusy: f.waiverSettingsBusy,
    settingsError: f.waiverSettingsError,
  });
}

async function loadFantasyWaivers(leagueId) {
  const f = state.fantasy;
  if (f.waiversLoading) return;
  f.waiversLoading = true;
  f.waiversError = "";
  try {
    const waivers = await apiLoadWaivers(leagueId);
    if (f.activeLeagueId !== leagueId) return; // navigated elsewhere mid-flight
    f.waivers = waivers;
  } catch (error) {
    if (f.activeLeagueId !== leagueId) return;
    f.waiversError = error.message || "Couldn't load waivers.";
  } finally {
    if (f.activeLeagueId === leagueId) f.waiversLoading = false;
  }
  if (state.section === "fantasy") renderLayout();
}

// A silent refetch after a mutation (claim submitted/cancelled, free agent
// added, settings saved) rather than nulling f.waivers first: the panel stays
// on screen with its previous data until the fresh response lands, instead of
// flashing back to the loading note.
async function reloadFantasyWaivers() {
  const f = state.fantasy;
  const leagueId = f.activeLeagueId;
  try {
    const waivers = await apiLoadWaivers(leagueId);
    if (f.activeLeagueId !== leagueId) return;
    f.waivers = waivers;
    f.waiversError = "";
  } catch (error) {
    if (f.activeLeagueId !== leagueId) return;
    f.waiversError = error.message || "Couldn't load waivers.";
  }
  if (state.section === "fantasy") renderLayout();
}

// Refreshes just the rows container on a filter change, exactly like
// refreshFantasyPool for the draft pool: the search input and select live
// outside the container this replaces, so neither loses focus.
function refreshFantasyFreeAgentRows() {
  const list = elements.layout.querySelector("[data-fantasy-fa-list]");
  if (!list) return;
  const lockedIds = new Set(state.fantasy.waivers?.lockedPlayerIds ?? []);
  list.innerHTML = renderFantasyFreeAgentRows(state.fantasy.waivers?.freeAgents ?? [], state.fantasy.waiverFreeAgentFilter, lockedIds);
}

function refreshFantasyWireRows() {
  const list = elements.layout.querySelector("[data-fantasy-wire-list]");
  if (!list) return;
  list.innerHTML = renderFantasyWireRows(state.fantasy.waivers?.wire ?? [], state.fantasy.waiverWireFilter);
}

// Opens the add/claim confirm step for a free agent (path "free_agent") or a
// wire player (path "waiver"). The player object comes straight from the
// already-loaded waivers response rather than a fresh fetch, since both
// lists are right there in state.fantasy.waivers.
function openFantasyWaiverFlow(playerId, path) {
  const f = state.fantasy;
  if (!Number.isInteger(playerId) || !f.waivers) return;
  const player =
    path === "free_agent"
      ? (f.waivers.freeAgents ?? []).find((candidate) => candidate.id === playerId)
      : (f.waivers.wire ?? []).find((entry) => entry.player.id === playerId)?.player;
  if (!player) return;
  f.waiverFlow = { addPlayer: player, path, dropPlayerId: null, busy: false, error: "" };
  renderLayout();
}

// Submits the pending add/claim flow: an instant free-agent add or a queued
// waiver claim, reading the bid straight off the DOM (faab mode only, never
// tracked in state per keystroke - the same "read at submit time" approach
// the create/join league forms already use) rather than re-rendering the
// whole panel on every digit typed.
async function submitFantasyWaiverFlow() {
  const f = state.fantasy;
  const flow = f.waiverFlow;
  if (!flow || flow.busy || flow.dropPlayerId == null) return;
  // The bid must be read off the DOM before the busy re-render below replaces
  // elements.layout.innerHTML wholesale: renderFantasyClaimFlow always renders
  // the bid input with its hardcoded starting value (there is no per-keystroke
  // state for it, by design), so reading it any later than this would silently
  // submit that starting value instead of whatever the manager actually typed.
  const bidInput = flow.path === "waiver" ? elements.layout.querySelector("[data-fantasy-claim-bid]") : null;
  const bid = bidInput ? Number(bidInput.value) : undefined;
  flow.busy = true;
  flow.error = "";
  renderLayout();
  try {
    if (flow.path === "free_agent") {
      await apiAddFreeAgent(f.activeLeagueId, { addPlayerId: flow.addPlayer.id, dropPlayerId: flow.dropPlayerId });
      // The roster changed instantly (unlike a queued claim): refresh the
      // league's own cached roster too, so the My team pitch/bench and any
      // later drop picker see the swap immediately rather than on next visit.
      try {
        f.league = await apiLoadLeague(f.activeLeagueId);
      } catch {
        // best-effort refresh; the waivers reload below still succeeds
      }
    } else {
      await apiSubmitWaiverClaim(f.activeLeagueId, { addPlayerId: flow.addPlayer.id, dropPlayerId: flow.dropPlayerId, bid });
    }
    f.waiverFlow = null;
    await reloadFantasyWaivers();
  } catch (error) {
    flow.busy = false;
    flow.error = error.message || "Couldn't complete that.";
    renderLayout();
  }
}

async function cancelFantasyWaiverClaim(claimId) {
  if (!Number.isInteger(claimId)) return;
  try {
    await apiCancelWaiverClaim(state.fantasy.activeLeagueId, claimId);
    await reloadFantasyWaivers();
  } catch (error) {
    state.fantasy.waiversError = error.message || "Couldn't cancel that claim.";
    renderLayout();
  }
}

// Commissioner-only settings save: mode/budget are read straight off the DOM
// at click time (same reasoning as the claim flow's bid field above) rather
// than tracked per-keystroke in state.
async function saveFantasyWaiverSettings() {
  const f = state.fantasy;
  if (f.waiverSettingsBusy) return;
  const modeSelect = elements.layout.querySelector("[data-fantasy-settings-mode]");
  const budgetInput = elements.layout.querySelector("[data-fantasy-settings-budget]");
  const mode = modeSelect?.value;
  const faabBudget = Number(budgetInput?.value);
  if (!mode || !Number.isInteger(faabBudget) || faabBudget < 0) return;
  f.waiverSettingsBusy = true;
  f.waiverSettingsError = "";
  renderLayout();
  try {
    await apiSaveWaiverSettings(f.activeLeagueId, { mode, faabBudget });
    f.waiverSettingsBusy = false;
    await reloadFantasyWaivers();
  } catch (error) {
    f.waiverSettingsBusy = false;
    f.waiverSettingsError = error.message || "Couldn't save waiver settings.";
    renderLayout();
  }
}

function startFantasyLineupEdit() {
  const f = state.fantasy;
  if (!f.lineup) return;
  const captainEntry = f.lineup.starters.find((entry) => entry.isCaptain);
  f.lineupEdit = {
    starters: f.lineup.starters.map((entry) => entry.playerId),
    captainId: captainEntry?.playerId ?? f.lineup.starters[0]?.playerId ?? null,
    bench: [...f.lineup.bench],
    pendingId: null,
    saving: false,
    error: "",
  };
  renderLayout();
}

// Tapping a pitch/bench tile: in edit mode this drives the swap-selection flow
// (see handleFantasyLineupTileClick); otherwise it opens/closes that player's
// stats drawer. A second tap on the same player closes the drawer rather than
// re-opening it, matching a simple toggle.
function handleFantasyPlayerTileClick(playerId) {
  if (!Number.isInteger(playerId)) return;
  const f = state.fantasy;
  if (f.lineupEdit) {
    handleFantasyLineupTileClick(playerId);
    return;
  }
  f.playerDrawerId = f.playerDrawerId === playerId ? null : playerId;
  renderLayout();
}

// Swap-selection flow: the first tap in edit mode focuses a player
// (pendingId); a second tap on a player from the OPPOSITE group (starter vs
// bench) attempts the swap via the pure swapLineup helper, reconciling the
// working copy only on success; a second tap on the SAME group just moves the
// focus (never attempts a same-group "swap", which would be a no-op at best);
// tapping the already-pending player deselects it.
function handleFantasyLineupTileClick(playerId) {
  const edit = state.fantasy.lineupEdit;
  if (!edit) return;
  edit.error = "";

  if (edit.pendingId == null) {
    edit.pendingId = playerId;
    renderLayout();
    return;
  }
  if (edit.pendingId === playerId) {
    edit.pendingId = null;
    renderLayout();
    return;
  }

  const pendingIsStarter = edit.starters.includes(edit.pendingId);
  const targetIsStarter = edit.starters.includes(playerId);
  if (pendingIsStarter === targetIsStarter) {
    edit.pendingId = playerId;
    renderLayout();
    return;
  }

  const roster = state.fantasy.league?.roster ?? [];
  const result = swapLineup(
    { starters: edit.starters, captainId: edit.captainId, bench: edit.bench, roster },
    edit.pendingId,
    playerId,
  );
  if (!result.ok) {
    edit.error = result.error;
    edit.pendingId = null;
    renderLayout();
    return;
  }
  edit.starters = result.starters;
  edit.bench = result.bench;
  edit.captainId = result.captainId;
  edit.pendingId = null;
  renderLayout();
}

function handleFantasyMakeCaptain(playerId) {
  const edit = state.fantasy.lineupEdit;
  if (!edit || !Number.isInteger(playerId) || !edit.starters.includes(playerId)) return;
  edit.captainId = playerId;
  edit.pendingId = null;
  renderLayout();
}

async function saveFantasyLineup() {
  const f = state.fantasy;
  const edit = f.lineupEdit;
  if (!edit || edit.saving) return;
  edit.saving = true;
  edit.error = "";
  renderLayout();
  try {
    const saved = await apiSetLineup(f.activeLeagueId, { starters: edit.starters, captainId: edit.captainId });
    f.lineup = saved;
    f.lineupEdit = null;
  } catch (error) {
    edit.saving = false;
    edit.error = error.message || "Couldn't save your lineup.";
  }
  renderLayout();
}

function fantasyFormState() {
  const f = state.fantasy;
  return {
    createBusy: f.createBusy,
    createError: f.createError,
    joinBusy: f.joinBusy,
    joinError: f.joinError,
  };
}

async function loadFantasyLeagues() {
  const f = state.fantasy;
  if (f.leaguesLoading) return;
  f.leaguesLoading = true;
  f.sessionExpired = false;
  f.notDeployed = false;
  try {
    f.leagues = await apiListLeagues();
    f.loadError = "";
  } catch (error) {
    if (isFantasyNotDeployed(error)) {
      // A production client can predate the Worker's fantasy routes deploy
      // (404) or hit a Worker missing the DB/DRAFT_ROOM bindings (501); both
      // read as "not ready yet", not an error to retry.
      f.notDeployed = true;
      f.leagues = null;
    } else if (error.status === 401) {
      // A revoked/expired session renders as its own state rather than falling
      // through to "no leagues", which would look like the user genuinely has
      // none. f.leagues stays null (not []) so a later successful retry (e.g.
      // after signing back in) is not mistaken for "already loaded, empty".
      f.sessionExpired = true;
      f.leagues = null;
    } else {
      f.leagues = [];
      f.loadError = error.message || "Couldn't load your leagues.";
    }
  } finally {
    f.leaguesLoading = false;
  }
  if (state.section === "fantasy") renderLayout();
}

async function createFantasyLeague(name) {
  const trimmed = String(name ?? "").trim();
  if (!trimmed || state.fantasy.createBusy) return;
  state.fantasy.createBusy = true;
  state.fantasy.createError = "";
  renderLayout();
  try {
    const league = await apiCreateLeague(trimmed);
    state.fantasy.createBusy = false;
    state.fantasy.leagues = null; // refetch next list view so isCommissioner etc. is consistent
    renderLayout();
    await openFantasyLeague(league.id);
  } catch (error) {
    state.fantasy.createBusy = false;
    state.fantasy.createError = error.message || "Couldn't create the league.";
    renderLayout();
  }
}

async function joinFantasyLeague(code) {
  const trimmed = String(code ?? "").trim();
  if (!trimmed || state.fantasy.joinBusy) return;
  state.fantasy.joinBusy = true;
  state.fantasy.joinError = "";
  renderLayout();
  try {
    const league = await apiJoinLeague(trimmed);
    state.fantasy.joinBusy = false;
    state.fantasy.leagues = null;
    renderLayout();
    await openFantasyLeague(league.id);
  } catch (error) {
    state.fantasy.joinBusy = false;
    state.fantasy.joinError = error.message || "Couldn't join that league.";
    renderLayout();
  }
}

async function openFantasyLeague(id) {
  teardownFantasyDraftRoom();
  const f = state.fantasy;
  f.activeLeagueId = id;
  f.league = null;
  f.myUserId = null;
  f.loadError = "";
  f.notDeployed = false;
  f.subTab = "draftroom";
  f.lineup = null;
  f.lineupLoading = false;
  f.lineupError = "";
  f.lineupEdit = null;
  f.playerDrawerId = null;
  f.matchup = null;
  f.matchupLoading = false;
  f.matchupError = "";
  f.standings = null;
  f.standingsLoading = false;
  f.standingsError = "";
  f.waivers = null;
  f.waiversLoading = false;
  f.waiversError = "";
  f.waiverFlow = null;
  f.waiverSettingsBusy = false;
  f.waiverSettingsError = "";
  f.scheduleBusy = false;
  f.scheduleError = "";
  f.queue = []; // a fresh league starts with an empty shortlist, not the last one's
  renderLayout();
  try {
    const detail = await apiLoadLeague(id);
    if (f.activeLeagueId !== id) return; // navigated elsewhere mid-flight
    f.league = detail;
    f.myUserId = detail.viewerUserId ?? null;
    if (detail.league.draftStatus !== "pending") {
      await ensureFantasyPlayerPool();
      if (f.activeLeagueId === id) mountFantasyDraftRoom(id);
    }
  } catch (error) {
    if (f.activeLeagueId !== id) return;
    if (isFantasyNotDeployed(error)) f.notDeployed = true;
    else f.loadError = error.message || "Couldn't load this league.";
  }
  if (state.section === "fantasy") renderLayout();
}

// Loads the shared PL player pool once (cached across leagues for the rest of
// the session, since it isn't league-scoped data); race-guarded against a
// second concurrent call from either the draft-room mount path above or the
// lobby's own lazy trigger below.
async function ensureFantasyPlayerPool() {
  const f = state.fantasy;
  if (f.playerPool || f.playerPoolLoading) return;
  f.playerPoolLoading = true;
  try {
    f.playerPool = await loadPlayerPool();
    // Best-effort upgrade: the Worker may have blended fresher in-season xP
    // for some players once a gameweek has completed (see worker/worker.js's
    // runScheduledFantasyXpBlend). Any failure here (route not deployed yet,
    // offline) just leaves the static bake's own xp/xpBasis in place - never
    // a reason to fail the pool load itself, so no Sentry breadcrumb either.
    try {
      const blended = await loadBlendedXp();
      f.playerPool = { ...f.playerPool, players: applyBlendedXp(f.playerPool.players, blended) };
    } catch {
      // the static bake's own xp stands
    }
  } catch (error) {
    // A 404 is the expected, calm case today (the pool has never been baked
    // in production); anything else still gets a Sentry breadcrumb. Either
    // way the lobby/draft room degrade to "pool not available" rather than
    // breaking, since the pool is supplementary, not load-bearing.
    if (error?.status !== 404) window.Sentry?.captureException?.(error);
    f.playerPool = { players: [], complete: false, lastUpdated: null, unavailable: true };
  } finally {
    f.playerPoolLoading = false;
  }
}

// The lobby's own lazy trigger (renderFantasy calls this the first time it
// renders a pending-draft league without a pool yet), mirroring
// loadPaperRun()'s shape: guard against having navigated away mid-fetch, and
// only re-render if still on the page that cares.
async function loadFantasyPlayerPoolForLobby() {
  const leagueId = state.fantasy.activeLeagueId;
  await ensureFantasyPlayerPool();
  if (state.fantasy.activeLeagueId !== leagueId) return;
  if (state.section === "fantasy") renderLayout();
}

function mountFantasyDraftRoom(leagueId) {
  const controller = openDraftRoom(leagueId, {
    onMessage: (message) => {
      if (state.fantasy.activeLeagueId !== leagueId) return;
      applyFantasyDraftMessage(message);
      if (state.section !== "fantasy") return;
      // A pick/clock/error message only ever changes the draft-status header,
      // the side column and the pool rows - never which body the shell shows
      // (that only changes on "state"/"complete", or a subTab switch, both of
      // which fall through to the full render below). Patching those pieces
      // in place, rather than nuking and rebuilding elements.layout on every
      // message, is what keeps a manager's pool scroll position/filters/focus
      // intact through a turn change (see patchDraftRoomDom) - no additional
      // save/restore dance needed for this path.
      const canPatch = message.type === "pick" || message.type === "clock" || message.type === "error";
      if (!canPatch || !refreshFantasyDraftRoomLive()) renderLayout();
    },
    onTick: (remainingMs) => {
      if (state.fantasy.activeLeagueId !== leagueId || !state.fantasy.draftRoom) return;
      state.fantasy.draftRoom.remainingMs = remainingMs;
      updateFantasyClockDisplay(remainingMs);
    },
    onSocketError: (error) => {
      window.Sentry?.captureException?.(error);
    },
  });
  state.fantasy.draftRoom = { controller, state: null, remainingMs: 0 };
}

function applyFantasyDraftMessage(message) {
  const room = state.fantasy.draftRoom;
  if (!room) return;
  room.state = reduceDraftMessage(room.state, message);

  if (message.type === "error") {
    window.Sentry?.captureMessage?.(`fantasy draft error: ${message.error}`);
  }
  if (message.type === "complete") {
    // The normal teardown path (closedByCaller set, timers/backoff stopped) -
    // NOT teardownFantasyDraftRoom(), which would also null out room.state and
    // blank the complete view. openDraftRoom also treats a received "complete"
    // as terminal on its own (see fantasyDraft.js), so the reconnect loop stops
    // even if this call were ever skipped; this is the second, independent
    // layer that also actively closes the socket.
    room.controller.close();
  }
}

function updateFantasyClockDisplay(remainingMs) {
  const el = elements.layout.querySelector("[data-fantasy-clock]");
  if (el) el.textContent = formatCountdown(remainingMs);
}

// A scheduled draft's countdown ticks in place (like the pick clock above)
// rather than forcing a full renderLayout every 30 seconds: the schedule can
// be days away, so a full re-render on a fast cadence would be pure waste,
// but the number on screen should still visibly count down while a manager
// sits on the lobby. data-scheduled-at carries the raw ISO instant so this
// timer never needs its own copy of state.
let fantasyScheduleCountdownTimer = null;

function startFantasyScheduleCountdownTimer() {
  stopFantasyScheduleCountdownTimer();
  updateFantasyScheduleCountdownDisplay();
  fantasyScheduleCountdownTimer = window.setInterval(updateFantasyScheduleCountdownDisplay, 30000);
}

function stopFantasyScheduleCountdownTimer() {
  if (fantasyScheduleCountdownTimer) window.clearInterval(fantasyScheduleCountdownTimer);
  fantasyScheduleCountdownTimer = null;
}

function updateFantasyScheduleCountdownDisplay() {
  const el = elements.layout.querySelector("[data-fantasy-schedule-countdown]");
  if (!el) {
    stopFantasyScheduleCountdownTimer(); // the card left the DOM; nothing left to tick
    return;
  }
  const iso = el.dataset.scheduledAt;
  if (!iso) return;
  el.textContent = formatScheduleCountdown(new Date(iso).getTime() - Date.now());
}

// Legal-pick context for the player pool list: the live turn/roster state
// while a draft room socket is open, or an inert read-only context (no turn,
// nobody drafted) for the lobby's pre-draft scouting list, which reuses the
// exact same renderer with no Draft buttons. The queue's own top still-
// available legal pick outranks the generic heuristic for the "Pick" badge,
// matching renderFantasyDraftSide's identical rule for the suggested-pick
// card, so the two never disagree about which player is "the" suggestion.
function fantasyPoolContext() {
  const room = state.fantasy.draftRoom?.state;
  if (!room) {
    return {
      isMyTurn: false,
      myRoster: [],
      draftedIds: new Set(),
      suggestedId: null,
      queuedIds: new Set(state.fantasy.queue ?? []),
    };
  }
  const myRoster = room.rosters?.[state.fantasy.myUserId] ?? [];
  // Prune before deriving queuedIds, so a player drafted this tick loses its
  // pool-row star on the same render rather than one behind.
  state.fantasy.queue = pruneQueue(state.fantasy.queue, myRoster);
  const queuedIds = new Set(state.fantasy.queue);
  const draftedIds = new Set(
    Object.values(room.rosters ?? {})
      .flat()
      .map((player) => player.id),
  );
  const isMyTurn = room.onClockUserId != null && room.onClockUserId === state.fantasy.myUserId;
  const pool = state.fantasy.playerPool?.players ?? [];
  const suggested = topQueuedPick(state.fantasy.queue, pool, myRoster, draftedIds) ?? suggestedPick(pool, myRoster, draftedIds);
  return { isMyTurn, myRoster, draftedIds, suggestedId: suggested?.id ?? null, queuedIds };
}

function refreshFantasyPool() {
  const list = elements.layout.querySelector("[data-fantasy-pool-list]");
  if (!list) return;
  list.innerHTML = renderFantasyPlayerRows(
    state.fantasy.playerPool?.players ?? [],
    state.fantasy.filter,
    fantasyPoolContext(),
  );
}

// Targeted, scroll/focus-preserving refresh of everything in a live draft
// room that a pick or clock update can change: the "Round R · Pick N"
// header, the whole side column (suggested pick/on-the-clock/recent picks/
// queue/squad) and the pool rows - all patched via existing DOM anchors
// rather than recreating elements.layout, so the pool's own scrolling
// container (.fantasy-pool__scroll) is never torn down and its scrollTop
// never needs saving/restoring around the update in the first place. Returns
// false (the caller should fall back to a full renderLayout()) when the
// draft room isn't actually what's on screen right now - a different subTab,
// the very first "state" message before anything has been rendered, a
// completed draft (a different body entirely takes over) - since there is
// nothing to patch yet.
function patchDraftRoomDom({ members, draft, playerPool, myUserId, queue, refreshPoolRows }) {
  if (!draft || draft.status === "complete") return false;
  const statusEl = elements.layout.querySelector("[data-fantasy-draftstatus]");
  const sideEl = elements.layout.querySelector("[data-fantasy-draft-side]");
  const errorEl = elements.layout.querySelector("[data-fantasy-error-slot]");
  const poolListEl = elements.layout.querySelector("[data-fantasy-pool-list]");
  if (!statusEl || !sideEl || !errorEl || !poolListEl) return false;

  const entries = draftOrderEntries(draft.memberIds, draft.round, draft.onClockUserId, draft.overallPick);
  errorEl.innerHTML = draft.lastError ? renderDraftErrorNotice(draft.lastError) : "";
  statusEl.innerHTML = renderDraftStatusCard({ members, draft, myUserId, season: currentSeasonLabel(), entries });
  sideEl.innerHTML = renderFantasyDraftSide({ members, draft, playerPool, myUserId, entries, queue });
  refreshPoolRows();
  return true;
}

function refreshFantasyDraftRoomLive() {
  const f = state.fantasy;
  const room = f.draftRoom?.state;
  if (!room) return false;
  if ((f.subTab ?? "draftroom") !== "draftroom") return false;
  return patchDraftRoomDom({
    members: f.league?.members,
    draft: { ...room, remainingMs: f.draftRoom.remainingMs },
    playerPool: f.playerPool?.players ?? [],
    myUserId: f.myUserId,
    queue: f.queue,
    refreshPoolRows: refreshFantasyPool,
  });
}

async function startFantasyDraft(id) {
  await apiStartDraft(id);
  await openFantasyLeague(id);
}

// Reads the lobby's datetime-local input (local time), converts it to the
// UTC ISO the schedule route stores, and reloads the league detail so the
// lobby immediately shows the confirmed schedule (or a plain-English error
// if the Worker rejected it, e.g. a past date or one too far out - see
// src/fantasyScheduling.js's validateDraftSchedule).
async function saveFantasyLeagueSchedule() {
  const f = state.fantasy;
  const input = elements.layout.querySelector("[data-fantasy-schedule-input]");
  const localValue = input?.value ?? "";
  const scheduledAtIso = localInputValueToUtcIso(localValue);
  if (!scheduledAtIso) {
    f.scheduleError = "Pick a date and time first.";
    renderLayout();
    return;
  }
  f.scheduleBusy = true;
  f.scheduleError = "";
  renderLayout();
  try {
    await apiScheduleDraft(f.activeLeagueId, scheduledAtIso);
    f.scheduleBusy = false;
    await openFantasyLeague(f.activeLeagueId);
  } catch (error) {
    f.scheduleBusy = false;
    f.scheduleError = error.message || "Couldn't schedule the draft.";
    renderLayout();
  }
}

async function clearFantasyLeagueSchedule() {
  const f = state.fantasy;
  f.scheduleBusy = true;
  f.scheduleError = "";
  renderLayout();
  try {
    await apiUnscheduleDraft(f.activeLeagueId);
    f.scheduleBusy = false;
    await openFantasyLeague(f.activeLeagueId);
  } catch (error) {
    f.scheduleBusy = false;
    f.scheduleError = error.message || "Couldn't clear the schedule.";
    renderLayout();
  }
}

function closeFantasyLeague() {
  teardownFantasyDraftRoom();
  const f = state.fantasy;
  f.activeLeagueId = null;
  f.league = null;
  f.myUserId = null;
  f.leagues = null; // refetch so status/member counts are current
  f.loadError = "";
  f.sessionExpired = false;
  f.notDeployed = false;
  f.lineup = null;
  f.lineupLoading = false;
  f.lineupError = "";
  f.lineupEdit = null;
  f.playerDrawerId = null;
  f.matchup = null;
  f.matchupLoading = false;
  f.matchupError = "";
  f.standings = null;
  f.standingsLoading = false;
  f.standingsError = "";
  f.waivers = null;
  f.waiversLoading = false;
  f.waiversError = "";
  f.waiverFlow = null;
  f.waiverSettingsBusy = false;
  f.waiverSettingsError = "";
  f.scheduleBusy = false;
  f.scheduleError = "";
  renderLayout();
}

function teardownFantasyDraftRoom() {
  state.fantasy.draftRoom?.controller.close();
  state.fantasy.draftRoom = null;
}

// -- Signed-out demo: draft, compressed season, report card ---------------------
//
// Client-side only, no Worker route, no D1, nothing here ever touches a real
// league. The draft itself reuses the exact same reducer/renderer the live
// draft room uses (see fantasyDemo.js's header comment for the full list of
// reused modules): rather than a second WebSocket-shaped state machine, a
// local pick is fed through the same reduceDraftMessage a real socket message
// would produce, so this can never drift from the real draft rules.

function renderDemo() {
  const d = state.demo;

  if (d.stage === "setup") {
    elements.layout.innerHTML = renderDemoSetup({ name: d.name, size: d.size, clock: d.clock, busy: d.busy });
    return;
  }

  if (d.stage === "drafting") {
    if (!d.room) {
      elements.layout.innerHTML = `<p class="note">Setting up your draft…</p>`;
      return;
    }
    const wasSearchFocused = document.activeElement?.matches?.("[data-fantasy-search]");
    const caret = wasSearchFocused ? document.activeElement.selectionStart : null;
    elements.layout.innerHTML = renderFantasyDraftRoom({
      members: d.members,
      draft: { ...d.room, remainingMs: d.remainingMs },
      playerPool: d.pool?.players ?? [],
      filter: d.filter,
      myUserId: d.humanId,
      priorSeasonStats: d.pool?.priorSeasonStats,
      queue: d.queue,
    });
    if (wasSearchFocused) {
      const input = elements.layout.querySelector("[data-fantasy-search]");
      if (input) {
        input.focus();
        input.setSelectionRange(caret, caret);
      }
    }
    return;
  }

  if (d.stage === "rolling") {
    elements.layout.innerHTML = renderDemoRoll({
      gameweek: d.rollGameweek,
      totalGameweeks: DEMO_SEASON_GAMEWEEKS,
      standings: standingsThroughGameweek(d.season, d.members, d.rollGameweek),
      humanId: d.humanId,
      done: d.rollDone,
    });
    // The ONLY place a roll's timer (or its reduced-motion equivalent) is
    // ever started - both the initial kick-off (startDemoRollFrom, which
    // sets rollDone/rollTimer to their "just started" values and calls
    // renderLayout, landing straight here) and "navigated away and back
    // mid-roll" (via the section nav; teardownDemo clears the in-flight
    // timer) route through this exact check. A second call site used to
    // ALSO call scheduleNextDemoRollStep explicitly right after
    // renderLayout(), which raced with this same check firing on that same
    // render and started two concurrent timer chains - harmless for the old
    // one-shot 38-gameweek roll, but it meant finishDemoChunkRoll (and so
    // openDemoDesk) could fire twice for one chunk, silently discarding the
    // waiver result the desk was about to show. One call site removes the
    // race entirely.
    if (!d.rollDone && !d.rollTimer) {
      const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      if (reducedMotion) finishDemoChunkRoll();
      else scheduleNextDemoRollStep();
    }
    return;
  }

  if (d.stage === "desk") {
    renderDemoDeskStage();
    return;
  }

  if (d.stage === "report") {
    elements.layout.innerHTML = renderDemoReportCard({
      reportCard: d.reportCard,
      isSignedIn: isSignedIn(),
      shareStatus: d.shareStatus,
    });
  }
}

// The desk's own render, split out of renderDemo purely because it needs a
// handful of derived view-model pieces (standings/form/wire/panel html) that
// would otherwise clutter the simple stage dispatch above.
function renderDemoDeskStage() {
  const d = state.demo;
  const season = d.season;
  const desk = d.desk;
  if (!season || !desk) return;

  const standings = standingsThroughGameweek(season, d.members, season.simulatedThrough);
  const form = demoManagerForm(season.fixtures, d.humanId, season.simulatedThrough);
  const news = season.history[season.history.length - 1] ?? null;
  const waiverWire = availableWaiverPlayers(season).map((player) => ({
    player,
    points: season.seasonPointsByPlayer.get(player.id) ?? 0,
  }));
  const roster = season.rosters.get(d.humanId) ?? [];

  const wasSearchFocused = document.activeElement?.matches?.("[data-fantasy-search]");
  elements.layout.innerHTML = renderDemoDesk({
    season,
    humanId: d.humanId,
    fromGw: desk.fromGw,
    toGw: desk.toGw,
    standings,
    form,
    news,
    waiverWire,
    roster,
    waiverTarget: desk.waiverTarget,
    pendingDropId: desk.pendingDropId,
    waiverPick: desk.waiverPick,
    lastWaiverResult: desk.lastWaiverResult,
    lastWaiverPlayerName: desk.lastWaiverPlayerName,
    rosterPanelHtml: renderFantasyRosterPanel({
      currentGameweek: desk.fromGw,
      roster,
      lineup: demoLineupForPanel(season, d.humanId),
      playerPool: d.pool?.players ?? [],
      picks: [],
      editState: desk.lineupEdit,
      drawerPlayerId: desk.drawerPlayerId,
      lineupError: "",
      priorSeasonStats: d.pool?.priorSeasonStats,
      xpStats: d.pool?.xpStats,
    }),
    isFinal: isFinalChunk(season),
  });
  if (wasSearchFocused) {
    const input = elements.layout.querySelector("[data-fantasy-search]");
    if (input) input.focus();
  }
}

function teardownDemo() {
  clearDemoDraftTimers();
  if (state.demo.rollTimer) window.clearTimeout(state.demo.rollTimer);
  state.demo.rollTimer = null;
}

function clearDemoDraftTimers() {
  const d = state.demo;
  if (d.botTimer) window.clearTimeout(d.botTimer);
  if (d.clockTimer) window.clearInterval(d.clockTimer);
  d.botTimer = null;
  d.clockTimer = null;
}

// Kicks off a fresh trial: loads the same static player pool the real product
// bakes (data/PL/players.json, no auth needed) plus the real PL fixture list
// (data/PL/live.json, for fixture-aware scoring - see fantasyDemoFixtures.js),
// builds the manager list, and opens the draft room. `startBusy` toggles the
// setup screen's own button state while both fetches are in flight (usually
// instant - both files are tiny and same-origin - but never assumed to be).
async function startDemoDraft() {
  const d = state.demo;
  const nameInput = elements.layout.querySelector("[data-demo-name]");
  if (nameInput) d.name = nameInput.value;
  d.busy = true;
  renderLayout();

  if (!d.pool) {
    try {
      d.pool = await loadPlayerPool();
    } catch (error) {
      if (error?.status !== 404) window.Sentry?.captureException?.(error);
      d.pool = { players: [], unavailable: true };
    }
  }
  if (!d.fixtureData) {
    // A missing/unreachable feed degrades the season to its pre-fixture flat
    // scoring (see initDemoSeason's hasFixtureData branch) rather than
    // blocking the trial on a feed that may never have been deployed.
    try {
      const raw = await loadPlFixtureData();
      d.fixtureData = { matches: raw.matches ?? [], standingsMap: standingsMapFromRawPayload(raw) };
    } catch (error) {
      if (error?.status !== 404) posthog.captureException(error);
      d.fixtureData = null;
    }
  }
  if (state.section !== "demo") return; // navigated away mid-fetch

  const { members, humanId } = createDemoMembers(d.size, d.name);
  d.members = members;
  d.humanId = humanId;
  d.seed = `demo-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  d.room = initDemoDraftRoom(members.map((member) => member.userId));
  d.filter = { position: "All", club: "All", search: "", hideTaken: true };
  d.queue = [];
  d.busy = false;
  d.stage = "drafting";
  posthog.capture("demo_draft_started", { league_size: d.size, clock: d.clock });
  // scheduleDemoTurn first, same reasoning as applyDemoPickAndAdvance: it
  // sets d.remainingMs (a real duration, or null for untimed) before the
  // first paint, so round 1 pick 1's on-clock card never flashes the
  // pre-draft default of "0:00" for a manager who chose an untimed clock.
  scheduleDemoTurn();
  renderLayout();
}

// Decides what happens next for whoever is on the clock: a bot autopicks
// after a short, deliberately visible delay (DEMO_BOT_PICK_DELAY_MS),
// unaffected by the human's own clock choice. The human gets the pick clock
// chosen on the setup screen (d.clock - seconds, or DEMO_CLOCK_UNTIMED); an
// untimed clock never starts a timer at all, so nothing autopicks on the
// human's own turn - they draft manually whenever they're ready.
function scheduleDemoTurn() {
  const d = state.demo;
  if (!d.room || isDemoDraftComplete(d.room)) return;
  clearDemoDraftTimers();
  const manager = d.members.find((member) => member.userId === d.room.onClockUserId);
  if (!manager) return;
  if (manager.isBot) {
    d.botTimer = window.setTimeout(() => {
      const pick = autoPickForRoom(d.room, d.pool?.players ?? []);
      if (pick) applyDemoPickAndAdvance(pick);
    }, DEMO_BOT_PICK_DELAY_MS);
  } else {
    const durationMs = demoClockDurationMs(d.clock);
    if (durationMs == null) {
      d.remainingMs = null; // untimed: renderOnClockCard shows "No clock" for this
      return;
    }
    startDemoHumanClock(durationMs);
  }
}

function startDemoHumanClock(durationMs) {
  const d = state.demo;
  d.remainingMs = durationMs;
  updateDemoClockDisplay(d.remainingMs);
  d.clockTimer = window.setInterval(() => {
    d.remainingMs = Math.max(0, d.remainingMs - 1000);
    updateDemoClockDisplay(d.remainingMs);
    if (d.remainingMs <= 0) {
      window.clearInterval(d.clockTimer);
      d.clockTimer = null;
      // The clock expiring falls back to the manager's own queue first - the
      // top still-available, still-legal queued player - before the generic
      // scarcest-bucket heuristic, exactly what makes a short or untimed
      // clock survivable rather than a coin flip on what gets autodrafted.
      const myRoster = d.room.rosters?.[d.humanId] ?? [];
      const draftedIds = draftedPlayerIds(d.room);
      const queuedPick = topQueuedPick(d.queue, d.pool?.players ?? [], myRoster, draftedIds);
      const pick = queuedPick ?? autoPickForRoom(d.room, d.pool?.players ?? []);
      if (pick) applyDemoPickAndAdvance(pick);
    }
  }, 1000);
}

function updateDemoClockDisplay(remainingMs) {
  const el = elements.layout.querySelector("[data-fantasy-clock]");
  if (el) el.textContent = formatCountdown(remainingMs);
}

// Applies one pick (a manual human click or an autopick) and advances the
// room exactly like a real "pick" -> "clock"/"complete" message pair (see
// applyDemoPick in fantasyDemo.js). Once the draft is complete this hands off
// to the season simulation rather than rendering a separate "draft complete"
// pause screen - the whole point of the demo is momentum, not another click.
// scheduleDemoTurn runs before the repaint (not after, as it used to) so the
// on-clock card's countdown/"No clock" already reflects the new picker by
// the time refreshDemoDraftRoomLive/renderLayout actually paints it, rather
// than showing the previous picker's stale number for one frame.
function applyDemoPickAndAdvance(player) {
  const d = state.demo;
  clearDemoDraftTimers();
  d.room = applyDemoPick(d.room, player);
  if (isDemoDraftComplete(d.room)) {
    beginDemoSeason();
    return;
  }
  scheduleDemoTurn();
  if (!refreshDemoDraftRoomLive()) renderLayout();
}

function refreshDemoPool() {
  const list = elements.layout.querySelector("[data-fantasy-pool-list]");
  if (!list) return;
  list.innerHTML = renderFantasyPlayerRows(state.demo.pool?.players ?? [], state.demo.filter, demoPoolContext());
}

function demoPoolContext() {
  const d = state.demo;
  const room = d.room;
  if (!room) {
    return {
      isMyTurn: false,
      myRoster: [],
      draftedIds: new Set(),
      suggestedId: null,
      queuedIds: new Set(d.queue ?? []),
    };
  }
  const myRoster = room.rosters?.[d.humanId] ?? [];
  d.queue = pruneQueue(d.queue, myRoster);
  const queuedIds = new Set(d.queue);
  const draftedIds = new Set(
    Object.values(room.rosters ?? {})
      .flat()
      .map((player) => player.id),
  );
  const isMyTurn = room.onClockUserId != null && room.onClockUserId === d.humanId;
  const pool = d.pool?.players ?? [];
  const suggested = topQueuedPick(d.queue, pool, myRoster, draftedIds) ?? suggestedPick(pool, myRoster, draftedIds);
  return { isMyTurn, myRoster, draftedIds, suggestedId: suggested?.id ?? null, queuedIds };
}

// The demo's own equivalent of refreshFantasyDraftRoomLive: same targeted
// patch (status header, side column, pool rows), same reason (never
// recreate the pool's scrolling container on a bot pick or a clock tick's
// pick). Shared via patchDraftRoomDom rather than duplicated, since both
// callers render from the exact same renderFantasyDraftRoom/
// renderFantasyDraftSide output.
function refreshDemoDraftRoomLive() {
  const d = state.demo;
  if (!d.room) return false;
  return patchDraftRoomDom({
    members: d.members,
    draft: { ...d.room, remainingMs: d.remainingMs },
    playerPool: d.pool?.players ?? [],
    myUserId: d.humanId,
    queue: d.queue,
    refreshPoolRows: refreshDemoPool,
  });
}

const DEMO_ROLL_STEP_MS = 50; // ~2s to reveal a 7-gameweek chunk: "a second or two total" per pause

// Builds the season's starting state the instant the draft completes
// (initDemoSeason is synchronous and cheap), then plays the first chunk. Every
// later chunk is kicked off the same way from continueDemoDesk/beginDemoSimToEnd.
function beginDemoSeason() {
  const d = state.demo;
  const rosters = new Map(d.members.map((member) => [member.userId, d.room.rosters[member.userId] ?? []]));
  d.season = initDemoSeason({
    seed: d.seed,
    members: d.members,
    rosters,
    pool: d.pool?.players ?? [],
    matches: d.fixtureData?.matches ?? [],
    standingsMap: d.fixtureData?.standingsMap,
  });
  startDemoChunkRoll();
}

// Simulates the NEXT chunk (advanceDemoSeasonChunk is synchronous and cheap -
// a handful of managers times 15-ish scoreable players times up to 7
// gameweeks) then animates revealing it gameweek by gameweek, exactly the
// old whole-season roll's own pacing, just scoped to one chunk.
// prefers-reduced-motion skips straight past the reveal, same as "Skip to
// result" would. See beginDemoSimToEnd for the "watch" escape hatch's own
// roll bootstrap, which reveals a much longer stretch in one go and so does
// not call this.
function startDemoChunkRoll() {
  const d = state.demo;
  const fromGw = d.season.simulatedThrough + 1;
  d.season = advanceDemoSeasonChunk(d.season);
  startDemoRollFrom(fromGw, d.season.simulatedThrough);
}

// Sets up the roll's state and paints it once - renderDemo's own rolling-
// stage branch is the single place that then starts the timer (or, under
// reduced motion, finishes immediately), see the comment there.
function startDemoRollFrom(fromGw, toGw) {
  const d = state.demo;
  d.stage = "rolling";
  d.rollFromGw = fromGw;
  d.rollToGw = toGw;
  d.rollGameweek = fromGw - 1;
  d.rollDone = false;
  renderLayout();
}

function scheduleNextDemoRollStep() {
  const d = state.demo;
  d.rollTimer = window.setTimeout(() => {
    d.rollTimer = null;
    d.rollGameweek += 1;
    if (d.rollGameweek >= d.rollToGw) {
      finishDemoChunkRoll();
    } else {
      // Reschedule BEFORE rendering: renderLayout -> renderDemo's rolling-stage
      // self-healing check (see renderDemo) fires whenever it sees
      // !d.rollTimer, and d.rollTimer is null for this one tick (just cleared
      // above). Rendering first used to let that check start a SECOND
      // concurrent timer chain on every single intermediate step, which
      // compounded across a 7-gameweek chunk into openDemoDesk (and so the
      // waiver-result note) firing many times, the last of which always saw
      // an already-cleared pendingWaiverResult. Setting rollTimer again
      // first closes that window.
      scheduleNextDemoRollStep();
      renderLayout();
    }
  }, DEMO_ROLL_STEP_MS);
}

// Once a chunk's reveal finishes: either the season is over (report card), or
// there is a desk to show - UNLESS "sim to the end" is playing, in which case
// the whole rest of the season was already resolved before this roll started
// (see beginDemoSimToEnd), so isDemoSeasonComplete is already true and this
// always lands on the report.
function finishDemoChunkRoll() {
  const d = state.demo;
  if (d.rollTimer) window.clearTimeout(d.rollTimer);
  d.rollTimer = null;
  d.rollGameweek = d.rollToGw;
  d.rollDone = true;
  if (isDemoSeasonComplete(d.season)) {
    finishDemoSeason();
  } else {
    openDemoDesk();
  }
}

function finishDemoSeason() {
  const d = state.demo;
  // buildDemoReportCard reads season.standings directly (see its own header
  // comment: callers hand it the final table); the stepwise engine never
  // computes one itself mid-season (standingsThroughGameweek is how the roll
  // and the desk get an intermediate one on demand), so it is computed once,
  // here, for the whole season now that it is actually over.
  const finalStandings = standingsThroughGameweek(d.season, d.members, d.season.gameweeks);
  const season = { ...d.season, standings: finalStandings };
  d.reportCard = buildDemoReportCard({ humanId: d.humanId, members: d.members, season });
  d.stage = "report";
  posthog.capture("demo_report_viewed", { position: d.reportCard.position, league_size: d.reportCard.leagueSize });
  renderLayout();
}

// -- Manager desk (between chunks) -----------------------------------------------

// The desk's lineup panel wants the real product's own { starters, bench,
// source } shape (renderFantasyRosterPanel/fantasyLineups.js), not
// season.lineups' bare { starters }, so bench is derived here rather than
// carried in the season state (nothing about "who's on the bench" needs to
// survive a chunk boundary; it's always just "roster minus starters").
function demoLineupForPanel(season, userId) {
  const roster = season.rosters.get(userId) ?? [];
  const lineup = season.lineups.get(userId);
  const starterIds = new Set((lineup?.starters ?? []).map((entry) => entry.playerId));
  const bench = roster.filter((player) => !starterIds.has(player.id)).map((player) => player.id);
  return { starters: lineup?.starters ?? [], bench, source: "current" };
}

function openDemoDesk() {
  const d = state.demo;
  d.stage = "desk";
  d.desk = {
    fromGw: d.rollFromGw,
    toGw: d.rollToGw,
    waiverTarget: null,
    pendingDropId: null,
    waiverPick: null,
    lastWaiverResult: d.pendingWaiverResult ?? null,
    lastWaiverPlayerName: d.pendingWaiverPlayerName ?? null,
    lineupEdit: null,
    drawerPlayerId: null,
  };
  d.pendingWaiverResult = null;
  d.pendingWaiverPlayerName = null;
  renderLayout();
}

function startDemoLineupEdit() {
  const d = state.demo;
  if (!d.desk) return;
  const lineup = demoLineupForPanel(d.season, d.humanId);
  const captainEntry = lineup.starters.find((entry) => entry.isCaptain);
  d.desk.lineupEdit = {
    starters: lineup.starters.map((entry) => entry.playerId),
    captainId: captainEntry?.playerId ?? lineup.starters[0]?.playerId ?? null,
    bench: [...lineup.bench],
    pendingId: null,
    saving: false,
    error: "",
  };
  renderLayout();
}

// Mirrors handleFantasyPlayerTileClick/handleFantasyLineupTileClick exactly
// (see the real fantasy lineup edit above), just against state.demo.desk
// instead of state.fantasy, and swapLineup/validateLineupSelection stay the
// same real pure functions either way.
function handleDemoPlayerTileClick(playerId) {
  const d = state.demo;
  if (!d.desk || !Number.isInteger(playerId)) return;
  if (d.desk.lineupEdit) {
    handleDemoLineupSwap(playerId);
    return;
  }
  d.desk.drawerPlayerId = d.desk.drawerPlayerId === playerId ? null : playerId;
  renderLayout();
}

function handleDemoLineupSwap(playerId) {
  const d = state.demo;
  const edit = d.desk?.lineupEdit;
  if (!edit) return;
  edit.error = "";

  if (edit.pendingId == null) {
    edit.pendingId = playerId;
    renderLayout();
    return;
  }
  if (edit.pendingId === playerId) {
    edit.pendingId = null;
    renderLayout();
    return;
  }
  const pendingIsStarter = edit.starters.includes(edit.pendingId);
  const targetIsStarter = edit.starters.includes(playerId);
  if (pendingIsStarter === targetIsStarter) {
    edit.pendingId = playerId;
    renderLayout();
    return;
  }

  const roster = d.season.rosters.get(d.humanId) ?? [];
  const result = swapLineup({ starters: edit.starters, captainId: edit.captainId, bench: edit.bench, roster }, edit.pendingId, playerId);
  if (!result.ok) {
    edit.error = result.error;
    edit.pendingId = null;
    renderLayout();
    return;
  }
  edit.starters = result.starters;
  edit.bench = result.bench;
  edit.captainId = result.captainId;
  edit.pendingId = null;
  renderLayout();
}

function handleDemoMakeCaptain(playerId) {
  const edit = state.demo.desk?.lineupEdit;
  if (!edit || !Number.isInteger(playerId) || !edit.starters.includes(playerId)) return;
  edit.captainId = playerId;
  edit.pendingId = null;
  renderLayout();
}

// Validates via the REAL validateLineupSelection (fantasyLineups.js, inside
// saveDemoLineup) before ever touching the season state, exactly like the
// real product's saveFantasyLineup never trusts the pitch UI alone.
function saveDemoLineupEdit() {
  const d = state.demo;
  const edit = d.desk?.lineupEdit;
  if (!edit) return;
  const result = saveDemoLineup(d.season, d.humanId, { starters: edit.starters, captainId: edit.captainId });
  if (!result.ok) {
    edit.error = result.error;
    renderLayout();
    return;
  }
  d.season = result.season;
  d.desk.lineupEdit = null;
  renderLayout();
}

// -- Manager desk: waiver claim flow ----------------------------------------------

function openDemoWaiverClaim(playerId) {
  const d = state.demo;
  if (!d.desk) return;
  const player = d.season.rosterById.get(playerId);
  if (!player) return;
  d.desk.waiverTarget = player;
  d.desk.pendingDropId = null;
  renderLayout();
}

function chooseDemoClaimDrop(playerId) {
  const d = state.demo;
  if (!d.desk?.waiverTarget) return;
  d.desk.pendingDropId = playerId;
  renderLayout();
}

function cancelDemoWaiverClaim() {
  const d = state.demo;
  if (!d.desk) return;
  d.desk.waiverTarget = null;
  d.desk.pendingDropId = null;
  renderLayout();
}

// Queues the human's own claim locally - it does not touch the season yet.
// Resolution (against bots' own deterministic claims, via the real
// resolveWaiverRun) happens once, all together, when the desk is continued
// (continueDemoDesk), the same "everyone's claims from this window are
// judged in one contested run" shape the real waiver system uses.
function confirmDemoWaiverClaim() {
  const d = state.demo;
  const target = d.desk?.waiverTarget;
  if (!target || d.desk.pendingDropId == null) return;
  d.desk.waiverPick = { addPlayerId: target.id, dropPlayerId: d.desk.pendingDropId };
  d.desk.waiverTarget = null;
  d.desk.pendingDropId = null;
  renderLayout();
}

// Resolves this desk's waiver window (the human's queued claim, if any, plus
// every bot's own deterministic claim - see submitDemoWaiverClaims), stashes
// the human's own result to show at the TOP of the next desk (real waiver
// claims resolve after the fact, not instantly - see fantasyWaivers.js's
// header comment), discards any unsaved lineup edit, and starts the next
// chunk's roll.
function continueDemoDesk() {
  const d = state.demo;
  const humanClaim = d.desk.waiverPick;
  const { season, humanResult } = submitDemoWaiverClaims(d.season, { humanId: d.humanId, humanClaim });
  d.season = season;
  d.pendingWaiverResult = humanResult;
  d.pendingWaiverPlayerName = humanClaim ? season.rosterById.get(humanClaim.addPlayerId)?.name ?? null : null;
  d.desk = null;
  posthog.capture("demo_desk_continued", { made_waiver_claim: Boolean(humanClaim) });
  startDemoChunkRoll();
}

// The "watch" escape hatch: resolves every remaining chunk's waivers/injury
// management for the human exactly like a bot (simulateDemoSeasonToEnd),
// then lets the roll animate continuously from wherever the human left off
// straight through to gameweek 38 - no further desks, no further decisions.
function beginDemoSimToEnd() {
  const d = state.demo;
  const fromGw = d.season.simulatedThrough + 1;
  d.desk = null;
  posthog.capture("demo_sim_to_end", { at_gameweek: d.season.simulatedThrough });
  d.season = simulateDemoSeasonToEnd(d.season, { humanId: d.humanId });
  startDemoRollFrom(fromGw, d.season.gameweeks);
}

function shareDemoResult(button) {
  const d = state.demo;
  if (!d.reportCard) return;
  const link = `${window.location.origin}${window.location.pathname}#demo`;
  const text = composeDemoShareText(d.reportCard, link);
  sharePaperRun(text).then((status) => {
    d.shareStatus =
      status === "shared"
        ? "Shared"
        : status === "copied"
          ? "Copied to clipboard"
          : status === "cancelled"
            ? "Share your result"
            : "Copy unavailable";
    if (button) button.textContent = d.shareStatus;
  });
}

function restartDemo() {
  teardownDemo();
  const name = state.demo.name;
  const size = state.demo.size;
  const clock = state.demo.clock;
  state.demo = initialDemoState();
  state.demo.name = name;
  state.demo.size = size;
  state.demo.clock = clock;
  renderLayout();
}

// -- Learn section -----------------------------------------------------------

// state.learn.slug null renders the index; a real slug renders that tutorial.
// tutorialBySlug returning null (a stale/bad slug, e.g. someone editing the
// hash by hand) falls back to the index rather than a blank panel.
function renderLearn() {
  const tutorial = state.learn.slug ? tutorialBySlug(state.learn.slug) : null;
  elements.layout.innerHTML = tutorial
    ? renderTutorial(tutorial, { resolverMode: state.learn.resolverMode })
    : renderTutorialIndex(TUTORIALS);
}

// Opens a tutorial by slug, from anywhere in the app (the index card itself,
// or a contextual link like the Waivers panel's "How do waivers work?").
// Unknown slugs are ignored rather than navigating to a blank tutorial.
function openTutorial(slug) {
  if (!tutorialBySlug(slug)) return;
  const changingSection = state.section !== "learn";
  state.section = "learn";
  state.learn.slug = slug;
  state.learn.resolverMode = "faab";
  window.history.replaceState(null, "", `#learn/${slug}`);
  posthog.capture("tutorial_opened", { slug });
  if (changingSection) renderAll();
  else renderLayout();
}

function closeTutorial() {
  state.learn.slug = null;
  window.history.replaceState(null, "", "#learn");
  renderLayout();
}

// -- Device push controls ---------------------------------------------------------

// Fills the "This device" slot in the Notifications card based on real browser
// state (permission + live subscription), never a stored flag.
async function updatePushControls(note = "") {
  const slot = elements.layout.querySelector("[data-push-controls]");
  if (!slot) return;
  const current = await pushState();
  if (!elements.layout.querySelector("[data-push-controls]")) return; // re-rendered meanwhile
  if (current === "unsupported") {
    slot.innerHTML = `<span class="note">Not supported in this browser.</span>`;
  } else if (current === "denied") {
    slot.innerHTML = `<span class="note">Blocked in browser settings.</span>`;
  } else if (current === "off") {
    slot.innerHTML = `${note ? `<span class="note">${note}</span> ` : ""}<button class="seg" type="button" data-push-enable>Enable on this device</button>`;
  } else {
    slot.innerHTML = `${note ? `<span class="note">${note}</span> ` : ""}<button class="seg" type="button" data-push-test>Send test</button> <button class="seg" type="button" data-push-disable>Disable</button>`;
  }
}

// -- Navigation & controls -----------------------------------------------------------

function syncNav() {
  [elements.sectionNav, elements.bottomNav].forEach((nav) => {
    nav.querySelectorAll("[data-section-nav]").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.sectionNav === state.section);
    });
  });
}

function setSection(section) {
  if (state.section === section) return;
  state.section = section;
  // A nav click always lands on that section's own default view: Learn's is
  // the tutorials index, not wherever a previous visit left off.
  if (section === "learn") state.learn.slug = null;
  window.history.replaceState(null, "", `#${section === "scores" ? state.tab : section}`);
  metric("count", "section_view", 1, { tags: { section } });
  posthog.capture("section_viewed", { section });
  renderAll();
}

// Header auth control: "Sign in" pill signed out, avatar chip signed in.
function syncAccountButton() {
  const button = document.getElementById("accountBtn");
  if (!button) return;
  const account = currentAccount();
  if (account) {
    const initial = (account.user.name ?? account.user.email ?? "?").trim()[0]?.toUpperCase() ?? "?";
    button.classList.add("is-avatar");
    button.innerHTML = account.user.avatar
      ? `<img src="${account.user.avatar.replace(/"/g, "&quot;")}" alt="Your account" referrerpolicy="no-referrer" />`
      : initial;
    button.title = account.user.email;
  } else {
    button.classList.remove("is-avatar");
    button.textContent = "Sign in";
    button.title = "";
  }
}

function setTab(tab) {
  state.section = "scores";
  state.tab = tab;
  window.history.replaceState(null, "", `#${tab}`);
  metric("count", "tab_view", 1, { tags: { tab } });
  posthog.capture("tab_viewed", { tab });
  renderAll();
}

function wireNav() {
  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-section-nav]");
    if (button && !button.disabled) setSection(button.dataset.sectionNav);
  });
}

async function switchCompetition(code) {
  if (!COMPETITIONS[code] || code === state.competition) return;
  state.competition = code;
  try {
    window.localStorage.setItem(COMPETITION_STORAGE_KEY, code);
  } catch {
    // storage may be blocked; the switch still applies for this visit
  }
  metric("count", "competition_switch", 1, { tags: { competition: code } });
  posthog.capture("competition_switched", { competition: code });

  const fresh = await loadModel(code);
  if (state.competition !== code) return; // switched again while loading
  model = fresh;
  setMatchModel(model);
  if (model.hasData) {
    lastFetchAt = Date.now();
    lastSignature = matchSignature(model);
  }
  renderAll();
  setUpdatedLabel();
}

function wireLayoutControls() {
  elements.layout.addEventListener("click", (event) => {
    // The demo screen reuses several of the real Fantasy section's data
    // attributes (data-fantasy-draft-player, data-fantasy-position-filter) so
    // it can reuse renderFantasyDraftRoom verbatim; intercept them here first
    // so a demo click never falls through into the real fantasy handlers
    // further down (which would act on state.fantasy, not state.demo).
    if (state.section === "demo") {
      const demoDraftButton = event.target.closest("[data-fantasy-draft-player]");
      if (demoDraftButton) {
        demoDraftButton.disabled = true;
        const id = Number(demoDraftButton.dataset.fantasyDraftPlayer);
        const player = (state.demo.pool?.players ?? []).find((candidate) => candidate.id === id);
        if (player) applyDemoPickAndAdvance(player);
        return;
      }
      const demoPositionButton = event.target.closest("[data-fantasy-position-filter]");
      if (demoPositionButton) {
        state.demo.filter.position = demoPositionButton.dataset.fantasyPositionFilter;
        elements.layout.querySelectorAll("[data-fantasy-position-filter]").forEach((button) => {
          button.classList.toggle("is-active", button === demoPositionButton);
        });
        refreshDemoPool();
        return;
      }
      if (event.target.closest("[data-demo-start]")) {
        startDemoDraft();
        return;
      }
      const demoSizeButton = event.target.closest("[data-demo-size]");
      if (demoSizeButton) {
        // Picking a league size re-renders the whole setup card (simplest way
        // to move the "is-active" pill); capture whatever the manager has
        // already typed first, or that re-render would wipe it back to blank.
        const nameInput = elements.layout.querySelector("[data-demo-name]");
        if (nameInput) state.demo.name = nameInput.value;
        state.demo.size = Number(demoSizeButton.dataset.demoSize);
        renderLayout();
        return;
      }
      const demoClockButton = event.target.closest("[data-demo-clock]");
      if (demoClockButton) {
        // Same "re-render the whole setup card" shape as league size above,
        // and the same reason: capture the name field first or the re-render
        // (needed to move the is-active pill) would wipe it.
        const nameInput = elements.layout.querySelector("[data-demo-name]");
        if (nameInput) state.demo.name = nameInput.value;
        state.demo.clock = demoClockButton.dataset.demoClock;
        renderLayout();
        return;
      }
      const demoHideTakenButton = event.target.closest("[data-fantasy-hide-taken]");
      if (demoHideTakenButton) {
        state.demo.filter.hideTaken = state.demo.filter.hideTaken === false;
        demoHideTakenButton.classList.toggle("is-active", state.demo.filter.hideTaken);
        demoHideTakenButton.setAttribute("aria-pressed", String(state.demo.filter.hideTaken));
        refreshDemoPool();
        return;
      }
      const demoQueueToggle = event.target.closest("[data-fantasy-queue-toggle]");
      if (demoQueueToggle) {
        const id = Number(demoQueueToggle.dataset.fantasyQueueToggle);
        state.demo.queue = toggleQueue(state.demo.queue, id);
        refreshDemoPool();
        if (!refreshDemoDraftRoomLive()) renderLayout();
        return;
      }
      const demoQueueUp = event.target.closest("[data-fantasy-queue-up]");
      if (demoQueueUp) {
        state.demo.queue = moveQueueItem(state.demo.queue, Number(demoQueueUp.dataset.fantasyQueueUp), "up");
        if (!refreshDemoDraftRoomLive()) renderLayout();
        return;
      }
      const demoQueueDown = event.target.closest("[data-fantasy-queue-down]");
      if (demoQueueDown) {
        state.demo.queue = moveQueueItem(state.demo.queue, Number(demoQueueDown.dataset.fantasyQueueDown), "down");
        if (!refreshDemoDraftRoomLive()) renderLayout();
        return;
      }
      const demoQueueRemove = event.target.closest("[data-fantasy-queue-remove]");
      if (demoQueueRemove) {
        state.demo.queue = removeFromQueue(state.demo.queue, Number(demoQueueRemove.dataset.fantasyQueueRemove));
        refreshDemoPool();
        if (!refreshDemoDraftRoomLive()) renderLayout();
        return;
      }
      if (event.target.closest("[data-fantasy-queue-clear]")) {
        state.demo.queue = [];
        refreshDemoPool();
        if (!refreshDemoDraftRoomLive()) renderLayout();
        return;
      }
      if (event.target.closest("[data-demo-skip]")) {
        finishDemoChunkRoll();
        return;
      }
      const demoShareButton = event.target.closest("[data-demo-share]");
      if (demoShareButton) {
        metric("count", "demo_share_clicked", 1);
        shareDemoResult(demoShareButton);
        return;
      }
      if (event.target.closest("[data-demo-restart]")) {
        restartDemo();
        return;
      }

      // -- Manager desk: lineup editor. Reuses the exact same data-fantasy-*
      // attributes renderFantasyRosterPanel already emits for the real My
      // team pitch view (see fantasyView.js) - the demo never renders both
      // panels at once, so there is no ambiguity about which handler a click
      // here means.
      if (event.target.closest("[data-fantasy-lineup-edit]")) {
        startDemoLineupEdit();
        return;
      }
      if (event.target.closest("[data-fantasy-lineup-cancel]")) {
        if (state.demo.desk) state.demo.desk.lineupEdit = null;
        renderLayout();
        return;
      }
      const demoLineupSaveButton = event.target.closest("[data-fantasy-lineup-save]");
      if (demoLineupSaveButton && !demoLineupSaveButton.disabled) {
        saveDemoLineupEdit();
        return;
      }
      const demoMakeCaptainButton = event.target.closest("[data-fantasy-make-captain]");
      if (demoMakeCaptainButton) {
        handleDemoMakeCaptain(Number(demoMakeCaptainButton.dataset.fantasyMakeCaptain));
        return;
      }
      if (event.target.closest("[data-fantasy-player-drawer-close]")) {
        if (state.demo.desk) state.demo.desk.drawerPlayerId = null;
        renderLayout();
        return;
      }
      const demoPitchTile = event.target.closest("[data-fantasy-player-id]");
      if (demoPitchTile) {
        handleDemoPlayerTileClick(Number(demoPitchTile.dataset.fantasyPlayerId));
        return;
      }

      // -- Manager desk: waiver wire.
      const demoWaiverClaimButton = event.target.closest("[data-demo-waiver-claim]");
      if (demoWaiverClaimButton) {
        openDemoWaiverClaim(Number(demoWaiverClaimButton.dataset.demoWaiverClaim));
        return;
      }
      const demoClaimDropButton = event.target.closest("[data-demo-claim-drop]");
      if (demoClaimDropButton) {
        chooseDemoClaimDrop(Number(demoClaimDropButton.dataset.demoClaimDrop));
        return;
      }
      if (event.target.closest("[data-demo-claim-cancel]")) {
        cancelDemoWaiverClaim();
        return;
      }
      const demoClaimConfirmButton = event.target.closest("[data-demo-claim-confirm]");
      if (demoClaimConfirmButton && !demoClaimConfirmButton.disabled) {
        confirmDemoWaiverClaim();
        return;
      }
      if (event.target.closest("[data-demo-desk-continue]")) {
        continueDemoDesk();
        return;
      }
      if (event.target.closest("[data-demo-sim-to-end]")) {
        beginDemoSimToEnd();
        return;
      }
      // data-section-nav ("Create a real league") is handled by wireNav's own
      // document-level listener, which runs regardless of section.
    }
    const comp = event.target.closest("[data-competition]");
    if (comp && !comp.disabled) {
      switchCompetition(comp.dataset.competition);
      return;
    }
    const tab = event.target.closest("[data-tab]");
    if (tab) {
      setTab(tab.dataset.tab);
      return;
    }
    const fixtureViewButton = event.target.closest("[data-fixture-view]");
    if (fixtureViewButton) {
      state.fixtureView = fixtureViewButton.dataset.fixtureView;
      renderLayout();
      return;
    }
    const gbSortButton = event.target.closest("[data-gb-sort]");
    if (gbSortButton) {
      state.statsSort = gbSortButton.dataset.gbSort;
      renderLayout();
      return;
    }
    const followButton = event.target.closest("[data-follow-team]");
    if (followButton) {
      followButton.disabled = true;
      toggleFollow(model.competition.code, followButton.dataset.followTeam).catch(() => {
        followButton.disabled = false;
      });
      return;
    }
    const prefButton = event.target.closest("[data-pref-key]");
    if (prefButton) {
      const key = prefButton.dataset.prefKey;
      const account = currentAccount();
      if (!account) return;
      prefButton.disabled = true;
      savePrefs({ [key]: !account.user.prefs?.[key] }).catch(() => {
        prefButton.disabled = false;
      });
      return;
    }
    if (event.target.closest("[data-sign-out]")) {
      signOut();
      return;
    }
    if (event.target.closest("[data-push-enable]")) {
      metric("count", "push_enable", 1);
      enablePush()
        .then(() => {
          posthog.capture("push_notifications_enabled");
          updatePushControls();
        })
        .catch((error) => updatePushControls(String(error.message).includes("permission") ? "Permission was not granted." : "Couldn't enable. Try again."));
      return;
    }
    if (event.target.closest("[data-push-disable]")) {
      disablePush().finally(() => updatePushControls());
      return;
    }
    const testButton = event.target.closest("[data-push-test]");
    if (testButton) {
      testButton.disabled = true;
      testButton.textContent = "Sending…";
      sendTestPush()
        .then((result) => {
          testButton.textContent = result.sent ? "Sent ✓" : "No devices";
        })
        .catch(() => {
          testButton.textContent = "Failed";
        })
        .finally(() => {
          window.setTimeout(() => updatePushControls(), 2500);
        });
      return;
    }
    const shareButton = event.target.closest("[data-run-share-button]");
    if (shareButton) {
      const text = elements.layout.querySelector("[data-run-share]")?.value ?? "";
      metric("count", "paperrun_share_clicked", 1);
      sharePaperRun(text).then((status) => {
        shareButton.textContent = status === "shared" ? "Shared" : status === "copied" ? "Copied" : "Copy unavailable";
      });
      return;
    }
    const saveButton = event.target.closest("[data-run-save]");
    if (saveButton) {
      const day = state.paperrun.day;
      if (!day?.result) return;
      const input = elements.layout.querySelector("[data-run-name]");
      const name = rememberName(input?.value || "") || day.result.name;
      saveButton.disabled = true;
      savePaperRun(day, { ...day.result, name });
      return;
    }
    if (event.target.closest("[data-map-link]")) return;
    const fantasyCreateButton = event.target.closest("[data-fantasy-create-submit]");
    if (fantasyCreateButton) {
      createFantasyLeague(elements.layout.querySelector("[data-fantasy-create-name]")?.value);
      return;
    }
    const fantasyJoinButton = event.target.closest("[data-fantasy-join-submit]");
    if (fantasyJoinButton) {
      joinFantasyLeague(elements.layout.querySelector("[data-fantasy-join-code]")?.value);
      return;
    }
    const fantasyLeagueCard = event.target.closest("[data-fantasy-league]");
    if (fantasyLeagueCard) {
      openFantasyLeague(Number(fantasyLeagueCard.dataset.fantasyLeague));
      return;
    }
    if (event.target.closest("[data-fantasy-back]")) {
      closeFantasyLeague();
      return;
    }
    const fantasySubtabButton = event.target.closest("[data-fantasy-subtab]");
    if (fantasySubtabButton && !fantasySubtabButton.disabled) {
      state.fantasy.subTab = fantasySubtabButton.dataset.fantasySubtab;
      state.fantasy.lineupEdit = null;
      state.fantasy.playerDrawerId = null;
      state.fantasy.waiverFlow = null;
      renderLayout();
      return;
    }
    const fantasyCopyButton = event.target.closest("[data-fantasy-copy-invite]");
    if (fantasyCopyButton) {
      const code = fantasyCopyButton.dataset.fantasyCopyInvite ?? "";
      navigator.clipboard
        ?.writeText(code)
        .then(() => {
          fantasyCopyButton.textContent = "Copied";
          window.setTimeout(() => {
            fantasyCopyButton.textContent = "Copy";
          }, 2000);
        })
        .catch(() => {});
      return;
    }
    const fantasyStartButton = event.target.closest("[data-fantasy-start-draft]");
    if (fantasyStartButton && !fantasyStartButton.disabled) {
      fantasyStartButton.disabled = true;
      startFantasyDraft(state.fantasy.activeLeagueId).catch((error) => {
        fantasyStartButton.disabled = false;
        state.fantasy.loadError = error.message || "Couldn't start the draft.";
        renderLayout();
      });
      return;
    }
    const fantasyScheduleSaveButton = event.target.closest("[data-fantasy-schedule-save]");
    if (fantasyScheduleSaveButton && !fantasyScheduleSaveButton.disabled) {
      saveFantasyLeagueSchedule();
      return;
    }
    const fantasyScheduleClearButton = event.target.closest("[data-fantasy-schedule-clear]");
    if (fantasyScheduleClearButton && !fantasyScheduleClearButton.disabled) {
      clearFantasyLeagueSchedule();
      return;
    }
    const fantasyPositionButton = event.target.closest("[data-fantasy-position-filter]");
    if (fantasyPositionButton) {
      state.fantasy.filter.position = fantasyPositionButton.dataset.fantasyPositionFilter;
      elements.layout.querySelectorAll("[data-fantasy-position-filter]").forEach((button) => {
        button.classList.toggle("is-active", button === fantasyPositionButton);
      });
      refreshFantasyPool();
      return;
    }
    const fantasyHideTakenButton = event.target.closest("[data-fantasy-hide-taken]");
    if (fantasyHideTakenButton) {
      state.fantasy.filter.hideTaken = state.fantasy.filter.hideTaken === false;
      fantasyHideTakenButton.classList.toggle("is-active", state.fantasy.filter.hideTaken);
      fantasyHideTakenButton.setAttribute("aria-pressed", String(state.fantasy.filter.hideTaken));
      refreshFantasyPool();
      return;
    }
    const fantasyQueueToggle = event.target.closest("[data-fantasy-queue-toggle]");
    if (fantasyQueueToggle) {
      const id = Number(fantasyQueueToggle.dataset.fantasyQueueToggle);
      state.fantasy.queue = toggleQueue(state.fantasy.queue, id);
      refreshFantasyPool();
      if (!refreshFantasyDraftRoomLive()) renderLayout();
      return;
    }
    const fantasyQueueUp = event.target.closest("[data-fantasy-queue-up]");
    if (fantasyQueueUp) {
      state.fantasy.queue = moveQueueItem(state.fantasy.queue, Number(fantasyQueueUp.dataset.fantasyQueueUp), "up");
      if (!refreshFantasyDraftRoomLive()) renderLayout();
      return;
    }
    const fantasyQueueDown = event.target.closest("[data-fantasy-queue-down]");
    if (fantasyQueueDown) {
      state.fantasy.queue = moveQueueItem(state.fantasy.queue, Number(fantasyQueueDown.dataset.fantasyQueueDown), "down");
      if (!refreshFantasyDraftRoomLive()) renderLayout();
      return;
    }
    const fantasyQueueRemove = event.target.closest("[data-fantasy-queue-remove]");
    if (fantasyQueueRemove) {
      state.fantasy.queue = removeFromQueue(state.fantasy.queue, Number(fantasyQueueRemove.dataset.fantasyQueueRemove));
      refreshFantasyPool();
      if (!refreshFantasyDraftRoomLive()) renderLayout();
      return;
    }
    if (event.target.closest("[data-fantasy-queue-clear]")) {
      state.fantasy.queue = [];
      refreshFantasyPool();
      if (!refreshFantasyDraftRoomLive()) renderLayout();
      return;
    }
    const fantasyDraftButton = event.target.closest("[data-fantasy-draft-player]");
    if (fantasyDraftButton) {
      fantasyDraftButton.disabled = true;
      state.fantasy.draftRoom?.controller.sendPick(Number(fantasyDraftButton.dataset.fantasyDraftPlayer));
      return;
    }
    const lineupEditButton = event.target.closest("[data-fantasy-lineup-edit]");
    if (lineupEditButton) {
      startFantasyLineupEdit();
      return;
    }
    const lineupCancelButton = event.target.closest("[data-fantasy-lineup-cancel]");
    if (lineupCancelButton) {
      state.fantasy.lineupEdit = null;
      renderLayout();
      return;
    }
    const lineupSaveButton = event.target.closest("[data-fantasy-lineup-save]");
    if (lineupSaveButton && !lineupSaveButton.disabled) {
      saveFantasyLineup();
      return;
    }
    const lineupRetryButton = event.target.closest("[data-fantasy-lineup-retry]");
    if (lineupRetryButton) {
      state.fantasy.lineupError = "";
      loadFantasyLineup(state.fantasy.activeLeagueId);
      return;
    }
    const matchupRetryButton = event.target.closest("[data-fantasy-matchup-retry]");
    if (matchupRetryButton) {
      state.fantasy.matchupError = "";
      loadFantasyMatchup(state.fantasy.activeLeagueId);
      return;
    }
    const standingsRetryButton = event.target.closest("[data-fantasy-standings-retry]");
    if (standingsRetryButton) {
      state.fantasy.standingsError = "";
      loadFantasyStandings(state.fantasy.activeLeagueId);
      return;
    }
    const waiversRetryButton = event.target.closest("[data-fantasy-waivers-retry]");
    if (waiversRetryButton) {
      state.fantasy.waiversError = "";
      loadFantasyWaivers(state.fantasy.activeLeagueId);
      return;
    }
    const faPositionButton = event.target.closest("[data-fantasy-fa-position-filter]");
    if (faPositionButton) {
      state.fantasy.waiverFreeAgentFilter.position = faPositionButton.dataset.fantasyFaPositionFilter;
      elements.layout.querySelectorAll("[data-fantasy-fa-position-filter]").forEach((button) => {
        button.classList.toggle("is-active", button === faPositionButton);
      });
      refreshFantasyFreeAgentRows();
      return;
    }
    const wirePositionButton = event.target.closest("[data-fantasy-wire-position-filter]");
    if (wirePositionButton) {
      state.fantasy.waiverWireFilter.position = wirePositionButton.dataset.fantasyWirePositionFilter;
      elements.layout.querySelectorAll("[data-fantasy-wire-position-filter]").forEach((button) => {
        button.classList.toggle("is-active", button === wirePositionButton);
      });
      refreshFantasyWireRows();
      return;
    }
    const faAddButton = event.target.closest("[data-fantasy-fa-add]");
    if (faAddButton) {
      openFantasyWaiverFlow(Number(faAddButton.dataset.fantasyFaAdd), "free_agent");
      return;
    }
    const wireClaimButton = event.target.closest("[data-fantasy-wire-claim]");
    if (wireClaimButton) {
      openFantasyWaiverFlow(Number(wireClaimButton.dataset.fantasyWireClaim), "waiver");
      return;
    }
    const claimDropButton = event.target.closest("[data-fantasy-claim-drop]");
    if (claimDropButton && !claimDropButton.disabled) {
      const flow = state.fantasy.waiverFlow;
      if (flow) {
        flow.dropPlayerId = Number(claimDropButton.dataset.fantasyClaimDrop);
        flow.error = "";
        renderLayout();
      }
      return;
    }
    if (event.target.closest("[data-fantasy-claim-cancel]")) {
      state.fantasy.waiverFlow = null;
      renderLayout();
      return;
    }
    const claimSubmitButton = event.target.closest("[data-fantasy-claim-submit]");
    if (claimSubmitButton && !claimSubmitButton.disabled) {
      submitFantasyWaiverFlow();
      return;
    }
    const cancelClaimButton = event.target.closest("[data-fantasy-waiver-cancel-claim]");
    if (cancelClaimButton) {
      cancelFantasyWaiverClaim(Number(cancelClaimButton.dataset.fantasyWaiverCancelClaim));
      return;
    }
    const settingsSaveButton = event.target.closest("[data-fantasy-settings-save]");
    if (settingsSaveButton && !settingsSaveButton.disabled) {
      saveFantasyWaiverSettings();
      return;
    }
    const makeCaptainButton = event.target.closest("[data-fantasy-make-captain]");
    if (makeCaptainButton) {
      handleFantasyMakeCaptain(Number(makeCaptainButton.dataset.fantasyMakeCaptain));
      return;
    }
    const drawerCloseTarget = event.target.closest("[data-fantasy-player-drawer-close]");
    if (drawerCloseTarget) {
      state.fantasy.playerDrawerId = null;
      renderLayout();
      return;
    }
    const pitchTile = event.target.closest("[data-fantasy-player-id]");
    if (pitchTile) {
      handleFantasyPlayerTileClick(Number(pitchTile.dataset.fantasyPlayerId));
      return;
    }
    const fantasyRetryButton = event.target.closest("[data-fantasy-retry]");
    if (fantasyRetryButton) {
      state.fantasy.loadError = "";
      if (state.fantasy.activeLeagueId != null) openFantasyLeague(state.fantasy.activeLeagueId);
      else loadFantasyLeagues();
      return;
    }
    if (event.target.closest("[data-fantasy-dismiss-error]")) {
      const room = state.fantasy.draftRoom;
      if (room?.state) room.state.lastError = null;
      renderLayout();
      return;
    }
    const tutorialOpenTarget = event.target.closest("[data-tutorial-open]");
    if (tutorialOpenTarget) {
      openTutorial(tutorialOpenTarget.dataset.tutorialOpen);
      return;
    }
    if (event.target.closest("[data-tutorial-back]")) {
      closeTutorial();
      return;
    }
    const resolverModeButton = event.target.closest("[data-tutorial-resolver-mode]");
    if (resolverModeButton) {
      state.learn.resolverMode = resolverModeButton.dataset.tutorialResolverMode;
      renderLayout();
      return;
    }
    const row = event.target.closest("[data-match-id]");
    if (row) openMatchRow(row);
  });
  elements.layout.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target.closest("[data-demo-name]")) {
      event.preventDefault();
      startDemoDraft();
      return;
    }
    if (event.key === "Enter" && event.target.closest("[data-fantasy-create-name]")) {
      event.preventDefault();
      createFantasyLeague(event.target.value);
      return;
    }
    if (event.key === "Enter" && event.target.closest("[data-fantasy-join-code]")) {
      event.preventDefault();
      joinFantasyLeague(event.target.value);
      return;
    }
    if (event.key === "Escape" && state.fantasy.playerDrawerId != null) {
      state.fantasy.playerDrawerId = null;
      renderLayout();
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") return;
    const row = event.target.closest("[data-match-id]");
    if (row) {
      event.preventDefault();
      openMatchRow(row);
      return;
    }
    // The nested "Make captain" button handles its own Enter/Space via the
    // native click it generates; without this guard closest() would also
    // match the ancestor pitch tile below and double-fire a tile click.
    if (event.target.closest("[data-fantasy-make-captain]")) return;
    const tile = event.target.closest("[data-fantasy-player-id]");
    if (tile) {
      event.preventDefault();
      handleFantasyPlayerTileClick(Number(tile.dataset.fantasyPlayerId));
    }
  });
  elements.layout.addEventListener("input", (event) => {
    if (state.section === "demo") {
      const demoSearch = event.target.closest("[data-fantasy-search]");
      if (demoSearch) {
        state.demo.filter.search = demoSearch.value;
        refreshDemoPool();
      }
      return;
    }
    const search = event.target.closest("[data-fantasy-search]");
    if (search) {
      state.fantasy.filter.search = search.value;
      refreshFantasyPool();
      return;
    }
    const faSearch = event.target.closest("[data-fantasy-fa-search]");
    if (faSearch) {
      state.fantasy.waiverFreeAgentFilter.search = faSearch.value;
      refreshFantasyFreeAgentRows();
      return;
    }
    const wireSearch = event.target.closest("[data-fantasy-wire-search]");
    if (wireSearch) {
      state.fantasy.waiverWireFilter.search = wireSearch.value;
      refreshFantasyWireRows();
    }
  });
  elements.layout.addEventListener("change", (event) => {
    if (state.section === "demo") {
      const demoClub = event.target.closest("[data-fantasy-club-filter]");
      if (demoClub) {
        state.demo.filter.club = demoClub.value;
        refreshDemoPool();
      }
      return;
    }
    const clubSelect = event.target.closest("[data-fantasy-club-filter]");
    if (clubSelect) {
      state.fantasy.filter.club = clubSelect.value;
      refreshFantasyPool();
      return;
    }
    const faClub = event.target.closest("[data-fantasy-fa-club-filter]");
    if (faClub) {
      state.fantasy.waiverFreeAgentFilter.club = faClub.value;
      refreshFantasyFreeAgentRows();
      return;
    }
    const wireClub = event.target.closest("[data-fantasy-wire-club-filter]");
    if (wireClub) {
      state.fantasy.waiverWireFilter.club = wireClub.value;
      refreshFantasyWireRows();
    }
  });
}

function openMatchRow(row) {
  const id = row.getAttribute("data-match-id");
  if (!id) return;
  const match = model.matches.find((item) => String(item.id) === id);
  if (match) {
    posthog.capture("match_opened", {
      match_id: match.id,
      home_team: match.homeTeam,
      away_team: match.awayTeam,
      status: match.status,
      competition: model.competition?.code,
    });
    openMatch(match);
  }
}

// Desktop and mobile render different layouts (sidebar + aside vs chip row +
// bottom nav), so a viewport crossing re-renders rather than just reflowing.
function wireViewportChange() {
  const mq = window.matchMedia("(max-width: 760px)");
  mq.addEventListener("change", () => {
    state.isMobile = mq.matches;
    renderAll();
  });
}

// Telemetry helpers. Guarded so instrumentation never throws and a blocked
// PostHog ingest (tracker blockers) simply no-ops. PostHog has no separate
// count/distribution/gauge metric types the way Sentry did; every kind becomes
// a capture event carrying its value and tags as properties, distinguishable
// by metric_kind for anyone building an insight off it later.
function metric(kind, name, value, options) {
  try {
    posthog.capture(name, { metric_kind: kind, value, ...(options?.tags ?? {}), ...(options?.unit ? { unit: options.unit } : {}) });
  } catch {
    /* telemetry must never break the app */
  }
}

function log(level, message, attributes) {
  try {
    posthog.capture("log", { level, message, ...attributes });
  } catch {
    /* telemetry must never break the app */
  }
}

// App-load instrumentation.
function trackAppLoad(data, buildMs) {
  if (appLoadMetricSent) return;
  appLoadMetricSent = true;
  const source = data.source ?? "unknown";
  const hasData = Boolean(data.hasData);
  metric("count", "app_load", 1, { tags: { source, has_data: String(hasData) } });
  if (Number.isFinite(buildMs)) {
    metric("distribution", "model_build_ms", buildMs, { unit: "millisecond" });
  }
  if (hasData) {
    const liveCount = data.matches.filter((item) => isLive(item.status)).length;
    metric("gauge", "live_matches", liveCount);
  }
  log("info", "app loaded", { source, has_data: hasData, build_ms: buildMs });
}

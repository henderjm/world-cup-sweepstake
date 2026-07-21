import { loadModel } from "./data.js";
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

const initialHash = HASH_ALIASES[window.location.hash.replace("#", "")] ?? window.location.hash.replace("#", "");
const state = {
  section: initialHash === "play" ? "play" : initialHash === "you" ? "you" : "scores",
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
};

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
      window.Sentry?.captureException?.(error);
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
    : `<p>Data source: ${model.source ?? "pending"} · Squad Goals is a Goon Squad production.</p>`;
  renderLayout();
}

function renderLayout() {
  if (state.section === "play") {
    elements.layout.className = "layout";
    renderPaperRun();
    return;
  }
  destroyPaperRunMount();

  if (state.section === "you") {
    elements.layout.className = "layout";
    const account = currentAccount();
    elements.layout.innerHTML = account
      ? renderSignedIn(model, account, isFollowed)
      : renderSignedOut({ available: accountAvailable(), configured: Boolean(GOOGLE_CLIENT_ID) });
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
    window.Sentry?.captureException?.(error);
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
    onStart: () => metric("count", "paperrun_started", 1),
    onUnavailable: () => {
      const status = host.querySelector("[data-run-status]");
      if (status) status.innerHTML = `<strong>Game unavailable</strong><span>This browser cannot start the canvas game.</span>`;
    },
    onComplete: async (result) => {
      const name = displayName();
      metric("count", "paperrun_completed", 1, {
        tags: { score: String(result.score), deliveries: String(result.deliveries), finished: String(result.finished) },
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
  window.history.replaceState(null, "", `#${section === "scores" ? state.tab : section}`);
  metric("count", "section_view", 1, { tags: { section } });
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
    const row = event.target.closest("[data-match-id]");
    if (row) openMatchRow(row);
  });
  elements.layout.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const row = event.target.closest("[data-match-id]");
    if (row) {
      event.preventDefault();
      openMatchRow(row);
    }
  });
}

function openMatchRow(row) {
  const id = row.getAttribute("data-match-id");
  if (!id) return;
  const match = model.matches.find((item) => String(item.id) === id);
  if (match) openMatch(match);
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

// Telemetry helpers. Guarded so instrumentation never throws and a blocked Sentry
// ingest (tracker blockers) simply no-ops.
function metric(kind, name, value, options) {
  try {
    window.Sentry?.metrics?.[kind]?.(name, value, options);
  } catch {
    /* telemetry must never break the app */
  }
}

function log(level, message, attributes) {
  try {
    window.Sentry?.logger?.[level]?.(message, attributes);
  } catch {
    /* telemetry must never break the app */
  }
}

// App-load instrumentation via the vendored Replay/Logs/Metrics SDK.
function trackAppLoad(data, buildMs) {
  if (appLoadMetricSent) return;
  appLoadMetricSent = true;
  const source = data.source ?? "unknown";
  const hasData = Boolean(data.hasData);
  window.Sentry?.setTag?.("data_source", source);
  window.Sentry?.setTag?.("has_live_data", String(hasData));
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

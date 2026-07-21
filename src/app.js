import { loadModel } from "./data.js";
import {
  renderFixtures,
  renderFooter,
  renderGoldenBoot,
  renderHero,
  renderLive,
  renderTable,
  renderTicker,
} from "./views.js";
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
import "./background.js";

const elements = {
  ticker: document.querySelector("#ticker"),
  hero: document.querySelector("#hero"),
  tabs: document.querySelector("#tabs"),
  panel: document.querySelector("#panel"),
  footer: document.querySelector("#footer"),
  banner: document.querySelector("#banner"),
  confetti: document.querySelector("#confetti"),
  matchDrawer: document.querySelector("#matchDrawer"),
  updated: document.querySelector("#updated"),
};

const TABS = ["live", "tables", "fixtures", "goldenboot", "paperrun"];
const initialTab = window.location.hash.replace("#", "");
const state = {
  tab: TABS.includes(initialTab) ? initialTab : "live",
  fixtureView: "results",
  goldenBootSort: "goals",
  paperrun: {
    date: todayPaperRunDate(),
    day: null,
    loading: false,
    mount: null,
  },
};

let model = null;
let appLoadMetricSent = false;
let pollTimer = null;
let lastSignature = "";
let lastFetchAt = 0;

const SHELL_IDS = ["ticker", "hero", "tabs", "panel", "footer", "banner", "updated"];
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
  model = await loadModel();
  trackAppLoad(model, Math.round(performance.now() - buildStart));

  if (!model.hasData) {
    renderPending(model);
    return;
  }

  lastFetchAt = Date.now();
  setUpdatedLabel();
  window.setInterval(setUpdatedLabel, 1000);
  elements.ticker.innerHTML = renderTicker(model);
  elements.hero.innerHTML = renderHero(model);
  elements.footer.innerHTML = renderFooter(model);

  syncActiveTab();
  renderPanel();
  wireTabs();
  wirePanelControls();
  wireMatchClicks();
  setupMatchDetail(model, { drawer: elements.matchDrawer });

  const matchParam = new URLSearchParams(window.location.search).get("match");
  if (matchParam) {
    const match = model.matches.find((item) => String(item.id) === matchParam);
    if (match) openMatch(match);
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

// Live refresh without a deploy: re-pull the model on an interval and update the
// always-visible parts (plus the live tab) only when a score or status actually
// changed. Polls faster while a game is live, slower when nothing is on.
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
  try {
    const fresh = await loadModel();
    if (fresh.hasData) {
      lastFetchAt = Date.now();
      const signature = matchSignature(fresh);
      if (signature !== lastSignature) {
        lastSignature = signature;
        model = fresh;
        setMatchModel(model);
        elements.ticker.innerHTML = renderTicker(model);
        elements.hero.innerHTML = renderHero(model);
        elements.footer.innerHTML = renderFooter(model);
        if (state.tab !== "paperrun") renderPanel();
      }
      setUpdatedLabel();
    }
  } catch {
    // keep the last good model and try again next cycle
  }
  scheduleNextPoll();
}

function renderPanel() {
  if (state.tab !== "paperrun") destroyPaperRunMount();
  const panel = elements.panel;
  switch (state.tab) {
    case "tables":
      panel.innerHTML = renderTable(model);
      break;
    case "fixtures":
      panel.innerHTML = renderFixtures(model, state.fixtureView);
      break;
    case "goldenboot":
      panel.innerHTML = renderGoldenBoot(model, state.goldenBootSort);
      break;
    case "paperrun":
      renderPaperRun();
      break;
    default:
      panel.innerHTML = renderLive(model);
  }
}

function renderPaperRun() {
  const today = todayPaperRunDate();
  if (state.paperrun.date !== today) {
    destroyPaperRunMount();
    state.paperrun = { date: today, day: null, loading: false, mount: null };
  }
  if (!state.paperrun.day && !state.paperrun.loading) loadPaperRun();
  if (!state.paperrun.day) {
    elements.panel.innerHTML = `<p class="panel__note">Loading today's paper run...</p>`;
    return;
  }
  destroyPaperRunMount();
  elements.panel.innerHTML = renderPaperRunPanel(state.paperrun.day);
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
  if (state.tab === "paperrun") renderPanel();
}

function mountPaperRun() {
  const day = state.paperrun.day;
  if (!day) return;
  // Mount even when locked so the canvas draws the static done-state street
  // instead of an undrawn black void.
  if (!day.result) metric("count", "paperrun_shown", 1);
  state.paperrun.mount = mountPaperRunGame(elements.panel, day, {
    onTick: (snap) => updatePaperRunHud(elements.panel, snap),
    onStart: () => metric("count", "paperrun_started", 1),
    onUnavailable: () => {
      const status = elements.panel.querySelector("[data-run-status]");
      if (status) status.innerHTML = `<strong>Game unavailable</strong><span>This browser cannot start the canvas game.</span>`;
    },
    onComplete: async (result) => {
      const name = displayName();
      const full = { ...result, name };
      metric("count", "paperrun_completed", 1, {
        tags: { score: String(result.score), deliveries: String(result.deliveries), finished: String(result.finished) },
      });
      await savePaperRun(day, full);
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
  renderPanel();
}

function destroyPaperRunMount() {
  if (!state.paperrun.mount) return;
  state.paperrun.mount.destroy();
  state.paperrun.mount = null;
}

function syncActiveTab() {
  elements.tabs.querySelectorAll("[data-tab]").forEach((tab) => {
    const active = tab.dataset.tab === state.tab;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", active ? "true" : "false");
  });
}

function wireTabs() {
  elements.tabs.addEventListener("click", (event) => {
    const button = event.target.closest("[data-tab]");
    if (!button) return;
    if (state.tab === "paperrun" && button.dataset.tab !== "paperrun") destroyPaperRunMount();
    state.tab = button.dataset.tab;
    window.history.replaceState(null, "", `#${state.tab}`);
    metric("count", "tab_view", 1, { tags: { tab: state.tab } });
    syncActiveTab();
    renderPanel();
  });
}

function wirePanelControls() {
  elements.panel.addEventListener("click", (event) => {
    const fixtureViewButton = event.target.closest("[data-fixture-view]");
    if (fixtureViewButton) {
      state.fixtureView = fixtureViewButton.dataset.fixtureView;
      renderPanel();
      return;
    }
    const gbSortButton = event.target.closest("[data-gb-sort]");
    if (gbSortButton) {
      state.goldenBootSort = gbSortButton.dataset.gbSort;
      renderPanel();
      return;
    }
    const shareButton = event.target.closest("[data-run-share-button]");
    if (shareButton) {
      const text = elements.panel.querySelector("[data-run-share]")?.value ?? "";
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
      const input = elements.panel.querySelector("[data-run-name]");
      const name = rememberName(input?.value || "") || day.result.name;
      saveButton.disabled = true;
      savePaperRun(day, { ...day.result, name });
    }
  });
}

function wireMatchClicks() {
  const open = (row) => {
    const id = row.getAttribute("data-match-id");
    if (!id) return;
    const match = model.matches.find((item) => String(item.id) === id);
    if (match) openMatch(match);
  };
  elements.panel.addEventListener("click", (event) => {
    if (event.target.closest("[data-map-link]")) return;
    const row = event.target.closest("[data-match-id]");
    if (row) open(row);
  });
  elements.panel.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const row = event.target.closest("[data-match-id]");
    if (row) {
      event.preventDefault();
      open(row);
    }
  });
}

function renderPending(data) {
  elements.updated.textContent = "waiting for data";
  elements.ticker.innerHTML = `<div class="ticker__track"><span class="ticker__item ticker__item--idle">Live feed not available yet.</span></div>`;
  elements.hero.innerHTML = `
    <div class="hero__head"><div><p class="hero__eyebrow">${data.competition?.name ?? "Football"}</p><h1 class="hero__title">Waiting for the first results</h1></div></div>
    <p class="panel__note">${data.error ?? "No live data has been published yet."}</p>`;
  elements.panel.innerHTML = `<p class="panel__note">The table, fixtures and scorer board appear once the feed publishes results.</p>`;
  elements.footer.innerHTML = `<p class="footer__src">Data source: ${data.source ?? "pending"}.</p>`;
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

import { ENTRANTS, OWNER_BY_TEAM, loadModel } from "./data.js";
import { runForecast } from "./forecast.js";
import {
  drawBracketConnectors,
  renderBracket,
  renderFixtures,
  renderFooter,
  renderGoldenBoot,
  renderGroupTables,
  renderHero,
  renderLeaderboard,
  renderLive,
  renderTicker,
  renderWhatIf,
} from "./views.js";
import {
  celebrationBanner,
  confettiBurst,
  setH2hModel,
  setupHeadToHead,
  shouldCelebrate,
} from "./interactions.js";
import { setMatchModel, setupMatchDetail, openMatch } from "./matchDetail.js";
import { isLive } from "./format.js";
import { todayShootoutDate } from "./shootoutModel.js";
import {
  displayName,
  loadShootoutDay,
  rememberName,
  shareShootout,
  submitShootoutResult,
} from "./shootoutApi.js";
import { cosmeticTeamForName } from "./shootoutContext.js";
import { renderShootoutPanel, updateShootoutHud } from "./shootoutView.js";
import { mountShootoutGame } from "./shootoutGame.js";
import "./background.js";

const elements = {
  ticker: document.querySelector("#ticker"),
  hero: document.querySelector("#hero"),
  tabs: document.querySelector("#tabs"),
  panel: document.querySelector("#panel"),
  footer: document.querySelector("#footer"),
  banner: document.querySelector("#banner"),
  confetti: document.querySelector("#confetti"),
  h2hOpen: document.querySelector("#h2hOpen"),
  h2hModal: document.querySelector("#h2hModal"),
  matchDrawer: document.querySelector("#matchDrawer"),
  updated: document.querySelector("#updated"),
};

const TABS = ["live", "leaderboard", "tables", "bracket", "whatif", "fixtures", "goldenboot", "shootout"];
const initialTab = window.location.hash.replace("#", "");
const state = {
  tab: TABS.includes(initialTab) ? initialTab : "live",
  leaderboardSort: "now",
  fixtureOwner: "all",
  fixtureView: "results",
  goldenBootSort: "ga",
  whatif: {
    pins: new Map(),
    baseline: null,
    baselinePending: false,
    result: null,
    computing: false,
    scenarioReq: 0,
  },
  shootout: {
    date: todayShootoutDate(),
    day: null,
    loading: false,
    mount: null,
  },
};

// What-if recompute reuses the hero forecast's exact seed and iteration count (see
// scenarioParams). That makes the no-pin baseline reproduce the headline odds instead
// of contradicting them, while a scenario and its baseline still share the same RNG, so
// the deltas reflect the pins, not noise.
let model = null;
let appLoadMetricSent = false;
let pollTimer = null;
let lastSignature = "";
let lastFetchAt = 0;

const SHELL_IDS = ["ticker", "hero", "tabs", "panel", "footer", "banner", "updated", "h2hOpen", "h2hModal"];
const RELOAD_FLAG = "wc-shell-reloaded";

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
  wireBracketResize();
  setupHeadToHead(model, { trigger: elements.h2hOpen, modal: elements.h2hModal });
  setupMatchDetail(model, { drawer: elements.matchDrawer });
  runCelebration();

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
        setH2hModel(model);
        // Fresh results change the odds, so the cached what-if baseline and scenario
        // are stale; drop them and let the what-if tab recompute against new data.
        state.whatif.baseline = null;
        state.whatif.baselinePending = false;
        state.whatif.result = null;
        state.whatif.computing = false;
        elements.ticker.innerHTML = renderTicker(model);
        elements.hero.innerHTML = renderHero(model);
        elements.footer.innerHTML = renderFooter(model);
        if (state.tab !== "shootout") renderPanel();
      }
      setUpdatedLabel();
    }
  } catch {
    // keep the last good model and try again next cycle
  }
  scheduleNextPoll();
}

function renderPanel() {
  if (state.tab !== "shootout") destroyShootoutMount();
  const panel = elements.panel;
  switch (state.tab) {
    case "leaderboard":
      panel.innerHTML = renderLeaderboard(model, state.leaderboardSort);
      break;
    case "tables":
      panel.innerHTML = renderGroupTables(model);
      break;
    case "bracket":
      panel.innerHTML = renderBracket(model);
      requestAnimationFrame(drawBracketConnectors);
      break;
    case "whatif":
      ensureWhatIf();
      panel.innerHTML = renderWhatIf(model, state.whatif);
      break;
    case "fixtures":
      panel.innerHTML = renderFixtures(model, state.fixtureOwner, state.fixtureView);
      break;
    case "goldenboot":
      panel.innerHTML = renderGoldenBoot(model, state.goldenBootSort);
      break;
    case "shootout":
      renderShootout();
      break;
    default:
      panel.innerHTML = renderLive(model);
  }
}

function renderShootout() {
  const today = todayShootoutDate();
  if (state.shootout.date !== today) {
    destroyShootoutMount();
    state.shootout = { date: today, day: null, loading: false, mount: null };
  }
  if (!state.shootout.day && !state.shootout.loading) loadShootout();
  if (!state.shootout.day) {
    elements.panel.innerHTML = `<p class="panel__note">Loading today's shootout...</p>`;
    return;
  }
  destroyShootoutMount();
  elements.panel.innerHTML = renderShootoutPanel(state.shootout.day);
  mountShootout();
}

async function loadShootout() {
  const date = state.shootout.date;
  state.shootout.loading = true;
  try {
    const day = await loadShootoutDay(date);
    if (state.shootout.date !== date) return;
    state.shootout.day = day;
  } catch (error) {
    window.Sentry?.captureException?.(error);
  } finally {
    state.shootout.loading = false;
  }
  if (state.tab === "shootout") renderPanel();
}

function mountShootout() {
  const day = state.shootout.day;
  if (!day) return;
  // Mount even when locked so the canvas draws the static done-state pitch
  // instead of an undrawn black void.
  if (!day.result) metric("count", "shootout_started", 1);
  state.shootout.mount = mountShootoutGame(elements.panel, day, {
    onKick: (gameState) => updateShootoutHud(elements.panel, gameState),
    onSuddenDeath: () => metric("count", "shootout_sudden_death_entered", 1),
    onUnavailable: () => {
      const status = elements.panel.querySelector("[data-shootout-status]");
      if (status) status.innerHTML = `<strong>Game unavailable</strong><span>This browser cannot start the canvas game.</span>`;
    },
    onComplete: async (result) => {
      const name = displayName();
      const full = { ...result, name, team: cosmeticTeamForName(name) ?? undefined };
      metric("count", "shootout_completed", 1, {
        tags: { goals: String(result.goals), sdStreak: String(result.sdStreak), style: String(result.style) },
      });
      await saveShootoutRun(day, full);
    },
  });
}

// Lock the run, submit it, and re-render with the official result and board.
async function saveShootoutRun(day, result) {
  const submitted = await submitShootoutResult(day.date, result);
  if (submitted.conflict) metric("count", "shootout_replay_blocked", 1);
  state.shootout.day = {
    ...day,
    alreadyPlayed: true,
    result: submitted.result,
    leaderboard: submitted.leaderboard,
    localOnly: submitted.localOnly,
    serverAvailable: submitted.localOnly ? day.serverAvailable : true,
  };
  renderPanel();
}

function destroyShootoutMount() {
  if (!state.shootout.mount) return;
  state.shootout.mount.destroy();
  state.shootout.mount = null;
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
    if (state.tab === "shootout" && button.dataset.tab !== "shootout") destroyShootoutMount();
    state.tab = button.dataset.tab;
    window.history.replaceState(null, "", `#${state.tab}`);
    metric("count", "tab_view", 1, { tags: { tab: state.tab } });
    syncActiveTab();
    renderPanel();
  });
}

// Connectors are measured from the DOM, so redraw on reflow.
function wireBracketResize() {
  let frame = null;
  window.addEventListener("resize", () => {
    if (state.tab !== "bracket") return;
    if (frame) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(drawBracketConnectors);
  });
}

function wirePanelControls() {
  elements.panel.addEventListener("click", (event) => {
    const sortButton = event.target.closest("[data-sort]");
    if (sortButton) {
      state.leaderboardSort = sortButton.dataset.sort;
      renderPanel();
      return;
    }
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
    const shareButton = event.target.closest("[data-shootout-share-button]");
    if (shareButton) {
      const text = elements.panel.querySelector("[data-shootout-share]")?.value ?? "";
      metric("count", "shootout_share_clicked", 1);
      shareShootout(text).then((status) => {
        shareButton.textContent = status === "shared" ? "Shared" : status === "copied" ? "Copied" : "Copy unavailable";
      });
      return;
    }
    const saveButton = event.target.closest("[data-shootout-save]");
    if (saveButton) {
      const day = state.shootout.day;
      if (!day?.result) return;
      const input = elements.panel.querySelector("[data-shootout-name]");
      const name = rememberName(input?.value || "") || day.result.name;
      const team = cosmeticTeamForName(name) ?? undefined;
      saveButton.disabled = true;
      saveShootoutRun(day, { ...day.result, name, team });
      return;
    }
    // What-if: pin or unpin a remaining group game.
    const pinButton = event.target.closest("[data-pin-match]");
    if (pinButton) {
      const id = pinButton.dataset.pinMatch;
      const outcome = pinButton.dataset.pinOutcome;
      const pins = state.whatif.pins;
      if (pins.get(id) === outcome) pins.delete(id);
      else pins.set(id, outcome);
      metric("count", "whatif_pin", 1, { tags: { outcome } });
      renderPanel();
      scheduleScenario();
      return;
    }
    const clearButton = event.target.closest("[data-action='clear-whatif']");
    if (clearButton) {
      state.whatif.pins.clear();
      state.whatif.result = null;
      state.whatif.computing = false;
      renderPanel();
    }
  });
  elements.panel.addEventListener("change", (event) => {
    if (event.target.matches("[data-control='fixture-owner']")) {
      state.fixtureOwner = event.target.value;
      renderPanel();
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

// -- What-if explorer compute -------------------------------------------------
// The forecast is re-run off the main thread in a module Web Worker so pinning stays
// smooth. If workers are unavailable (or fail to load), we fall back to running it
// inline. A scenario and its baseline share the hero's seed so deltas are pin-driven.

let whatifWorker; // undefined: not tried, null: unavailable, else a Worker
let scenarioTimer = null;
const inflight = new Map();

function getWorker() {
  if (whatifWorker !== undefined) return whatifWorker;
  try {
    whatifWorker = new Worker(new URL("./forecast.worker.js", import.meta.url), { type: "module" });
    whatifWorker.onmessage = (event) => {
      inflight.delete(event.data?.id);
      onForecast(event.data);
    };
    whatifWorker.onerror = () => {
      const pending = [...inflight.entries()];
      whatifWorker = null;
      inflight.clear();
      pending.forEach(([id, params]) => computeOnMain(id, params));
    };
  } catch {
    whatifWorker = null;
  }
  return whatifWorker;
}

function scenarioParams(pins) {
  return {
    groups: model.groups,
    groupMatches: model.matches.filter((item) => item.stage === "GROUP_STAGE"),
    knockoutMatches: model.matches.filter((item) => item.stage !== "GROUP_STAGE"),
    ownerByTeam: OWNER_BY_TEAM,
    entrants: ENTRANTS,
    seed: model.forecast.seed,
    iterations: model.forecast.iterations,
    pins,
  };
}

function dispatch(id, params) {
  const worker = getWorker();
  if (worker) {
    inflight.set(id, params);
    worker.postMessage({ id, params });
  } else {
    computeOnMain(id, params);
  }
}

function computeOnMain(id, params) {
  try {
    onForecast({ id, forecast: runForecast(params) });
  } catch (error) {
    onForecast({ id, error: String(error?.message ?? error) });
  }
}

function onForecast(data) {
  if (!data) return;
  const [kind, n] = String(data.id).split(":");
  if (kind === "baseline") {
    state.whatif.baselinePending = false;
    if (!data.error) state.whatif.baseline = data.forecast;
    renderIfWhatIf();
    return;
  }
  if (Number(n) !== state.whatif.scenarioReq) return; // a newer scenario superseded this
  state.whatif.computing = false;
  if (!data.error) state.whatif.result = data.forecast;
  renderIfWhatIf();
}

// Kick off the baseline on first view, and a scenario if games are already pinned.
function ensureWhatIf() {
  if (!state.whatif.baseline && !state.whatif.baselinePending) {
    state.whatif.baselinePending = true;
    dispatch("baseline:0", scenarioParams(new Map()));
  }
  if (state.whatif.pins.size > 0 && !state.whatif.result && !state.whatif.computing) {
    computeScenario();
  }
}

function computeScenario() {
  const pins = state.whatif.pins;
  if (pins.size === 0) {
    state.whatif.result = null;
    state.whatif.computing = false;
    renderIfWhatIf();
    return;
  }
  state.whatif.computing = true;
  state.whatif.scenarioReq += 1;
  renderIfWhatIf();
  dispatch(`scenario:${state.whatif.scenarioReq}`, scenarioParams(new Map(pins)));
}

function scheduleScenario() {
  if (scenarioTimer) clearTimeout(scenarioTimer);
  scenarioTimer = setTimeout(() => {
    scenarioTimer = null;
    computeScenario();
  }, 150);
}

function renderIfWhatIf() {
  if (state.tab === "whatif") renderPanel();
}

function runCelebration() {
  const banner = celebrationBanner(model);
  if (banner) {
    elements.banner.textContent = banner;
    elements.banner.hidden = false;
  }
  if (shouldCelebrate(model)) {
    confettiBurst(elements.confetti);
  }
}

function renderPending(data) {
  elements.updated.textContent = "waiting for data";
  elements.ticker.innerHTML = `<div class="ticker__track"><span class="ticker__item ticker__item--idle">Live feed not available yet.</span></div>`;
  elements.hero.innerHTML = `
    <div class="hero__head"><div><p class="hero__eyebrow">The race for the pot</p><h1 class="hero__title">Waiting for the first results</h1></div></div>
    <p class="panel__note">${data.error ?? "No live data has been published yet."}</p>`;
  elements.panel.innerHTML = `<p class="panel__note">Group tables, the leaderboard and the projection appear once the feed publishes results.</p>`;
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

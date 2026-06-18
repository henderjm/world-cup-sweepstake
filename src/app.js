import { loadModel } from "./data.js";
import {
  renderBracket,
  renderFixtures,
  renderFooter,
  renderGroupTables,
  renderHero,
  renderLeaderboard,
  renderLive,
  renderTicker,
} from "./views.js";
import {
  celebrationBanner,
  confettiBurst,
  setupHeadToHead,
  shouldCelebrate,
} from "./interactions.js";
import { setupMatchDetail, openMatch } from "./matchDetail.js";
import { isLive } from "./format.js";
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

const TABS = ["live", "leaderboard", "tables", "bracket", "fixtures"];
const initialTab = window.location.hash.replace("#", "");
const state = {
  tab: TABS.includes(initialTab) ? initialTab : "live",
  leaderboardSort: "now",
  fixtureOwner: "all",
};
let model = null;
let appLoadMetricSent = false;

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

  elements.updated.textContent = model.lastUpdated
    ? new Intl.DateTimeFormat("en-IE", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(
        new Date(model.lastUpdated),
      )
    : "loaded";
  elements.ticker.innerHTML = renderTicker(model);
  elements.hero.innerHTML = renderHero(model);
  elements.footer.innerHTML = renderFooter(model);

  syncActiveTab();
  renderPanel();
  wireTabs();
  wirePanelControls();
  wireMatchClicks();
  setupHeadToHead(model, { trigger: elements.h2hOpen, modal: elements.h2hModal });
  setupMatchDetail(model, { drawer: elements.matchDrawer });
  runCelebration();

  const matchParam = new URLSearchParams(window.location.search).get("match");
  if (matchParam) {
    const match = model.matches.find((item) => String(item.id) === matchParam);
    if (match) openMatch(match);
  }
}

function renderPanel() {
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
      break;
    case "fixtures":
      panel.innerHTML = renderFixtures(model, state.fixtureOwner);
      break;
    default:
      panel.innerHTML = renderLive(model);
  }
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
    state.tab = button.dataset.tab;
    window.history.replaceState(null, "", `#${state.tab}`);
    metric("count", "tab_view", 1, { tags: { tab: state.tab } });
    syncActiveTab();
    renderPanel();
  });
}

function wirePanelControls() {
  elements.panel.addEventListener("click", (event) => {
    const sortButton = event.target.closest("[data-sort]");
    if (sortButton) {
      state.leaderboardSort = sortButton.dataset.sort;
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

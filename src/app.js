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

  model = await loadModel();
  trackAppLoad(model);

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
  setupHeadToHead(model, { trigger: elements.h2hOpen, modal: elements.h2hModal });
  runCelebration();
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

// App-load instrumentation. The vendored SDK initialises synchronously before this
// module runs, so Sentry is ready here. Uses stable v10 APIs (the old metrics.count
// beta was removed), and tags help slice errors by data state.
function trackAppLoad(data) {
  if (appLoadMetricSent) return;
  appLoadMetricSent = true;
  const sentry = window.Sentry;
  if (!sentry?.addBreadcrumb) return;
  try {
    sentry.setTag?.("data_source", data.source ?? "unknown");
    sentry.setTag?.("has_live_data", String(Boolean(data.hasData)));
    sentry.addBreadcrumb({ category: "app", level: "info", message: "app_load" });
  } catch (error) {
    sentry.captureException?.(error);
  }
}

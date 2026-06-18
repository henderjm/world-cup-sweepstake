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

start();

async function start() {
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

// Preserves the existing Sentry app-load instrumentation.
function trackAppLoad(data) {
  let attempts = 0;
  const send = () => {
    if (appLoadMetricSent) return;
    const metrics = window.Sentry?.metrics;
    if (!metrics?.count) {
      attempts += 1;
      if (attempts < 20) window.setTimeout(send, 500);
      return;
    }
    appLoadMetricSent = true;
    try {
      metrics.count("world_cup_sweepstake_app_load", 1, {
        tags: { source: data.source, hasLiveData: String(Boolean(data.hasData)) },
      });
    } catch (error) {
      window.Sentry?.captureException?.(error);
    }
  };
  window.addEventListener("sentry-ready", send, { once: true });
  send();
}

<script>
  import { onMount } from "svelte";
  import Home from "./Home.svelte";
  import MatchSheet from "./MatchSheet.svelte";
  import { currentAccount, onAccountChange, restoreAccount, toggleFollow } from "../account.js";
  import { switchVersion } from "../appVersion.js";
  import { COMPETITION_CODES } from "../competitions.js";
  import { DATA_API, loadModel } from "../data.js";
  import { isLive } from "../format.js";
  import { localDateKey } from "../scoreDates.js";
  import { combinedScoreModel, createScoreFeeds } from "../scoreFeeds.js";
  import { createLocalFollows, uniqueFollows } from "../teamFollows.js";
  import { track } from "../telemetry.js";
  import { freshness } from "./matchCentre.js";

  const SECTIONS = [
    { key: "live", label: "Live", icon: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/>' },
    { key: "fantasy", label: "Fantasy", icon: '<path d="M8 4h8l4 4-3 2v10H7V10L4 8z"/>' },
    { key: "play", label: "Play", icon: '<path d="M7 4v16l13-8z"/>' },
    { key: "you", label: "You", icon: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/>' },
  ];
  const BANNER_KEY = "kd-v2-banner-dismissed";

  const scoreFeeds = createScoreFeeds(loadModel);
  const localFollows = createLocalFollows();

  let feeds = $state(scoreFeeds.values());
  let account = $state(currentAccount());
  let localList = $state(localFollows.all());
  let wire = $state([]);
  let now = $state(Date.now());
  let flashed = $state(new Set());
  let route = $state(readRoute());
  let desktop = $state(false);
  let banner = $state(readBanner());

  const matches = $derived(combinedScoreModel(feeds).matches);
  const follows = $derived(uniqueFollows([...(account?.follows ?? []), ...localList]));
  const openMatch = $derived(route.matchId == null ? null : matches.find(match => String(match.id) === route.matchId) ?? null);
  const anyLive = $derived(matches.some(match => isLive(match.status)));
  const newestFeed = $derived(feeds.filter(feed => feed.hasData).sort((a, b) => Date.parse(b.lastUpdated) - Date.parse(a.lastUpdated))[0]);
  const fresh = $derived(newestFeed ? freshness({
    lastUpdated: newestFeed.lastUpdated, stale: feeds.some(feed => feed.stale), staleAgeMs: Math.max(0, ...feeds.map(feed => feed.staleAgeMs ?? 0)), live: anyLive,
  }, now) : { text: "Loading", delayed: false });

  function readRoute() {
    const raw = location.hash.replace(/^#/, "");
    const matchId = /^match\/(\d+)$/.exec(raw)?.[1] ?? null;
    if (matchId) return { section: "live", matchId };
    const section = raw.split("/")[0];
    return { section: SECTIONS.some(entry => entry.key === section) ? section : "live", matchId: null };
  }

  function readBanner() {
    try { return localStorage.getItem(BANNER_KEY) !== "1"; } catch { return true; }
  }
  function dismissBanner() {
    banner = false;
    try { localStorage.setItem(BANNER_KEY, "1"); } catch { /* shown again next visit */ }
  }

  function go(hash) {
    if (location.hash !== hash) location.hash = hash;
    else route = readRoute();
  }

  function open(match) {
    track("v2_match_opened", { competition: match.competitionCode, status: match.status });
    go(`#match/${match.id}`);
  }
  function close() {
    if (history.length > 1 && route.matchId) history.back();
    else go("#live");
  }

  // A score that changed since the last poll flashes its row and card once.
  let scores = new Map();
  function noteScores(list) {
    const changed = new Set();
    for (const match of list) {
      const key = `${match.score?.home}-${match.score?.away}`;
      const before = scores.get(match.id);
      if (before !== undefined && before !== key) changed.add(match.id);
      scores.set(match.id, key);
    }
    if (changed.size) {
      flashed = changed;
      setTimeout(() => { flashed = new Set(); }, 1300);
    }
  }

  async function refresh() {
    await Promise.all(COMPETITION_CODES.map(code => scoreFeeds.refresh(code)));
    feeds = scoreFeeds.values();
    noteScores(combinedScoreModel(feeds).matches);
    loadWire();
  }

  let wireCursor = null;
  let wireDay = null;
  async function loadWire() {
    if (!DATA_API) return;
    const day = localDateKey();
    if (wireDay !== day) { wireDay = day; wireCursor = null; wire = []; }
    try {
      const query = new URLSearchParams({ day });
      if (wireCursor) query.set("since", wireCursor);
      const response = await fetch(`${DATA_API}/wire?${query}`, { cache: "no-store", signal: AbortSignal.timeout(8000) });
      if (!response.ok) return;
      const body = await response.json();
      const byRow = new Map(wire.map(item => [item.rowId, item]));
      for (const item of body.items ?? []) byRow.set(item.rowId, item);
      wire = [...byRow.values()];
      wireCursor = body.cursor ?? wireCursor;
    } catch { /* the Wire is additive; the scores still poll */ }
  }

  // Signed in, the follow goes to the account; signed out, it stays on this
  // device (the V1 rule, so a fan of one club is never behind a sign-in wall).
  async function follow(competition, team) {
    try {
      if (account) {
        await toggleFollow(competition, team);
        account = currentAccount();
      } else {
        const following = !localList.some(entry => entry.competition === competition && entry.team === team);
        localFollows.set(competition, team, following);
        localList = localFollows.all();
      }
    } catch { /* the star stays as it was */ }
  }

  let timer;
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      await refresh();
      schedule();
    }, anyLive ? 20_000 : 60_000);
  }

  onMount(() => {
    document.title = "Kickoff Draft: live scores";
    const media = matchMedia("(min-width: 1024px)");
    desktop = media.matches;
    const onMedia = event => (desktop = event.matches);
    media.addEventListener("change", onMedia);
    const onHash = () => (route = readRoute());
    addEventListener("hashchange", onHash);
    const onStorage = () => { localFollows.reload(); localList = localFollows.all(); };
    addEventListener("storage", onStorage);
    const offAccount = onAccountChange(next => (account = next ? { ...next } : null));
    const tick = setInterval(() => (now = Date.now()), 1000);
    restoreAccount();
    refresh().then(schedule);
    track("v2_opened", {});
    return () => {
      media.removeEventListener("change", onMedia);
      removeEventListener("hashchange", onHash);
      removeEventListener("storage", onStorage);
      offAccount();
      clearInterval(tick);
      clearTimeout(timer);
    };
  });

  const openFeed = $derived(openMatch ? feeds.find(feed => feed.competition.code === openMatch.competitionCode) : null);
</script>

<div class="app" class:desktop>
  <header class="top">
    <a class="mark" href="#live" aria-label="Kickoff Draft home">KD</a>
    {#if desktop}
      <nav class="topnav" aria-label="Sections">
        {#each SECTIONS as section}
          <a href="#{section.key}" class:on={route.section === section.key} aria-current={route.section === section.key ? "page" : undefined}>{section.label}</a>
        {/each}
      </nav>
    {/if}
    {#if route.section === "live"}
      <span class="fresh" class:delayed={fresh.delayed} aria-live="polite">
        {#if anyLive}<span class="dot pulse" class:delayed={fresh.delayed} aria-hidden="true"></span>{/if}{fresh.text}
      </span>
    {:else}
      <span class="label">{SECTIONS.find(section => section.key === route.section)?.label}</span>
    {/if}
  </header>

  {#if banner && route.section === "live"}
    <div class="banner">
      <span>You are on the new Kickoff Draft. Switch back any time in You.</span>
      <button aria-label="Dismiss" onclick={dismissBanner}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
      </button>
    </div>
  {/if}

  {#if route.section === "live"}
    <div class="live-wrap" class:with-panel={desktop && openMatch}>
      <Home {matches} {feeds} {follows} {wire} {flashed} {desktop} {now} openId={openMatch?.id ?? null} onopen={open} />
      {#if openMatch}
        <MatchSheet match={openMatch} feed={openFeed} {follows} {now} {desktop} onclose={close} onfollow={follow} ontalksignin={() => go("#you")} />
      {/if}
    </div>
  {:else}
    {#if route.section === "you"}
      <div class="you-bar">
        <span>You are using the new Kickoff Draft.</span>
        <button class="btn ghost" onclick={() => switchVersion("1")}>Switch back to the old app</button>
      </div>
    {/if}
    {#key route.section}
      <iframe class="framed" class:you={route.section === "you"} title="{route.section} section" src="./?embed=1#{route.section}"></iframe>
    {/key}
  {/if}

  {#if !desktop}
    <nav class="nav" aria-label="Sections">
      {#each SECTIONS as section}
        <a href="#{section.key}" class:on={route.section === section.key} aria-current={route.section === section.key ? "page" : undefined}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true">{@html section.icon}</svg>
          <span>{section.label}</span>
        </a>
      {/each}
    </nav>
  {/if}
</div>

<style>
  .app { min-height: 100vh; padding-bottom: 64px; }
  .app.desktop { padding-bottom: 0; }
  .top { position: sticky; top: 0; z-index: 10; height: 52px; padding: 0 16px; display: flex; align-items: center; justify-content: space-between; gap: 24px; background: var(--bg); }
  .desktop .top { height: 56px; border-bottom: 1px solid var(--line); padding: 0 24px; }
  .mark { font-size: 22px; font-weight: 900; font-style: italic; letter-spacing: -0.04em; color: var(--accent); min-width: 44px; min-height: 44px; display: inline-flex; align-items: center; }
  .topnav { display: flex; gap: 28px; margin-right: auto; }
  .topnav a { font-size: 15px; color: var(--muted); min-height: 56px; display: inline-flex; align-items: center; }
  .topnav a.on { color: var(--text); box-shadow: inset 0 -2px 0 var(--accent); }
  .fresh { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; color: var(--muted); }
  .fresh.delayed { color: var(--gold); }
  .banner { margin: 0 16px; padding: 4px 0 6px; display: flex; align-items: center; gap: 10px; font-size: 13px; color: var(--muted); border-bottom: 1px solid var(--line); }
  .desktop .banner { margin: 0 24px; }
  .banner span { flex: 1; }
  .banner button { width: 44px; height: 44px; display: inline-flex; align-items: center; justify-content: center; color: var(--muted); }
  .live-wrap.with-panel { display: grid; grid-template-columns: minmax(0, 1fr) 460px; }
  .live-wrap.with-panel :global(.home.desktop) { grid-template-columns: 220px minmax(0, 1fr); }
  .framed { display: block; width: 100%; height: calc(100vh - 52px - 64px); border: 0; background: var(--bg); }
  .framed.you { height: calc(100vh - 52px - 64px - 61px); }
  .desktop .framed { height: calc(100vh - 56px); }
  .desktop .framed.you { height: calc(100vh - 56px - 61px); }
  .you-bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 8px 16px; border-bottom: 1px solid var(--line); font-size: 13px; color: var(--muted); }
  .nav { position: fixed; left: 0; right: 0; bottom: 0; z-index: 20; height: 64px; background: var(--bg); border-top: 1px solid var(--line); display: flex; padding-bottom: env(safe-area-inset-bottom); }
  .nav a { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; font-size: 11px; font-weight: 600; letter-spacing: 0.04em; color: var(--muted); }
  .nav a.on { color: var(--accent); }
  .nav a.on span { box-shadow: 0 2px 0 var(--accent); }
  .nav svg { width: 22px; height: 22px; }
</style>

<script>
  import { onMount } from "svelte";
  import Briefing from "./Briefing.svelte";
  import ClubSheet from "./ClubSheet.svelte";
  import Home from "./Home.svelte";
  import League from "./League.svelte";
  import MatchSheet from "./MatchSheet.svelte";
  import { currentAccount, onAccountChange, restoreAccount, savePrefs, sessionToken, toggleFollow } from "../account.js";
  import { BRIEFING_PREFS, shouldLand } from "../briefing.js";
  import { loadBriefing, markBriefingSeen } from "../briefingApi.js";
  import { switchVersion } from "../appVersion.js";
  import { COMPETITIONS, COMPETITION_CODES } from "../competitions.js";
  import { DATA_API, loadModel } from "../data.js";
  import { fantasyAvailable, listLeagues, loadMatchup } from "../fantasyApi.js";
  import { displayTeamName } from "../domain.js";
  import { isLive } from "../format.js";
  import { localDateKey } from "../scoreDates.js";
  import { combinedScoreModel, createScoreFeeds } from "../scoreFeeds.js";
  import { createLocalFollows, uniqueFollows } from "../teamFollows.js";
  import { track } from "../telemetry.js";
  import { feedsFreshness } from "./matchCentre.js";
  import { leagueHash, parseRoute, routeBase } from "./league.js";

  const SECTIONS = [
    { key: "home", label: "Home", icon: '<path d="M4 11l8-7 8 7v9h-5v-6H9v6H4z"/>' },
    { key: "live", label: "Live", icon: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/>' },
    { key: "fantasy", label: "Fantasy", icon: '<path d="M8 4h8l4 4-3 2v10H7V10L4 8z"/>' },
    { key: "play", label: "Play", icon: '<path d="M7 4v16l13-8z"/>' },
    { key: "you", label: "You", icon: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/>' },
  ];
  const BANNER_KEY = "kd-v2-banner-dismissed";
  // Only a bare visit (no hash) may be redirected to Home: a deep link, a
  // shared match or an explicit #live is where the visitor asked to go.
  const landingCandidate = location.hash === "" || location.hash === "#";

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
  let matchup = $state(null);
  let briefing = $state(null);
  let briefingLoading = $state(false);
  let briefingFailed = $state(false);
  // The day a deep-linked match falls on, applied to the list once.
  const deepLinkId = readRoute().matchId;
  let deepLinkDay = $state(null);
  // The framed V1 screen stays hidden until it has painted, so a section
  // switch never flashes a blank white page.
  let frameReady = $state(false);
  $effect(() => {
    route.section;
    frameReady = false;
  });

  const matches = $derived(combinedScoreModel(feeds).matches);
  const follows = $derived(uniqueFollows([...(account?.follows ?? []), ...localList]));
  const openMatch = $derived(route.matchId == null ? null : matches.find(match => String(match.id) === route.matchId) ?? null);
  const anyLive = $derived(matches.some(match => isLive(match.status)));
  // The one club sheet, from the table, a league page or an open match. It
  // lives in history.state on its own entry (same URL), so back closes the
  // club alone, and a match opened from it closes back onto it, on the tab
  // that was showing. It sits on top of an open match.
  let club = $state(history.state?.club ?? null);
  function syncClub() {
    club = history.state?.club ?? null;
  }
  function openClub(code, team, view = null) {
    const next = { code, team, view };
    history.pushState({ club: next }, "", location.href);
    club = next;
    track("v2_club_opened", { competition: code });
  }
  function closeClub() {
    if (history.state?.club) history.back();
    else club = null;
  }
  function clubView(view) {
    if (!club || club.view === view || !history.state?.club) return;
    history.replaceState({ club: { ...history.state.club, view } }, "", location.href);
  }

  // A forward move to another page starts at the top; back and forward keep
  // the browser's own restoration. A match is an overlay, not a page.
  // A back/forward is recognised by the URL it landed on, so one that only
  // closed a club (no page change) cannot leave a flag set for the next move.
  // Following a "#" link or setting location.hash ALSO fires popstate, so a
  // forward move announces its target first (forwardTo) and is not mistaken
  // for a traversal.
  let traversedTo = null;
  let forwardTo = null;
  const pageKey = $derived(`${route.section}|${route.league ?? ""}|${route.tab ?? ""}`);
  let lastPage = "";
  $effect(() => {
    const key = pageKey;
    if (lastPage && key !== lastPage && traversedTo !== location.href) scrollTo(0, 0);
    lastPage = key;
    traversedTo = null;
  });
  const fresh = $derived(feedsFreshness(feeds, now, isLive));

  function readRoute() {
    return parseRoute(location.hash, SECTIONS.map(entry => entry.key));
  }

  function readBanner() {
    try { return localStorage.getItem(BANNER_KEY) !== "1"; } catch { return true; }
  }
  function dismissBanner() {
    banner = false;
    try { localStorage.setItem(BANNER_KEY, "1"); } catch { /* shown again next visit */ }
  }

  function go(hash) {
    forwardTo = hash;
    if (location.hash !== hash) location.hash = hash;
    else route = readRoute();
  }

  // A match opened from inside the app pushes one history entry, so browser
  // back and close both return to where the visitor was. Opening a second
  // match from an open panel REPLACES that entry, so close never walks back
  // through every match looked at. A match reached by deep link (a share or
  // a push notification) has no in-app entry behind it, so close goes to
  // #live rather than history.back(), which would leave the site. A match
  // opened from a league page keeps the league in its hash, so the page stays
  // underneath it and closing returns there.
  let openedInApp = false;
  function open(match) {
    track("v2_match_opened", { competition: match.competitionCode, status: match.status });
    // The club it came from stays one step back in history, not on screen.
    club = null;
    const hash = route.league ? leagueHash(route.league, route.tab, match.id) : `#match/${match.id}`;
    if (route.matchId) {
      history.replaceState(null, "", hash);
      route = readRoute();
    } else {
      openedInApp = true;
      go(hash);
    }
  }
  function close() {
    if (openedInApp) {
      openedInApp = false;
      history.back();
    } else {
      history.replaceState(null, "", routeBase(route));
      route = readRoute();
    }
  }

  // League tabs and the competition switch replace the entry rather than
  // stacking one per tap, so back leaves the league page in one step.
  function leagueNav(code, tab) {
    history.replaceState(null, "", leagueHash(code, tab));
    route = readRoute();
    track("v2_league_viewed", { competition: code, tab });
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

  // Each league paints as soon as its own feed lands: waiting on all of them
  // made the whole page as slow as the slowest provider (a 6s Bundesliga read
  // once held every league, and the Wire, on "Loading matches…").
  function applyFeeds() {
    feeds = scoreFeeds.values();
    if (deepLinkId && !deepLinkDay) {
      const linked = combinedScoreModel(feeds).matches.find(match => String(match.id) === deepLinkId);
      if (linked?.utcDate) deepLinkDay = localDateKey(linked.utcDate);
    }
  }

  let firstLoad = true;
  async function refresh() {
    loadWire();
    const started = performance.now();
    const timings = {};
    let firstScoresMs = null;
    await Promise.all(COMPETITION_CODES.map(code => scoreFeeds.refresh(code).then(feed => {
      timings[code] = Math.round(performance.now() - started);
      if (firstScoresMs == null && feed.hasData) firstScoresMs = Math.round(performance.now());
      applyFeeds();
    })));
    noteScores(combinedScoreModel(feeds).matches);
    if (anyLive) loadStake();
    if (firstLoad) {
      firstLoad = false;
      reportScoresReady(firstScoresMs, timings);
    }
  }

  // Web vitals cannot see this: LCP fires on the empty layout, before any
  // score has arrived. This is the number a visitor actually waits for.
  function reportScoresReady(firstScoresMs, timings) {
    const [slowest, slowestMs] = Object.entries(timings).sort((a, b) => b[1] - a[1])[0] ?? [null, null];
    track("v2_scores_ready", {
      first_scores_ms: firstScoresMs,
      all_feeds_ms: Math.round(performance.now()),
      slowest_competition: slowest,
      slowest_feed_ms: slowestMs,
      ...Object.fromEntries(Object.entries(timings).map(([code, ms]) => [`feed_${code}_ms`, ms])),
      route: route.section,
    });
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

  // Follows made signed out live on this device; signing in carries them into
  // the account once, then clears the device copy so the two cannot diverge.
  // A follow the account already has is left alone (toggling it would undo it).
  async function mergeDeviceFollows(owner) {
    for (const follow of localFollows.all()) {
      if (currentAccount()?.user?.email !== owner) return;
      const held = (currentAccount()?.follows ?? [])
        .some(entry => entry.competition === follow.competition && entry.team === follow.team);
      try {
        if (!held) await toggleFollow(follow.competition, follow.team);
        localFollows.set(follow.competition, follow.team, false);
      } catch { return; /* kept on the device; retried at the next sign-in */ }
    }
    localList = localFollows.all();
    account = currentAccount() ? { ...currentAccount() } : null;
  }

  // The Home briefing is fetched once per sign-in and held for the session, so
  // going back to Home after marking it seen still shows what was new.
  let briefingFor = null;
  let landed = false;
  async function refreshBriefing() {
    const owner = currentAccount()?.user?.email ?? null;
    if (!owner) { briefing = null; briefingFor = null; return; }
    if (briefingFor === owner) return;
    briefingFor = owner;
    briefingLoading = true;
    briefingFailed = false;
    try {
      const body = await loadBriefing();
      if (currentAccount()?.user?.email !== owner) return;
      briefing = body;
      if (landingCandidate && !landed && route.section === "live" && !route.league && !route.matchId
        && shouldLand(body, currentAccount()?.user?.prefs)) {
        history.replaceState(null, "", "#home");
        route = readRoute();
        track("v2_home_landed", {});
      }
    } catch {
      briefingFailed = true;
      briefingFor = null;
    } finally {
      briefingLoading = false;
      landed = true;
    }
  }

  // Seen means "looked at Home and moved on": leaving the section, or the tab
  // going away while on it. Marking on arrival would empty Home on a reload.
  let viewedHome = false;
  $effect(() => {
    if (route.section === "home" && briefing) viewedHome = true;
    else if (viewedHome) { viewedHome = false; markBriefingSeen(); }
  });

  async function briefingPrefChange(key, value) {
    track("v2_home_pref", { key, value });
    try {
      await savePrefs({ [BRIEFING_PREFS[key]]: value });
      account = currentAccount() ? { ...currentAccount() } : null;
    } catch { /* the toggle reverts on the next account read */ }
  }

  // The stake strip reads the first league that has drafted. Refreshed on the
  // poll at most once a minute, like V1's live matchup refresh.
  let stakeAt = 0;
  // Whether the last visit showed a matchup. The strip loads after the
  // scores, so without a reserved slot it pushed the match list down (CLS
  // 0.22 on its own); a returning manager gets the space held from first paint.
  const STAKE_HINT_KEY = "kd-v2-stake";
  let stakeHint = $state(readStakeHint());
  function readStakeHint() {
    try { return localStorage.getItem(STAKE_HINT_KEY) === "1"; } catch { return false; }
  }
  function writeStakeHint(value) {
    stakeHint = value;
    try { value ? localStorage.setItem(STAKE_HINT_KEY, "1") : localStorage.removeItem(STAKE_HINT_KEY); } catch { /* a hint only */ }
  }
  // No session means no matchup is coming: a stale hint must not hold an
  // empty slot open for a signed-out visitor.
  const stakePending = $derived(stakeHint && !matchup && Boolean(account || sessionToken()));
  async function loadStake() {
    if (!currentAccount() || !fantasyAvailable()) { matchup = null; return; }
    if (Date.now() - stakeAt < 60_000) return;
    stakeAt = Date.now();
    try {
      const league = (await listLeagues()).find(entry => entry.draftStatus === "complete");
      matchup = league ? await loadMatchup(league.id) : null;
      writeStakeHint(Boolean(matchup?.me));
    } catch { /* the strip is additive; keep the last good copy */ }
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
    const media = matchMedia("(min-width: 1024px)");
    desktop = media.matches;
    const onMedia = event => (desktop = event.matches);
    media.addEventListener("change", onMedia);
    const onHash = () => { route = readRoute(); syncClub(); };
    const onPop = () => {
      if (forwardTo !== location.hash) traversedTo = location.href;
      forwardTo = null;
      syncClub();
    };
    const onLink = event => {
      const link = event.target.closest?.('a[href^="#"]');
      if (link) forwardTo = link.getAttribute("href");
    };
    document.addEventListener("click", onLink, true);
    // A link inside a framed V1 screen that leads to another section (Fantasy's
    // "Go to sign in", You's "Follow teams") is handed up and opened as the
    // V2 section, instead of loading that V1 screen under the wrong tab.
    const onFrameNav = event => {
      if (event.origin !== location.origin || event.data?.type !== "kd-embed-nav") return;
      const section = SECTIONS.some(entry => entry.key === event.data.section) ? event.data.section : "live";
      go(`#${section}`);
    };
    addEventListener("message", onFrameNav);
    addEventListener("hashchange", onHash);
    addEventListener("popstate", onPop);
    const onStorage = () => { localFollows.reload(); localList = localFollows.all(); };
    addEventListener("storage", onStorage);
    const offAccount = onAccountChange(next => {
      account = next ? { ...next } : null;
      if (next) mergeDeviceFollows(next.user?.email);
      else writeStakeHint(false);
      loadStake();
      refreshBriefing();
    });
    const onHide = () => {
      if (document.visibilityState === "hidden" && viewedHome) { viewedHome = false; markBriefingSeen(); }
    };
    document.addEventListener("visibilitychange", onHide);
    const tick = setInterval(() => (now = Date.now()), 1000);
    restoreAccount();
    refresh().then(schedule);
    track("v2_opened", {});
    return () => {
      media.removeEventListener("change", onMedia);
      removeEventListener("hashchange", onHash);
      removeEventListener("popstate", onPop);
      document.removeEventListener("click", onLink, true);
      removeEventListener("message", onFrameNav);
      removeEventListener("storage", onStorage);
      document.removeEventListener("visibilitychange", onHide);
      offAccount();
      clearInterval(tick);
      clearTimeout(timer);
    };
  });

  $effect(() => {
    document.title = openMatch
      ? `${displayTeamName(openMatch.homeTeam)} v ${displayTeamName(openMatch.awayTeam)} · Kickoff Draft`
      : route.league ? `${COMPETITIONS[route.league]?.name ?? route.league} · Kickoff Draft`
      : route.section === "live" ? "Kickoff Draft: live scores" : `${SECTIONS.find(entry => entry.key === route.section)?.label} · Kickoff Draft`;
  });

  const openFeed = $derived(openMatch ? feeds.find(feed => feed.competition.code === openMatch.competitionCode) : null);
</script>

<div class="app" class:desktop>
  <header class="top">
    <a class="mark" href="#live" aria-label="Kickoff Draft home"><img src="assets/favicon.svg" alt="" width="32" height="32" /></a>
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

  {#if banner && route.section === "live" && !route.league}
    <div class="banner">
      <span>You are on the new Kickoff Draft. Switch back any time in You.</span>
      <button aria-label="Dismiss" onclick={dismissBanner}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
      </button>
    </div>
  {/if}

  {#if route.section === "home"}
    <Briefing {briefing} loading={briefingLoading} failed={briefingFailed} signedIn={Boolean(account)}
      prefs={account?.user?.prefs ?? {}} {matches} {follows} {now} onopen={open} onpref={briefingPrefChange} />
  {:else if route.section === "live"}
    <div class="live-wrap" class:with-panel={desktop && openMatch}>
      {#if route.league}
        <League code={route.league} tab={route.tab} {feeds} {follows} {flashed} {desktop} {now} onopen={open} onfollow={follow} onclub={openClub}
          ontab={tab => leagueNav(route.league, tab)} oncompetition={code => leagueNav(code, route.tab)} />
      {:else}
        <Home {matches} {feeds} {follows} {wire} {flashed} {desktop} {now} {matchup} {stakePending} openId={openMatch?.id ?? null} initialDay={deepLinkDay} onopen={open} onfollow={follow} onclub={openClub} />
      {/if}
      {#if openMatch}
        <MatchSheet match={openMatch} feed={openFeed} {follows} {now} {desktop} onclose={close} onfollow={follow} ontalksignin={() => go("#you")}
          onteam={openClub} covered={Boolean(club)} />
      {/if}
      {#if club}
        {#key `${club.code}:${club.team}`}
          <ClubSheet {club} {matches} {follows} {desktop} initialView={club.view} onclose={closeClub} onopen={open} onfollow={follow} onview={clubView} />
        {/key}
      {/if}
    </div>
  {:else}
    {#if route.section === "you"}
      <div class="you-bar">
        <span>You are using the new Kickoff Draft.</span>
        <button class="btn ghost" onclick={() => switchVersion("1")}>Switch back to the old app</button>
      </div>
    {/if}
    {#if !frameReady}<p class="frame-loading" role="status">Loading {route.section}…</p>{/if}
    {#key route.section}
      <iframe class="framed" class:you={route.section === "you"} class:ready={frameReady} title="{route.section} section"
        src="./?embed=1#{route.frame || route.section}" onload={() => (frameReady = true)}></iframe>
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
  .framed { opacity: 0; transition: opacity 120ms; }
  .framed.ready { opacity: 1; }
  .frame-loading { position: absolute; left: 16px; top: 72px; color: var(--muted); font-size: 13px; margin: 0; }
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

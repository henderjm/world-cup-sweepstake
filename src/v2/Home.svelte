<script>
  import Crest from "./Crest.svelte";
  import MatchRow from "./MatchRow.svelte";
  import StakeStrip from "./StakeStrip.svelte";
  import TablePanel from "./TablePanel.svelte";
  import Wire from "./Wire.svelte";
  import { COMPETITIONS, COMPETITION_CODES } from "../competitions.js";
  import { displayTeamName } from "../domain.js";
  import { dayLabel, isLive, statusLabel, timeLabel } from "../format.js";
  import { fetchMatchDetail } from "../matchDetail.js";
  import { adjacentMatchDay, localDateKey, matchDayStrip, matchDays } from "../scoreDates.js";
  import { spotlightMatches } from "../spotlight.js";
  import { followsTeam } from "../teamFollows.js";
  import {
    defaultMatchDay, groupByCompetition, hasScore, latestKeyMoment, matchesOnDay, minuteText, redCards, untilKickoff,
  } from "./matchCentre.js";

  let { matches, feeds, follows, wire, flashed, desktop, matchup = null, openId = null, initialDay = null, now, onopen } = $props();

  const today = $derived(localDateKey(now));
  const days = $derived(matchDays(matches));
  // A deep link to a match opens the list on that match's day, so the list
  // and the open panel agree.
  let chosenDay = $state(null);
  let appliedInitial = false;
  $effect(() => {
    if (initialDay && !appliedInitial) {
      appliedInitial = true;
      chosenDay = initialDay;
    }
  });
  const selectedDay = $derived(chosenDay ?? defaultMatchDay(days, today));
  const strip = $derived(matchDayStrip(days, selectedDay, today).filter(day => day !== today || days.includes(today) || day === selectedDay));
  const dayMatches = $derived(matchesOnDay(matches, selectedDay));
  const noMatchToday = $derived(!days.includes(today));

  let liveOnly = $state(false);
  let myTeams = $state(false);
  // The desktop competition list filters the matches AND picks the table.
  let onlyComp = $state(null);
  let tableComp = $state(null);
  function pickCompetition(code) {
    onlyComp = code;
    if (code) tableComp = code;
  }
  const isFollowed = match => followsTeam(follows, match.competitionCode, match.homeTeam) || followsTeam(follows, match.competitionCode, match.awayTeam);
  const listed = $derived(dayMatches.filter(match => (!liveOnly || isLive(match.status)) && (!myTeams || isFollowed(match))
    && (!onlyComp || match.competitionCode === onlyComp)));
  const filtered = $derived(liveOnly || myTeams || Boolean(onlyComp));
  const groups = $derived(groupByCompetition(listed, COMPETITION_CODES));

  const spotlight = $derived(spotlightMatches(dayMatches, follows));
  const hero = $derived(spotlight.find(pick => isLive(pick.match.status)) ?? null);
  const compact = $derived(spotlight.filter(pick => pick !== hero));

  // The hero's latest key moment needs the match detail; refetched only when
  // the hero's score or status changes, not on every poll.
  let heroDetail = $state(null);
  let heroKey = "";
  $effect(() => {
    const match = hero?.match;
    const key = match ? `${match.id}:${match.status}:${match.score?.home}:${match.score?.away}` : "";
    if (key === heroKey) return;
    heroKey = key;
    heroDetail = null;
    if (!match) return;
    const controller = new AbortController();
    fetchMatchDetail(match, controller.signal).then(detail => {
      if (heroKey === key) heroDetail = detail;
    }).catch(() => {});
    return () => controller.abort();
  });
  const heroMoment = $derived(hero && heroDetail ? latestKeyMoment(heroDetail, hero.match.homeTeam) : null);

  const anyLive = $derived(matches.some(match => isLive(match.status)));
  const tableFirst = $derived(noMatchToday && !chosenDay);
  // Desktop right column: The Wire while there is something to say,
  // otherwise the table; either way both are one tap apart.
  let rightTab = $state(null);
  const rightShows = $derived(rightTab ?? (anyLive && wire.length ? "wire" : "table"));

  function stripLabel(day) {
    if (day === today) return "Today";
    return new Intl.DateTimeFormat("en-GB", { weekday: "short" }).format(new Date(`${day}T12:00:00`));
  }
  const dayNumber = day => Number(day.slice(8, 10));
  const fullDay = day => new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long" }).format(new Date(`${day}T12:00:00`));
  const longDay = day => new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long" }).format(new Date(`${day}T12:00:00`));

  // Swipe anywhere on the list to move matchday: a clear horizontal gesture
  // only, so a vertical scroll that drifts sideways never changes the day.
  let touch = null;
  function swipeStart(event) {
    const point = event.changedTouches[0];
    touch = { x: point.clientX, y: point.clientY };
  }
  function swipeEnd(event) {
    if (!touch) return;
    const point = event.changedTouches[0];
    const dx = point.clientX - touch.x;
    const dy = point.clientY - touch.y;
    touch = null;
    if (Math.abs(dx) < 70 || Math.abs(dx) < 2 * Math.abs(dy)) return;
    const next = adjacentMatchDay(days, selectedDay, dx < 0 ? 1 : -1);
    if (next) chosenDay = next;
  }

  function compactLabel(pick) {
    const match = pick.match;
    const lead = pick.reason === "followed" ? "Your club" : "Next";
    if (hasScore(match) && !isLive(match.status)) return `${lead} · ${statusLabel(match)}`;
    return `${lead} · ${match.utcDate && localDateKey(match.utcDate) === today ? timeLabel(match.utcDate) : `${dayLabel(match.utcDate)} ${timeLabel(match.utcDate)}`}`;
  }
</script>

<div class="home" class:desktop>
  {#if desktop}
    <aside class="left">
      <div class="label">Competitions</div>
      <button class="comp" class:on={!onlyComp} aria-pressed={!onlyComp} onclick={() => pickCompetition(null)}>All competitions</button>
      {#each COMPETITION_CODES as code}
        {@const live = matches.filter(match => match.competitionCode === code && isLive(match.status)).length}
        <button class="comp" class:on={onlyComp === code} aria-pressed={onlyComp === code} onclick={() => pickCompetition(code)}>
          {COMPETITIONS[code].name}{#if live}<span class="live small">{live} live</span>{/if}
        </button>
      {/each}
      <div class="label gap">Your clubs</div>
      {#each follows as follow}
        <div class="club"><Crest team={follow.team} /> <span>{displayTeamName(follow.team)}</span></div>
      {/each}
      <div class="label gap">Show</div>
      <button class="toggle" class:on={!liveOnly && !myTeams} aria-pressed={!liveOnly && !myTeams} onclick={() => { liveOnly = false; myTeams = false; }}>All matches</button>
      <button class="toggle" class:on={liveOnly} aria-pressed={liveOnly} onclick={() => (liveOnly = !liveOnly)}>Live only</button>
      <button class="toggle" class:on={myTeams} aria-pressed={myTeams} onclick={() => (myTeams = !myTeams)}>My teams</button>
    </aside>
  {/if}

  <main class="centre" ontouchstart={swipeStart} ontouchend={swipeEnd}>
    <nav class="strip" class:fade={!desktop} aria-label="Matchdays">
      {#each strip as day (day)}
        <button class="day" class:on={day === selectedDay} aria-current={day === selectedDay ? "date" : undefined} aria-label={fullDay(day)} onclick={() => (chosenDay = day)}>
          <span class="label" class:live={day === today}>{stripLabel(day)}</span>
          <span class="num">{dayNumber(day)}</span>
        </button>
      {/each}
      {#if desktop}<span class="longday">{longDay(selectedDay)}</span>{/if}
    </nav>

    {#each compact as pick (pick.match.id)}
      <a class="compact" href="#match/{pick.match.id}" onclick={event => { event.preventDefault(); onopen(pick.match); }}>
        <Crest team={pick.reason === "followed" && follows.some(f => f.team === pick.match.awayTeam) ? pick.match.awayTeam : pick.match.homeTeam} size={28} />
        <div class="grow">
          <div class="label" class:live={pick.reason === "followed"}>{compactLabel(pick)}</div>
          <div class="ctitle">
            {displayTeamName(pick.match.homeTeam)}{hasScore(pick.match) ? ` ${pick.match.score.home}-${pick.match.score.away} ` : " v "}{displayTeamName(pick.match.awayTeam)}
            {#if pick.match.venue || untilKickoff(pick.match.utcDate, now)}<span class="muted">{` · ${[untilKickoff(pick.match.utcDate, now), pick.match.venue].filter(Boolean).join(" · ")}`}</span>{/if}
          </div>
        </div>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#5a646e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
      </a>
    {/each}

    {#if hero}
      {@const match = hero.match}
      <a class="card hero" class:flash={flashed.has(match.id)} href="#match/{match.id}" onclick={event => { event.preventDefault(); onopen(match); }}>
        <div class="hero-top">
          <span class="label" class:live={hero.reason === "followed"}>{hero.reason === "followed" ? "Your club" : "Match of the moment"}</span>
          <span class="live minute"><span class="dot pulse" aria-hidden="true"></span>{statusLabel(match)}</span>
        </div>
        <div class="hero-grid">
          <div class="side"><Crest team={match.homeTeam} size={44} /><span>{displayTeamName(match.homeTeam)}{#if heroDetail && redCards(heroDetail, match.homeTeam)} <i class="redcard" role="img" aria-label="Red card"></i>{/if}</span></div>
          <div class="hero-num" aria-live="polite" aria-label="{displayTeamName(match.homeTeam)} {match.score.home ?? 0}, {displayTeamName(match.awayTeam)} {match.score.away ?? 0}">
            <span>{match.score.home ?? 0}</span><span class="sep">:</span><span>{match.score.away ?? 0}</span>
          </div>
          <div class="side"><Crest team={match.awayTeam} size={44} /><span>{displayTeamName(match.awayTeam)}{#if heroDetail && redCards(heroDetail, match.awayTeam)} <i class="redcard" role="img" aria-label="Red card"></i>{/if}</span></div>
        </div>
        {#if heroMoment}
          <div class="moment">
            <b>{minuteText(heroMoment)}</b>
            <span>{heroMoment.kind === "red" ? "Red card" : heroMoment.note.startsWith("own goal") ? "Own goal" : heroMoment.note.startsWith("penalty") ? "Penalty" : "Goal"} · {heroMoment.player}</span>
          </div>
        {/if}
      </a>
    {/if}

    {#if matchup?.me && selectedDay === today}
      <StakeStrip {matchup} {now} />
    {/if}

    {#if tableFirst}
      <TablePanel {feeds} {follows} competition={tableComp} oncompetition={code => (tableComp = code)} compact />
    {/if}

    {#if !desktop}
      <div class="filterbar">
        <span class="label strong">Matches</span>
        <span class="filters">
          <button class="toggle" class:on={liveOnly} aria-pressed={liveOnly} onclick={() => (liveOnly = !liveOnly)}>Live only</button>
          <button class="toggle" class:on={myTeams} aria-pressed={myTeams} onclick={() => (myTeams = !myTeams)}>My teams</button>
        </span>
      </div>
    {/if}

    {#each groups as group (group.code)}
      <div class="group-h">
        <span class="label strong">{COMPETITIONS[group.code].name}{#if group.matches[0]?.matchday}<span class="muted">{` · Matchday ${group.matches[0].matchday}`}</span>{/if}</span>
      </div>
      {#each group.matches as match (match.id)}
        <MatchRow {match} flash={flashed.has(match.id)} followed={isFollowed(match)} aside={isFollowed(match) ? "Your club" : ""} {onopen} />
      {/each}
    {:else}
      <p class="empty">
        {#if filtered}
          Nothing matches those filters on {longDay(selectedDay)}.
          <button class="link" onclick={() => { liveOnly = false; myTeams = false; onlyComp = null; }}>Show all</button>
        {:else if !matches.length}
          Loading matches…
        {:else}
          No matches on {longDay(selectedDay)}.
        {/if}
      </p>
    {/each}

    {#if !desktop}
      <Wire items={wire} {follows} {onopen} {matches} />
      {#if !tableFirst}
        <TablePanel {feeds} {follows} competition={tableComp} oncompetition={code => (tableComp = code)} compact />
      {/if}
    {/if}
  </main>

  {#if desktop && !openId}
    <aside class="right">
      {#if wire.length}
        <div class="tabs" role="group" aria-label="Right column">
          <button class="toggle" class:on={rightShows === "wire"} aria-pressed={rightShows === "wire"} onclick={() => (rightTab = "wire")}>The Wire</button>
          <button class="toggle" class:on={rightShows === "table"} aria-pressed={rightShows === "table"} onclick={() => (rightTab = "table")}>Table</button>
        </div>
      {/if}
      {#if rightShows === "wire" && wire.length}
        <Wire items={wire} {follows} {onopen} {matches} expandedDefault />
      {:else}
        <TablePanel {feeds} {follows} competition={tableComp} oncompetition={code => (tableComp = code)} wide />
      {/if}
    </aside>
  {/if}
</div>

<style>
  .home { display: block; }
  .home.desktop { display: grid; grid-template-columns: 240px minmax(0, 1fr) 380px; min-height: calc(100vh - 56px); }
  .left { border-right: 1px solid var(--line); padding: 16px; display: flex; flex-direction: column; align-items: flex-start; gap: 2px; }
  .left .gap { margin-top: 20px; }
  .comp, .club { min-height: 44px; display: flex; align-items: center; gap: 8px; width: 100%; font-size: 15px; text-align: left; }
  .comp { color: var(--muted); }
  .comp.on { color: var(--text); box-shadow: inset 2px 0 0 var(--accent); padding-left: 10px; }
  .comp .small { margin-left: auto; font-size: 12px; font-weight: 600; }
  .right { border-left: 1px solid var(--line); padding: 8px 16px; max-height: calc(100vh - 56px); overflow-y: auto; position: sticky; top: 56px; }
  .tabs { display: flex; gap: 20px; }
  /* Tall enough that a swipe anywhere below a short list still changes day. */
  .centre { min-width: 0; padding-bottom: 24px; min-height: calc(100vh - 120px); }
  .desktop .centre { padding: 0 24px 24px; }

  .strip { height: 56px; display: flex; align-items: stretch; gap: 4px; padding: 0 8px; overflow-x: auto; scrollbar-width: none; }
  .strip::-webkit-scrollbar { display: none; }
  .strip.fade { mask-image: linear-gradient(90deg, #000 85%, transparent); -webkit-mask-image: linear-gradient(90deg, #000 85%, transparent); }
  .day { flex: none; width: 46px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; color: var(--muted); }
  .day .label { font-size: 10px; }
  .day .num { font-size: 15px; font-weight: 600; }
  .day.on { color: var(--text); box-shadow: inset 0 -2px 0 var(--accent); }
  .day.on .num { font-weight: 700; }
  .longday { margin-left: auto; align-self: center; font-size: 13px; color: var(--muted); padding-right: 8px; white-space: nowrap; }

  .compact { display: flex; align-items: center; gap: 12px; margin: 4px 16px 0; padding: 10px 0 12px; border-bottom: 1px solid var(--line); }
  .desktop .compact { margin: 4px 0 0; }
  .grow { flex: 1; min-width: 0; }
  .ctitle { font-size: 15px; font-weight: 600; margin-top: 2px; }
  .ctitle .muted { font-weight: 400; }

  .hero { display: block; margin: 12px 16px 0; padding: 14px 16px 12px; }
  .desktop .hero { margin: 12px 0 0; padding: 20px 24px; }
  .hero-top { display: flex; align-items: center; justify-content: space-between; }
  .minute { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 700; }
  .hero-grid { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 12px; margin-top: 12px; }
  .side { display: flex; flex-direction: column; align-items: center; gap: 6px; font-size: 13px; font-weight: 600; text-align: center; }
  .moment { display: flex; align-items: center; gap: 8px; margin-top: 12px; font-size: 13px; color: var(--muted); }
  .moment b { color: var(--text); }

  .group-h { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 14px 16px 2px; }
  .desktop .group-h { padding: 18px 0 4px; }
  .strong { color: var(--text); font-weight: 700; }
  .filterbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 16px 0; }
  .filters { display: flex; gap: 16px; }
  .small { font-size: 13px; }
  .desktop :global(.row) { padding: 0 8px; }
  .empty { padding: 24px 16px; color: var(--muted); font-size: 15px; }
  .link { color: var(--accent); font-weight: 600; min-height: 44px; }

</style>

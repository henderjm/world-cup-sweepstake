<script>
  import { onDestroy } from "svelte";
  import Crest from "./Crest.svelte";
  import Predict from "./Predict.svelte";
  import { COMPETITIONS } from "../competitions.js";
  import { displayTeamName } from "../domain.js";
  import { dayLabel, statusLabel, timeLabel } from "../format.js";
  import { mountBanter, unmountBanter, banterAvailable } from "../banter.js";
  import { fetchMatchAnalysis, fetchMatchDetail } from "../matchDetail.js";
  import { followsTeam } from "../teamFollows.js";
  import {
    clubForm, freshness, matchPhase, minuteText, moments, playerOfMatch, ratedPitch, redCards, scorerLines, statRows, untilKickoff,
  } from "./matchCentre.js";

  let { match, feed, follows, now, desktop, onclose, onfollow, ontalksignin } = $props();

  const phase = $derived(matchPhase(match));
  const home = $derived(displayTeamName(match.homeTeam));
  const away = $derived(displayTeamName(match.awayTeam));
  const competition = $derived(COMPETITIONS[match.competitionCode]?.name ?? "");
  const context = $derived(match.matchday ? `${competition} · Matchday ${match.matchday}` : competition);
  const fresh = $derived(freshness({ lastUpdated: feed?.lastUpdated, stale: feed?.stale, staleAgeMs: feed?.staleAgeMs, live: phase === "live" }, now));

  // Detail is refetched when the match moves (score, status, minute) and on
  // a 30-second floor while live, never on every 20-second list poll.
  let detail = $state(null);
  let detailKey = "";
  let lastFetch = 0;
  $effect(() => {
    const key = `${match.id}:${match.status}:${match.score?.home}:${match.score?.away}`;
    const due = phase === "live" && Date.now() - lastFetch > 30_000;
    if (key === detailKey && !due) return;
    if (key.split(":")[0] !== detailKey.split(":")[0]) detail = null;
    detailKey = key;
    lastFetch = Date.now();
    const controller = new AbortController();
    fetchMatchDetail(match, controller.signal).then(result => {
      if (result && detailKey === key) detail = result;
    }).catch(() => {});
  });

  let analysis = $state(null);
  let analysisFor = null;
  $effect(() => {
    if (phase !== "post" || analysisFor === match.id) return;
    analysisFor = match.id;
    analysis = null;
    fetchMatchAnalysis(match, new AbortController().signal).then(result => {
      if (result?.match && analysisFor === match.id) analysis = result;
    }).catch(() => {});
  });

  const scorers = $derived(detail ? scorerLines(detail, match.homeTeam) : { home: [], away: [] });
  const stats = $derived(statRows(detail, match.homeTeam, match.awayTeam));
  const allMoments = $derived(moments(detail, match.homeTeam));
  let timelineOpen = $state(false);
  const latest = $derived(phase === "post" || timelineOpen ? allMoments : allMoments.slice(0, 3));
  let ratingSide = $state("home");
  const pitch = $derived(ratedPitch(detail, ratingSide));
  const anyRated = $derived((detail?.playerStats ?? []).some(player => Number.isFinite(player.rating)));
  const potm = $derived(playerOfMatch(detail));
  const homeForm = $derived(clubForm(feed?.tables, match.homeTeam));
  const awayForm = $derived(clubForm(feed?.tables, match.awayTeam));
  const lineupsDue = $derived(match.utcDate ? timeLabel(new Date(Date.parse(match.utcDate) - 3_600_000).toISOString()) : "");
  const lineupsOut = $derived(Boolean(detail?.home?.lineup?.length && detail?.away?.lineup?.length));

  let talkNode = $state(null);
  $effect(() => {
    if (talkNode && match.id != null) mountBanter(talkNode, match.id);
  });
  onDestroy(() => unmountBanter());

  function talkClick(event) {
    if (event.target.closest("[data-section-nav='you']")) {
      event.preventDefault();
      event.stopPropagation();
      ontalksignin?.();
    }
  }

  // Swipe down on the header closes the sheet on a phone.
  let startY = null;
  function headerTouchStart(event) { startY = event.changedTouches[0].clientY; }
  function headerTouchEnd(event) {
    if (startY !== null && event.changedTouches[0].clientY - startY > 80) onclose();
    startY = null;
  }

  function onKey(event) {
    if (event.key === "Escape") onclose();
  }

  const isFollowed = team => followsTeam(follows, match.competitionCode, team);
  const formClass = result => ({ W: "w", D: "d", L: "l" })[result] ?? "d";
  const formWords = form => form.map(result => ({ W: "win", D: "draw", L: "loss" })[result] ?? result).join(", ");
  const ordinal = n => `${n}${({ 1: "st", 2: "nd", 3: "rd" })[n % 10] && ![11, 12, 13].includes(n % 100) ? ({ 1: "st", 2: "nd", 3: "rd" })[n % 10] : "th"}`;
</script>

<svelte:window onkeydown={onKey} />

<div class="sheet" class:desktop role="dialog" aria-modal={desktop ? undefined : "true"} aria-label="{home} v {away}">
  <div class="sticky" ontouchstart={headerTouchStart} ontouchend={headerTouchEnd}>
    {#if !desktop}<div class="grip" aria-hidden="true"><i></i></div>{/if}
    <div class="bar">
      <button class="icon" aria-label="Close match" onclick={onclose}>
        {#if desktop}
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
        {:else}
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
        {/if}
      </button>
      <span class="label">{context}</span>
      <span class="fresh" class:delayed={fresh.delayed} aria-live="polite">
        {#if phase === "live"}<span class="dot pulse" class:delayed={fresh.delayed} aria-hidden="true"></span>{/if}{phase === "live" || fresh.delayed ? fresh.text.replace("Updated ", "") : ""}
      </span>
    </div>
    <div class="score">
      {#each [["home", match.homeTeam, home], ["away", match.awayTeam, away]] as [side, team, name], i}
        <div class="team" style:order={i === 0 ? 0 : 2}>
          <Crest {team} size={44} />
          <span class="tname">
            {#if side === "away" && detail && redCards(detail, team)}<i class="redcard" aria-label="Red card"></i>{/if}
            {name}
            {#if side === "home" && detail && redCards(detail, team)}<i class="redcard" aria-label="Red card"></i>{/if}
            <button class="star" class:on={isFollowed(team)} aria-pressed={isFollowed(team)} aria-label="{isFollowed(team) ? 'Unfollow' : 'Follow'} {name}" onclick={() => onfollow(match.competitionCode, team)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill={isFollowed(team) ? "currentColor" : "none"} stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l2.8 5.8 6.2.9-4.5 4.4 1.1 6.3L12 17.5 6.4 20.4l1.1-6.3L3 9.7l6.2-.9z" /></svg>
            </button>
          </span>
        </div>
      {/each}
      <div class="mid" style:order={1} aria-live="polite">
        {#if phase === "pre" || phase === "off"}
          <div class="kick">{phase === "off" ? statusLabel(match) : timeLabel(match.utcDate)}</div>
          <div class="muted small">{phase === "pre" ? (untilKickoff(match.utcDate, now) ? `Kicks off ${untilKickoff(match.utcDate, now)}` : dayLabel(match.utcDate)) : ""}</div>
        {:else}
          <div class="hero-num" aria-label="{phase === 'post' ? 'Full time, ' : ''}{home} {match.score.home ?? 0}, {away} {match.score.away ?? 0}">
            <span>{match.score.home ?? 0}</span><span class="sep">:</span><span>{match.score.away ?? 0}</span>
          </div>
          {#if phase === "live"}
            <div class="live minute"><span class="dot pulse" aria-hidden="true"></span>{statusLabel(match)}</div>
          {:else}
            <div class="muted small">{match.penalties ? `Full time · pens ${match.penalties.home}-${match.penalties.away}` : "Full time"}</div>
          {/if}
        {/if}
      </div>
    </div>
  </div>

  <div class="body">
    {#if (phase === "live" || phase === "post") && (scorers.home.length || scorers.away.length)}
      <p class="scorers"><span>{scorers.home.join(" · ")}</span><span class="right">{scorers.away.join(" · ")}</span></p>
    {/if}

    {#if phase === "pre"}
      <p class="meta">
        {#if match.venue}<span>{match.venue}</span>{/if}
        {#if detail?.referee}<span>Referee {detail.referee}</span>{/if}
        {#if !lineupsOut && lineupsDue}<span>Line-ups about {lineupsDue}</span>{/if}
      </p>
      <Predict {match} {home} {away} {ontalksignin} />
      {#if homeForm || awayForm}
        <section>
          <div class="section-h"><h2>Form</h2></div>
          <div class="form-grid">
            {#each [[match.homeTeam, home, homeForm], [match.awayTeam, away, awayForm]] as [team, name, info]}
              {#if info}
                <div>
                  <div class="form-head"><Crest {team} /><span>{name}</span>
                    <span class="dots" aria-label="Form: {formWords(info.form)}">{#each info.form as result}<i class="dot {formClass(result)}"></i>{/each}</span>
                  </div>
                  <div class="muted small">{ordinal(info.position)}, {info.points} pts</div>
                </div>
              {/if}
            {/each}
          </div>
        </section>
      {/if}
    {/if}

    {#if phase === "post" && analysis}
      <article class="report">
        <div class="report-top"><span class="label">Match report</span><span class="chip">Written by AI from the match data</span></div>
        {#if analysis.headline}<h2>{analysis.headline}</h2>{/if}
        <p>{analysis.match}</p>
        <p>{analysis.context}</p>
      </article>
    {/if}

    {#if phase === "post" && potm}
      <section class="potm">
        <div class="label">Player of the match</div>
        <div class="potm-row">
          <span class="rating top">{potm.rating.toFixed(1)}</span>
          <div><div class="pname">{potm.name}</div>{#if potm.line}<div class="muted small">{potm.line}</div>{/if}</div>
        </div>
      </section>
    {/if}

    {#if phase === "live" && stats.length}
      {@render statBars()}
    {/if}

    {#if phase === "live" && allMoments.length}
      <section>
        <div class="section-h">
          <h2>Latest</h2>
          {#if allMoments.length > 3}<button class="link" onclick={() => (timelineOpen = !timelineOpen)} aria-expanded={timelineOpen}>{timelineOpen ? "Latest only" : `Full timeline · ${allMoments.length}`}</button>{/if}
        </div>
        {@render timeline(latest)}
      </section>
    {/if}

    {#if banterAvailable() && phase !== "off"}
      <section>
        <div class="section-h"><h2>Talk</h2></div>
        <div class="talk" bind:this={talkNode} onclick={talkClick} role="presentation"></div>
      </section>
    {/if}

    {#if phase === "post" && stats.length}
      <div class="section-h"><h2>Stats</h2></div>
      {@render statBars()}
    {/if}

    {#if (phase === "live" || phase === "post" || lineupsOut) && (ratedPitch(detail, "home") || ratedPitch(detail, "away"))}
      <section>
        <div class="section-h">
          <h2>{anyRated ? "Ratings" : "Line-ups"}</h2>
          <div class="sides">
            <button class="toggle" class:on={ratingSide === "home"} onclick={() => (ratingSide = "home")}>{home}</button>
            <button class="toggle" class:on={ratingSide === "away"} onclick={() => (ratingSide = "away")}>{away}</button>
          </div>
        </div>
        {#if pitch}
          <div class="pitch">
            {#each [...pitch].reverse() as line}
              <div class="line">
                {#each line as player (player.id ?? player.name)}
                  <div class="player">
                    {#if player.rating !== null}<span class="rating" class:top={player.top}>{player.rating.toFixed(1)}</span>{/if}
                    <span class="pn">{player.name}</span>
                  </div>
                {/each}
              </div>
            {/each}
          </div>
          {#if anyRated}<p class="note">Ratings from the data provider{phase === "live" ? ", recalculated through the match" : ""}. Unrated players show no number.</p>{/if}
        {:else}
          <p class="note">Line-up not placed on the pitch by the provider yet.</p>
        {/if}
      </section>
    {/if}

    {#if phase === "post" && allMoments.length}
      <section>
        <div class="section-h"><h2>Timeline</h2></div>
        {@render timeline(allMoments)}
      </section>
    {/if}
  </div>
</div>

{#snippet statBars()}
  <section class="stats" aria-label="Match statistics">
    {#each stats as row (row.key)}
      <div class="stat">
        <b class:lead={row.leader === "home"}>{row.text[0]}</b>
        <div>
          <div class="label">{row.label}</div>
          <div class="bar" role="img" aria-label="{row.label}: {home} {row.text[0]}, {away} {row.text[1]}">
            <i class="h" class:lead={row.leader === "home"} style:width="{row.share * 100}%"></i>
            <i class="a" class:lead={row.leader === "away"} style:width="{(1 - row.share) * 100}%"></i>
          </div>
        </div>
        <b class="r" class:lead={row.leader === "away"}>{row.text[1]}{#if row.reds?.[1]}<span class="reds"> +{row.reds[1]} red</span>{/if}</b>
      </div>
    {/each}
  </section>
{/snippet}

{#snippet timeline(items)}
  <ol class="events">
    {#each items as item (item.kind + item.index)}
      <li class={item.side}>
        <b class="emin">{minuteText(item)}</b>
        <i class="mk {item.kind}" aria-label={({ goal: "Goal", red: "Red card", yellow: "Yellow card", sub: "Substitution" })[item.kind]}></i>
        <span class="etext">{#if item.kind === "goal"}<b>{item.player}</b>{:else}{item.player}{/if}<span class="muted"> · {displayTeamName(item.team)}{item.note ? ` · ${item.note}` : ""}</span></span>
        {#if item.score}<b class="escore">{item.score}</b>{/if}
      </li>
    {/each}
  </ol>
{/snippet}

<style>
  .sheet { position: fixed; inset: 0; z-index: 30; background: var(--bg); overflow-y: auto; overscroll-behavior: contain; animation: rise 240ms ease-out; }
  .sheet.desktop { position: sticky; top: 56px; inset: auto; height: calc(100vh - 56px); border-left: 1px solid var(--line); animation: none; }
  @keyframes rise { from { transform: translateY(24px); opacity: 0; } to { transform: none; opacity: 1; } }
  .sticky { position: sticky; top: 0; z-index: 2; background: var(--bg); padding: 0 8px 12px; border-bottom: 1px solid var(--line); }
  .grip { height: 20px; display: flex; align-items: center; justify-content: center; }
  .grip i { width: 36px; height: 4px; border-radius: 2px; background: var(--faint); display: block; }
  .bar { display: flex; align-items: center; justify-content: space-between; height: 44px; }
  .icon { width: 44px; height: 44px; display: inline-flex; align-items: center; justify-content: center; color: var(--muted); }
  .fresh { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); padding-right: 8px; min-width: 44px; justify-content: flex-end; }
  .fresh.delayed { color: var(--gold); }
  .score { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 8px; padding: 0 8px; }
  .team { display: flex; flex-direction: column; align-items: center; gap: 6px; min-width: 0; }
  .tname { display: inline-flex; align-items: center; gap: 4px; font-size: 13px; font-weight: 600; text-align: center; }
  .star { width: 32px; height: 32px; display: inline-flex; align-items: center; justify-content: center; color: var(--faint); }
  .star.on { color: var(--accent); }
  .mid { display: flex; flex-direction: column; align-items: center; gap: 4px; }
  .kick { font-size: 32px; font-weight: 800; }
  .minute { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 700; }
  .small { font-size: 13px; }
  .body { padding: 0 16px 48px; }
  .scorers { display: flex; justify-content: space-between; gap: 12px; font-size: 13px; color: var(--muted); margin: 10px 0 0; }
  .scorers .right { text-align: right; }
  .meta { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 13px; color: var(--muted); margin: 12px 0 4px; }
  section { margin-top: 12px; }
  .link { font-size: 13px; color: var(--muted); min-height: 44px; }
  .stats { display: flex; flex-direction: column; gap: 12px; margin-top: 16px; }
  .stat { display: grid; grid-template-columns: 52px 1fr 52px; align-items: center; gap: 10px; font-size: 13px; }
  .stat .label { text-align: center; margin-bottom: 4px; }
  .stat b { font-size: 15px; color: var(--muted); }
  .stat b.lead { color: var(--text); }
  .stat .r { text-align: right; }
  .reds { color: var(--clay); font-size: 11px; }
  .bar { display: flex; gap: 2px; height: 4px; }
  .bar i { height: 4px; border-radius: 2px; background: var(--line-2); }
  .bar i.lead { background: var(--accent); }
  .bar i.a.lead { background: var(--text); }
  .events { list-style: none; margin: 0; padding: 0; }
  .events li { display: grid; grid-template-columns: 44px 16px 1fr auto; align-items: center; gap: 8px; min-height: 44px; border-bottom: 1px solid var(--line); font-size: 15px; }
  .emin { font-size: 13px; }
  .etext { min-width: 0; }
  .escore { font-size: 13px; }
  .mk { width: 10px; height: 10px; border-radius: 50%; justify-self: center; }
  .mk.goal { background: var(--accent); }
  .mk.red { width: 8px; height: 11px; border-radius: 1px; background: var(--clay); }
  .mk.yellow { width: 8px; height: 11px; border-radius: 1px; background: var(--gold); }
  .mk.sub { box-shadow: inset 0 0 0 1.5px var(--muted); }
  .talk { min-height: 44px; }
  .sides { display: flex; gap: 16px; }
  .sides .toggle { max-width: 120px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: block; line-height: 44px; }
  .pitch { background: linear-gradient(180deg, #0f2416 0%, #0d1a12 100%); border-radius: 10px; padding: 14px 8px; display: flex; flex-direction: column; gap: 14px; }
  .line { display: flex; justify-content: space-around; }
  .player { display: flex; flex-direction: column; align-items: center; gap: 4px; min-width: 0; flex: 1; }
  .pn { font-size: 12px; max-width: 72px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .report { margin-top: 16px; }
  .report-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
  .report h2 { font-size: 24px; line-height: 1.2; font-weight: 800; margin: 10px 0 8px; }
  .report p { font-size: 15px; line-height: 1.55; margin: 0 0 10px; color: #d4dbd6; }
  .potm { padding: 12px 0; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
  .potm-row { display: flex; align-items: center; gap: 12px; margin-top: 8px; }
  .potm .rating { height: 28px; min-width: 40px; font-size: 15px; }
  .pname { font-size: 17px; font-weight: 700; }
  .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .form-head { display: flex; align-items: center; gap: 8px; font-size: 15px; font-weight: 600; margin-bottom: 4px; flex-wrap: wrap; }
  .dots { display: inline-flex; gap: 3px; }
  .dots .w { background: var(--accent); }
  .dots .d { background: var(--faint); }
  .dots .l { background: var(--clay); }
</style>

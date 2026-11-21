<script>
  import Crest from "./Crest.svelte";
  import { mountSignIn } from "../account.js";
  import { briefingPref, previewBriefing } from "../briefing.js";
  import { FUNNEL_EVENTS } from "../funnelEvents.js";
  import { track } from "../telemetry.js";
  import { COMPETITIONS } from "../competitions.js";
  import { displayTeamName } from "../domain.js";

  let { briefing = null, loading = false, failed = false, signedIn = false, prefs = {}, matches = [], follows = [], now, onopen, onpref } = $props();

  // Signed out, the same cards render from a preview: real results, sample
  // fantasy. Built from the minute clock so it is not rebuilt every second.
  const minute = $derived(Math.floor(now / 60_000) * 60_000);
  const view = $derived(signedIn ? briefing : previewBriefing({ matches, follows, now: minute }));
  const sample = $derived(!signedIn);

  let signInBox = $state(null);
  let signInFailed = $state(false);
  $effect(() => {
    if (!sample || !signInBox) return;
    track(FUNNEL_EVENTS.HOME_PREVIEW_VIEWED, {});
    mountSignIn(signInBox, { surface: "home_preview", onError: () => (signInFailed = true) });
  });

  const CARD_LABELS = { fantasyNext: "This week", fantasyLast: "Last gameweek", clubs: "Your clubs", headlines: "Around the leagues" };

  const shown = key => sample || briefingPref(prefs, key);
  const hidden = $derived(Object.keys(CARD_LABELS).filter(key => !shown(key)));
  const fantasy = $derived(view?.fantasy ?? []);
  const nexts = $derived(fantasy.filter(entry => entry.next));
  const lasts = $derived(fantasy.filter(entry => entry.last));
  const clubs = $derived(view?.clubs ?? []);
  // A followed club's result already has its own card; repeat it here only
  // when that card is hidden.
  const results = $derived((view?.headlines?.results ?? [])
    .filter(row => !(shown("clubs") && clubs.some(club => String(club.matchId) === String(row.matchId)))));
  const live = $derived(view?.headlines?.live ?? 0);
  const multiLeague = $derived(fantasy.length > 1);
  const anything = $derived((shown("fantasyNext") && nexts.length) || (shown("fantasyLast") && lasts.length)
    || (shown("clubs") && clubs.length) || (shown("headlines") && results.length));

  const sinceText = $derived(view?.since
    ? new Date(view.since).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })
    : "");

  function openResult(row) {
    const match = matches.find(entry => String(entry.id) === String(row.matchId));
    if (match) onopen(match);
  }

  function deadlineText(iso) {
    const at = Date.parse(iso ?? "");
    if (!Number.isFinite(at)) return null;
    const ms = at - now;
    if (ms <= 0) return null;
    const hours = Math.floor(ms / 3_600_000);
    if (hours >= 48) return new Date(at).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
    if (hours >= 1) return `${hours}h ${Math.floor((ms % 3_600_000) / 60_000)}m`;
    return `${Math.max(1, Math.floor(ms / 60_000))}m`;
  }

  const rankMove = rank => (rank?.before == null || rank?.after == null ? 0 : rank.before - rank.after);
  const ordinal = n => `${n}${["th", "st", "nd", "rd"][(n % 100 > 10 && n % 100 < 14) || n % 10 > 3 ? 0 : n % 10]}`;
</script>

<section class="brief">
  {#if signedIn && loading && !briefing}
    <p class="muted status" role="status">Loading…</p>
  {:else if signedIn && failed && !briefing}
    <p class="muted status" role="status">Home is unavailable right now.</p>
  {:else if view}
    <header class="head">
      <h1>Home</h1>
      {#if sinceText}<span class="label">Since {sinceText}</span>{/if}
    </header>

    {#if sample}
      <div class="join">
        <h2>Your clubs and your fantasy week, the moment you open the app</h2>
        {#if signInFailed}<a class="btn" href="#you">Sign in</a>{:else}<div class="gis" bind:this={signInBox}></div>{/if}
      </div>
    {/if}

    {#if live > 0}
      <a class="live-row" href="#live"><span class="dot pulse" aria-hidden="true"></span>{live} live now</a>
    {/if}

    {#if shown("fantasyNext") && nexts.length}
      <article class="card stake" class:sample>
        <header><h2 class="label">{CARD_LABELS.fantasyNext}</h2>{#if sample}<span class="label">Sample</span>{:else}<button class="hide" onclick={() => onpref("fantasyNext", false)}>Hide</button>{/if}</header>
        {#each nexts as { league, next }}
          <div class="row">
            {#if multiLeague}<span class="label">{league.name}</span>{/if}
            <div class="line">
              <span class="big">GW{next.gameweek} v {next.opponent ? next.opponent.name : "Average"}</span>
              {#if next.opponent?.isBot}<span class="chip">BOT</span>{/if}
              {#if next.opponent?.form?.length}
                <span class="form">{#each next.opponent.form as f}<span class="f {f}">{f}</span>{/each}</span>
              {/if}
            </div>
            <div class="facts">
              {#if next.locked}<span>Squad locked</span>
              {:else if deadlineText(next.deadline)}<span>Deadline <strong>{deadlineText(next.deadline)}</strong></span>{/if}
              {#if next.blankStarters.length}
                <span class="warn">No match: {next.blankStarters.map(p => p.name).join(", ")}</span>
              {/if}
              {#if next.doubleTeams.length}<span>Double: {next.doubleTeams.map(displayTeamName).join(", ")}</span>{/if}
            </div>
            {#if !sample}<a class="go" href="#fantasy">My team</a>{/if}
          </div>
        {/each}
      </article>
    {/if}

    {#if shown("fantasyLast") && lasts.length}
      <article class="card stake" class:sample>
        <header><h2 class="label">{CARD_LABELS.fantasyLast}</h2>{#if sample}<span class="label">Sample</span>{:else}<button class="hide" onclick={() => onpref("fantasyLast", false)}>Hide</button>{/if}</header>
        {#each lasts as { league, last }}
          <div class="row">
            {#if multiLeague}<span class="label">{league.name}</span>{/if}
            <div class="line">
              <span class="res {last.result}">{last.result}</span>
              <span class="big">{last.score.mine}–{last.score.theirs}</span>
              <span class="muted">v {last.opponent?.name ?? "Average"}</span>
              {#if last.opponent?.isBot}<span class="chip">BOT</span>{/if}
            </div>
            <div class="facts">
              {#if last.rank.after}
                <span>{ordinal(last.rank.after)}{#if rankMove(last.rank) > 0} <span class="up">▲{rankMove(last.rank)}</span>{:else if rankMove(last.rank) < 0} <span class="down">▼{-rankMove(last.rank)}</span>{/if}</span>
              {/if}
              {#if last.top}<span>Top: {last.top.name} {last.top.points}</span>{/if}
              {#if last.flop}<span>Flop: {last.flop.name} {last.flop.points}{last.flop.isCaptain ? " (C)" : ""}</span>{/if}
            </div>
          </div>
        {/each}
      </article>
    {/if}

    {#if shown("clubs") && clubs.length}
      <article class="card">
        <header><h2 class="label">{CARD_LABELS.clubs}</h2>{#if !sample}<button class="hide" onclick={() => onpref("clubs", false)}>Hide</button>{/if}</header>
        {#each clubs as row}
          <button class="result" onclick={() => openResult(row)}>
            <span class="team"><Crest team={row.homeTeam} />{displayTeamName(row.homeTeam)}</span>
            <span class="score">{row.score.home ?? "-"}–{row.score.away ?? "-"}</span>
            <span class="team away">{displayTeamName(row.awayTeam)}<Crest team={row.awayTeam} /></span>
            {#if row.headline}<span class="note">{row.headline}</span>{/if}
          </button>
        {/each}
      </article>
    {/if}

    {#if shown("headlines") && results.length}
      <article class="card">
        <header><h2 class="label">{CARD_LABELS.headlines}</h2>{#if !sample}<button class="hide" onclick={() => onpref("headlines", false)}>Hide</button>{/if}</header>
        {#each results as row}
          <button class="result" onclick={() => openResult(row)}>
            <span class="team"><Crest team={row.homeTeam} />{displayTeamName(row.homeTeam)}</span>
            <span class="score">{row.score.home ?? "-"}–{row.score.away ?? "-"}</span>
            <span class="team away">{displayTeamName(row.awayTeam)}<Crest team={row.awayTeam} /></span>
            <span class="note muted">{COMPETITIONS[row.competition]?.name ?? row.competition}</span>
          </button>
        {/each}
      </article>
    {/if}

    {#if !anything && !sample}<p class="muted status">Nothing new since {sinceText}.</p>{/if}

    {#if !sample}
    <footer class="prefs">
      {#each hidden as key}
        <button class="restore" onclick={() => onpref(key, true)}>Show {CARD_LABELS[key]}</button>
      {/each}
      <label class="toggle">
        <input type="checkbox" checked={briefingPref(prefs, "landing")} onchange={event => onpref("landing", event.currentTarget.checked)} />
        Open here when there's news
      </label>
    </footer>
    {/if}
  {/if}
</section>

<style>
  .brief { max-width: 640px; margin: 0 auto; padding: 8px 16px 32px; display: flex; flex-direction: column; gap: 12px; }
  h1 { margin: 0; font-size: 28px; font-weight: 900; font-style: italic; text-transform: uppercase; letter-spacing: -0.02em; }
  .head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
  .status { padding: 24px 0; }
  .btn { background: var(--accent); color: var(--accent-ink); font-weight: 700; padding: 0 18px; min-height: 44px; display: inline-flex; align-items: center; border-radius: 8px; }
  .live-row { display: inline-flex; align-items: center; gap: 8px; color: var(--accent); font-weight: 600; min-height: 44px; }
  .join { display: flex; flex-direction: column; gap: 12px; align-items: flex-start; padding: 4px 0 8px; }
  .join h2 { margin: 0; font-size: 18px; font-weight: 700; line-height: 1.3; }
  .gis { min-height: 44px; }
  .card.sample { opacity: 0.75; }
  .card { background: var(--surface); border-radius: 12px; padding: 12px 16px; display: flex; flex-direction: column; }
  .card.stake { box-shadow: inset 3px 0 0 var(--violet); }
  .card header { display: flex; align-items: center; justify-content: space-between; }
  .card h2 { margin: 0; }
  .hide, .restore { color: var(--muted); font-size: 13px; min-height: 44px; padding: 0 4px; }
  .row { display: flex; flex-direction: column; gap: 4px; padding: 8px 0; border-top: 1px solid var(--line); }
  .row:first-of-type { border-top: 0; }
  .line { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .big { font-size: 18px; font-weight: 700; }
  .chip { font-size: 10px; font-weight: 700; letter-spacing: 0.06em; color: var(--muted); border: 1px solid var(--line-2); border-radius: 4px; padding: 1px 4px; }
  .form { display: inline-flex; gap: 3px; }
  .f { font-size: 11px; font-weight: 700; width: 18px; height: 18px; display: inline-flex; align-items: center; justify-content: center; border-radius: 3px; background: var(--surface-2); color: var(--muted); }
  .f.W { color: var(--accent); }
  .f.L { color: var(--clay); }
  .facts { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 13px; color: var(--muted); }
  .facts strong { color: var(--text); }
  .warn { color: var(--gold); }
  .up { color: var(--accent); }
  .down { color: var(--clay); }
  .res { font-weight: 900; font-style: italic; font-size: 18px; }
  .res.W { color: var(--accent); }
  .res.L { color: var(--clay); }
  .res.D { color: var(--muted); }
  .go { color: var(--accent); font-size: 13px; font-weight: 600; min-height: 44px; display: inline-flex; align-items: center; align-self: flex-start; }
  .result { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 8px; padding: 10px 0; min-height: 44px; border-top: 1px solid var(--line); text-align: left; }
  .result:first-of-type { border-top: 0; }
  .team { display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
  .team.away { justify-content: flex-end; }
  .score { font-weight: 700; }
  .note { grid-column: 1 / -1; font-size: 13px; color: var(--muted); }
  .prefs { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 16px; padding-top: 4px; }
  .toggle { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; color: var(--muted); min-height: 44px; }
  .toggle input { accent-color: var(--accent); width: 18px; height: 18px; }
</style>

<script>
  import { untrack } from "svelte";
  import Crest from "./Crest.svelte";
  import MatchRow from "./MatchRow.svelte";
  import PlayerSheet from "./PlayerSheet.svelte";
  import TablePanel from "./TablePanel.svelte";
  import { COMPETITIONS, COMPETITION_CODES } from "../competitions.js";
  import { DATA_API } from "../data.js";
  import { displayTeamName } from "../domain.js";
  import { localDateKey } from "../scoreDates.js";
  import { followsTeam } from "../teamFollows.js";
  import { LEAGUE_TABS, firstDays, groupByDay, leagueFixtures, leagueResults } from "./league.js";

  // One competition: its full table, every fixture and result the feed holds,
  // and Sportmonks season leaderboards. Opening a match keeps this page
  // underneath it, so closing the match comes straight back here.
  let { code, tab = "table", feeds, follows = [], flashed = new Set(), desktop = false, now, ontab, oncompetition, onopen } = $props();

  const feed = $derived(feeds.find(entry => entry.competition.code === code) ?? null);
  const matches = $derived((feed?.matches ?? []).map(match => ({ ...match, competitionCode: code })));
  const fixtureDays = $derived(groupByDay(leagueFixtures(matches)));
  const resultDays = $derived(groupByDay(leagueResults(matches)));
  const today = $derived(localDateKey(now));

  // A few matchdays at a time; reset whenever the competition changes.
  const STEP = 4;
  let fixtureCount = $state(STEP);
  let resultCount = $state(STEP);
  $effect(() => {
    code;
    fixtureCount = STEP;
    resultCount = STEP;
  });
  const fixtures = $derived(firstDays(fixtureDays, fixtureCount));
  const results = $derived(firstDays(resultDays, resultCount));

  const isFollowed = match => followsTeam(follows, code, match.homeTeam) || followsTeam(follows, code, match.awayTeam);
  const dayTitle = day => (day === today ? "Today" : new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long" }).format(new Date(`${day}T12:00:00`)));

  // Stats: fetched when the tab is first opened for a competition, kept for
  // the visit. Absent (no Worker, no Sportmonks, nothing returned) says so
  // rather than drawing empty leaderboards.
  let stats = $state({});
  let statsCategory = $state("goals");
  const inflight = new Set();
  function loadStats(wanted) {
    if (stats[wanted] || inflight.has(wanted)) return;
    if (!DATA_API) { stats = { ...stats, [wanted]: { available: false } }; return; }
    inflight.add(wanted);
    fetch(`${DATA_API}/${wanted}/stats`, { signal: AbortSignal.timeout(10000) })
      .then(response => (response.ok ? response.json() : { available: false }))
      .catch(() => ({ available: false, failed: true }))
      .then(body => { stats = { ...stats, [wanted]: body?.available ? body : { available: false, failed: Boolean(body?.failed) } }; })
      .finally(() => inflight.delete(wanted));
  }
  $effect(() => {
    if (tab !== "stats" || !code) return;
    const wanted = code;
    untrack(() => loadStats(wanted));
  });
  const current = $derived(stats[code] ?? null);
  const category = $derived(current?.categories?.find(entry => entry.key === statsCategory) ?? current?.categories?.[0] ?? null);
  let statRows = $state(10);
  $effect(() => { statsCategory; code; statRows = 10; });

  let selected = $state(null);
  function openPlayer(row) {
    selected = { player: { fullName: row.name, num: null }, team: row.team, centrePlayer: { playerId: row.playerId }, seasonId: current?.seasonId ?? null };
  }
</script>

<main class="league" class:desktop>
  <header class="lhead">
    <a class="back" href="#live" aria-label="Back to live scores">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6" /></svg>
    </a>
    <h1>{COMPETITIONS[code]?.name ?? code}</h1>
  </header>

  <nav class="comps" aria-label="Competition">
    {#each COMPETITION_CODES as entry}
      <button class="toggle" class:on={entry === code} aria-pressed={entry === code} onclick={() => oncompetition(entry)}>{COMPETITIONS[entry].shortName}</button>
    {/each}
  </nav>

  <nav class="tabs" aria-label="League sections">
    {#each LEAGUE_TABS as entry}
      <button class="tab" class:on={entry.key === tab} aria-current={entry.key === tab ? "page" : undefined} onclick={() => ontab(entry.key)}>{entry.label}</button>
    {/each}
  </nav>

  {#if !feed?.hasData}
    <p class="empty">{feed?.loading ? "Loading…" : `${COMPETITIONS[code]?.name ?? code} is unavailable right now.`}</p>
  {:else if tab === "table"}
    {#if feed.tables?.some(table => table.rows?.length)}
      <TablePanel feeds={[feed]} {follows} competition={code} detailed locked wide={desktop} />
    {:else}
      <p class="empty">No table for {COMPETITIONS[code]?.name ?? code} yet.</p>
    {/if}
  {:else if tab === "fixtures" || tab === "results"}
    {@const view = tab === "fixtures" ? fixtures : results}
    {#each view.shown as group (group.day)}
      <div class="day-h label strong">{dayTitle(group.day)}</div>
      {#each group.matches as match (match.id)}
        <MatchRow {match} flash={flashed.has(match.id)} followed={isFollowed(match)} aside={isFollowed(match) ? "Your club" : (match.matchday ? `Matchday ${match.matchday}` : "")} {onopen} />
      {/each}
    {:else}
      <p class="empty">{tab === "fixtures" ? "No upcoming fixtures in the feed." : "No results yet."}</p>
    {/each}
    {#if view.more}
      <button class="more" onclick={() => (tab === "fixtures" ? (fixtureCount += STEP) : (resultCount += STEP))}>
        {tab === "fixtures" ? "Later fixtures" : "Earlier results"}
      </button>
    {/if}
  {:else if tab === "stats"}
    {#if !current}
      <p class="empty" role="status">Loading player stats…</p>
    {:else if !current.available}
      <p class="empty">Player stats are unavailable right now{current.failed ? ". Try again shortly" : ""}.</p>
    {:else}
      <div class="cats" role="group" aria-label="Leaderboard">
        {#each current.categories as entry (entry.key)}
          <button class="toggle" class:on={entry === category} aria-pressed={entry === category} onclick={() => (statsCategory = entry.key)}>{entry.label}</button>
        {/each}
      </div>
      {#if category}
        <ol class="board" aria-label="{category.label} leaderboard">
          {#each category.rows.slice(0, statRows) as row, index (row.playerId)}
            <li>
              <button class="prow" onclick={() => openPlayer(row)}>
                <span class="rank">{row.position ?? index + 1}</span>
                {#if row.image}<img class="photo" src={row.image} alt="" loading="lazy" />{:else}<span class="photo"></span>{/if}
                <span class="who">
                  <span class="pname">{row.name}</span>
                  {#if row.team}<span class="pteam"><Crest team={row.team} size={14} />{displayTeamName(row.team)}</span>{/if}
                </span>
                <span class="total">{row.total}</span>
              </button>
            </li>
          {/each}
        </ol>
        {#if category.rows.length > statRows}
          <button class="more" onclick={() => (statRows = category.rows.length)}>Show top {category.rows.length}</button>
        {/if}
        <p class="note">Season to date · Sportmonks</p>
      {/if}
    {/if}
  {/if}
</main>

{#if selected}
  <PlayerSheet player={selected.player} team={selected.team} centrePlayer={selected.centrePlayer} seasonId={selected.seasonId} onclose={() => (selected = null)} />
{/if}

<style>
  .league { min-width: 0; padding: 0 16px 24px; }
  .league.desktop { padding: 0 24px 24px; max-width: 880px; width: 100%; margin: 0 auto; }
  .lhead { display: flex; align-items: center; gap: 4px; min-height: 52px; }
  .lhead h1 { margin: 0; font-size: 22px; font-weight: 900; font-style: italic; text-transform: uppercase; letter-spacing: -0.01em; }
  .back { width: 44px; height: 44px; margin-left: -12px; display: inline-flex; align-items: center; justify-content: center; color: var(--muted); }
  .comps, .cats { display: flex; gap: 20px; overflow-x: auto; scrollbar-width: none; }
  .comps::-webkit-scrollbar, .cats::-webkit-scrollbar { display: none; }
  .comps .toggle, .cats .toggle { flex: none; white-space: nowrap; }
  .tabs { display: flex; border-bottom: 1px solid var(--line); margin-bottom: 4px; position: sticky; top: 52px; background: var(--bg); z-index: 5; }
  .desktop .tabs { top: 56px; }
  .tab { flex: 1; min-height: 44px; font-size: 14px; font-weight: 600; color: var(--muted); }
  .desktop .tab { flex: none; padding: 0 20px; }
  .tab.on { color: var(--text); box-shadow: inset 0 -2px 0 var(--accent); }
  .league :global(.tables) { padding: 0; }
  .league :global(.row) { padding: 0 4px; }
  .day-h { padding: 16px 0 4px; }
  .strong { color: var(--text); font-weight: 700; }
  .empty { padding: 24px 0; color: var(--muted); font-size: 15px; margin: 0; }
  .more { color: var(--muted); font-size: 13px; min-height: 44px; }
  .board { list-style: none; margin: 4px 0 0; padding: 0; }
  .prow { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 52px; border-bottom: 1px solid var(--line); text-align: left; }
  .prow:hover { background: rgba(255, 255, 255, 0.02); }
  .rank { width: 22px; flex: none; color: var(--muted); font-size: 13px; text-align: right; }
  .photo { width: 32px; height: 32px; border-radius: 50%; object-fit: cover; background: var(--surface-2); flex: none; }
  .who { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .pname { font-size: 15px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pteam { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); }
  .total { font-size: 17px; font-weight: 800; min-width: 28px; text-align: right; }
  li:first-child .total { color: var(--accent); }
</style>

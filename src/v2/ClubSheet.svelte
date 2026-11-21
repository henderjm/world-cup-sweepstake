<script>
  import Crest from "./Crest.svelte";
  import MatchRow from "./MatchRow.svelte";
  import PlayerSheet from "./PlayerSheet.svelte";
  import { COMPETITIONS } from "../competitions.js";
  import { DATA_API } from "../data.js";
  import { CLUB_STAT_SORTS, clubLeaderboard, formatStat, squadLine } from "../sportmonksSquad.js";
  import { displayTeamName } from "../domain.js";
  import { followsTeam } from "../teamFollows.js";
  import { clubFixtures } from "./matchCentre.js";

  // One club's fixtures, results and season player stats in one competition.
  // Opened from a table row, a followed club or the league Stats tab
  // (`initialView: "players"`); tapping a match hands it to the match page.
  let { club, matches, follows = [], desktop = false, initialView = null, onclose, onopen, onfollow } = $props();

  const name = $derived(displayTeamName(club.team));
  const competition = $derived(COMPETITIONS[club.code]?.name ?? "");
  const lists = $derived(clubFixtures(matches, club.code, club.team));
  let view = $state(initialView);
  // Upcoming by default; a club with nothing left to play opens on results.
  const shown = $derived(view ?? (lists.counts.upcoming ? "upcoming" : "results"));

  // Season player stats, fetched the first time the Players tab is shown.
  let squad = $state(null);
  let squadFor = "";
  let sortKey = $state("goals");
  $effect(() => {
    const key = `${club.code}:${club.team}`;
    if (shown !== "players" || squadFor === key) return;
    squadFor = key;
    squad = null;
    if (!DATA_API) { squad = { available: false }; return; }
    fetch(`${DATA_API}/${club.code}/club?team=${encodeURIComponent(club.team)}`, { signal: AbortSignal.timeout(10000) })
      .then(response => (response.ok ? response.json() : { available: false }))
      .catch(() => ({ available: false, failed: true }))
      .then(body => { if (squadFor === key) squad = body?.available ? body : { available: false, failed: Boolean(body?.failed) }; });
  });
  const sorts = $derived(squad?.available ? CLUB_STAT_SORTS.filter(sort => clubLeaderboard(squad.players, sort.key).length) : []);
  const activeSort = $derived(sorts.some(sort => sort.key === sortKey) ? sortKey : sorts[0]?.key ?? null);
  const board = $derived(activeSort ? clubLeaderboard(squad.players, activeSort) : []);
  const top = $derived(board[0]?.value || 0);
  let selected = $state(null);
  const followed = $derived(followsTeam(follows, club.code, club.team));

  const dayHeading = day => (day
    ? new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short" }).format(new Date(`${day}T12:00:00`))
    : "Date to be confirmed");

  function onKey(event) {
    if (event.key === "Escape") onclose();
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="sheet" class:desktop role="dialog" aria-modal={desktop ? undefined : "true"} aria-label="{name} fixtures">
  <div class="sticky">
    <div class="bar">
      <button class="icon" aria-label="Close club" onclick={onclose}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
      </button>
      <span class="label">{competition}</span>
      <span class="spacer"></span>
    </div>
    <div class="head">
      <Crest team={club.team} size={44} />
      <h2>{name}</h2>
      {#if onfollow}
        <button class="toggle" class:on={followed} aria-pressed={followed} onclick={() => onfollow(club.code, club.team)}>{followed ? "Following" : "Follow"}</button>
      {/if}
    </div>
    <div class="segs" role="group" aria-label="Show">
      <button class="toggle" class:on={shown === "upcoming"} aria-pressed={shown === "upcoming"} onclick={() => (view = "upcoming")}>Fixtures ({lists.counts.upcoming})</button>
      <button class="toggle" class:on={shown === "results"} aria-pressed={shown === "results"} onclick={() => (view = "results")}>Results ({lists.counts.results})</button>
      <button class="toggle" class:on={shown === "players"} aria-pressed={shown === "players"} onclick={() => (view = "players")}>Players</button>
    </div>
  </div>

  <div class="body">
    {#if shown === "players"}
      {#if !squad}
        <p class="empty" role="status">Loading player stats…</p>
      {:else if !squad.available || !board.length}
        <p class="empty">Player stats for {name} are unavailable right now{squad.failed ? ". Try again shortly" : ""}.</p>
      {:else}
        <div class="sorts" role="group" aria-label="Sort players by">
          {#each sorts as sort (sort.key)}
            <button class="toggle" class:on={sort.key === activeSort} aria-pressed={sort.key === activeSort} onclick={() => (sortKey = sort.key)}>{sort.label}</button>
          {/each}
        </div>
        <ol class="squad" aria-label="{name} players by {CLUB_STAT_SORTS.find(sort => sort.key === activeSort)?.label}">
          {#each board as player, index (player.playerId)}
            <li>
              <button class="prow" onclick={() => (selected = player)}>
                <span class="rank">{index + 1}</span>
                {#if player.image}<img class="photo" src={player.image} alt="" loading="lazy" />{:else}<span class="photo"></span>{/if}
                <span class="who">
                  <span class="pname">{player.name}</span>
                  <span class="pmeta">{[player.pos, player.num != null ? `#${player.num}` : null, squadLine(player)].filter(Boolean).join(" · ")}</span>
                  {#if activeSort !== "rating" && top > 0}<span class="bar" aria-hidden="true"><i style:width="{(player.value / top) * 100}%"></i></span>{/if}
                </span>
                <span class="val">{formatStat(activeSort, player.value)}</span>
              </button>
            </li>
          {/each}
        </ol>
        <p class="note">{competition} season to date · Sportmonks</p>
      {/if}
    {:else}
    {#each lists[shown] as group (group.day)}
      <div class="label day">{dayHeading(group.day)}</div>
      {#each group.matches as match (match.id)}
        <MatchRow {match} {onopen} />
      {/each}
    {:else}
      <p class="empty">{shown === "upcoming" ? `No upcoming ${competition} fixtures for ${name} in the feed yet.` : `No ${competition} results for ${name} yet.`}</p>
    {/each}
    {/if}
  </div>
</div>

{#if selected}
  <PlayerSheet player={{ fullName: selected.name, num: selected.num }} team={club.team} centrePlayer={{ playerId: selected.playerId }} seasonId={squad?.seasonId ?? null} onclose={() => (selected = null)} />
{/if}

<style>
  .sheet { position: fixed; inset: 0; z-index: 30; background: var(--bg); overflow-y: auto; overscroll-behavior: contain; animation: rise 240ms ease-out; }
  .sheet.desktop { top: 56px; left: auto; width: 460px; z-index: 15; border-left: 1px solid var(--line); animation: none; }
  @keyframes rise { from { transform: translateY(24px); opacity: 0; } to { transform: none; opacity: 1; } }
  .sticky { position: sticky; top: 0; z-index: 2; background: var(--bg); padding: 0 8px 10px; border-bottom: 1px solid var(--line); }
  .bar { display: flex; align-items: center; justify-content: space-between; height: 44px; }
  .icon, .spacer { width: 44px; height: 44px; display: inline-flex; align-items: center; justify-content: center; color: var(--muted); }
  .head { display: flex; align-items: center; gap: 12px; padding: 4px 8px 10px; }
  .head h2 { font-size: 20px; font-weight: 800; margin: 0; flex: 1; min-width: 0; }
  .segs { display: flex; gap: 8px; padding: 0 8px; }
  .body { padding: 0 16px 48px; }
  .day { margin: 16px 0 4px; }
  .empty { color: var(--muted); font-size: 15px; margin-top: 24px; }
  .segs { flex-wrap: wrap; }
  .sorts { display: flex; gap: 6px; overflow-x: auto; padding: 12px 0 4px; scrollbar-width: none; }
  .sorts .toggle { flex: none; }
  .squad { list-style: none; margin: 0; padding: 0; }
  .prow { width: 100%; display: grid; grid-template-columns: 22px 36px 1fr auto; align-items: center; gap: 10px; min-height: 56px; padding: 6px 0; border-bottom: 1px solid var(--line); text-align: left; }
  .rank { font-size: 13px; color: var(--muted); text-align: right; }
  .photo { width: 36px; height: 36px; border-radius: 50%; object-fit: cover; background: var(--line); display: block; }
  .who { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  .pname { font-size: 15px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pmeta { font-size: 12px; color: var(--muted); }
  .bar { display: block; height: 3px; border-radius: 2px; background: var(--line); overflow: hidden; }
  .bar i { display: block; height: 100%; background: var(--accent); border-radius: 2px; }
  .val { font-size: 17px; font-weight: 800; min-width: 36px; text-align: right; }
  li:first-child .val { color: var(--accent); }
  .note { font-size: 12px; color: var(--faint); margin-top: 12px; }
</style>

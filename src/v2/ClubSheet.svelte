<script>
  import Crest from "./Crest.svelte";
  import MatchRow from "./MatchRow.svelte";
  import { COMPETITIONS } from "../competitions.js";
  import { displayTeamName } from "../domain.js";
  import { followsTeam } from "../teamFollows.js";
  import { clubFixtures } from "./matchCentre.js";

  // One club's fixtures and results in one competition. Opened from a table
  // row or a followed club; tapping a match hands it to the match page.
  let { club, matches, follows = [], desktop = false, onclose, onopen, onfollow } = $props();

  const name = $derived(displayTeamName(club.team));
  const competition = $derived(COMPETITIONS[club.code]?.name ?? "");
  const lists = $derived(clubFixtures(matches, club.code, club.team));
  let view = $state(null);
  // Upcoming by default; a club with nothing left to play opens on results.
  const shown = $derived(view ?? (lists.counts.upcoming ? "upcoming" : "results"));
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
    </div>
  </div>

  <div class="body">
    {#each lists[shown] as group (group.day)}
      <div class="label day">{dayHeading(group.day)}</div>
      {#each group.matches as match (match.id)}
        <MatchRow {match} {onopen} />
      {/each}
    {:else}
      <p class="empty">{shown === "upcoming" ? `No upcoming ${competition} fixtures for ${name} in the feed yet.` : `No ${competition} results for ${name} yet.`}</p>
    {/each}
  </div>
</div>

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
</style>

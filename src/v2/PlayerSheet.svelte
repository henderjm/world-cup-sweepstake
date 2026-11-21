<script>
  import { onMount } from "svelte";
  import Crest from "./Crest.svelte";
  import { DATA_API } from "../data.js";
  import { displayTeamName } from "../domain.js";
  import { matchHeadline, matchStatGroups, seasonStatRows } from "../playerStats.js";

  // One player: this match's figures straight away (they ride on the match
  // centre), the season's once fetched. A bottom sheet on a phone, a card on
  // desktop.
  let { player, team, centrePlayer = null, seasonId = null, onclose } = $props();

  const keeper = $derived(Boolean(centrePlayer?.keeper));
  const headline = $derived(matchHeadline(centrePlayer?.stats));
  const groups = $derived(matchStatGroups(centrePlayer?.stats, { keeper }));
  let season = $state(null);
  const seasonRows = $derived(seasonStatRows(season?.stats, { keeper }));
  let closeButton = $state(null);

  onMount(() => {
    closeButton?.focus();
    const id = centrePlayer?.playerId;
    if (!DATA_API || !id || !seasonId) return;
    const controller = new AbortController();
    fetch(`${DATA_API}/player/${id}/season/${seasonId}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]) })
      .then(response => (response.ok ? response.json() : null))
      .then(body => { if (body?.available) season = body; })
      .catch(() => {});
    return () => controller.abort();
  });

  function onKey(event) {
    if (event.key === "Escape") {
      event.stopPropagation();
      onclose();
    }
  }
</script>

<svelte:window onkeydowncapture={onKey} />

<div class="backdrop" onclick={onclose} role="presentation"></div>
<div class="card" role="dialog" aria-modal="true" aria-label="{player.fullName} statistics">
  <div class="head">
    {#if season?.image}
      <img class="photo" src={season.image} alt="" loading="lazy" />
    {:else}
      <span class="photo num">{player.num ?? ""}</span>
    {/if}
    <div class="who">
      <div class="name">{player.fullName}</div>
      <div class="meta">
        <Crest {team} size={16} />
        <span>{displayTeamName(team)}{player.num != null ? ` · #${player.num}` : ""}{season?.position ? ` · ${season.position}` : ""}</span>
      </div>
    </div>
    {#if headline.rating !== null}<span class="rating big" class:top={player.top}>{headline.rating.toFixed(1)}</span>{/if}
    <button class="close" bind:this={closeButton} aria-label="Close" onclick={onclose}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
    </button>
  </div>

  <div class="body">
    {#if groups.length || headline.minutes !== null}
      <div class="label section">This match{headline.minutes !== null ? ` · ${headline.minutes}'` : ""}</div>
      {#each groups as group (group.title)}
        <div class="group">
          <div class="gtitle">{group.title}</div>
          {#each group.rows as row (row.label)}
            <div class="stat"><span>{row.label}</span><b>{row.value}</b></div>
          {/each}
        </div>
      {/each}
    {/if}

    {#if seasonRows.length}
      <div class="label section">Season</div>
      <div class="group">
        {#each seasonRows as row (row.label)}
          <div class="stat"><span>{row.label}</span><b>{row.value}</b></div>
        {/each}
      </div>
    {/if}
  </div>
</div>

<style>
  .backdrop { position: fixed; inset: 0; background: rgba(4, 6, 9, 0.6); z-index: 40; }
  .card { position: fixed; z-index: 41; left: 0; right: 0; bottom: 0; max-height: 85vh; display: flex; flex-direction: column; background: var(--surface); border-radius: 16px 16px 0 0; animation: up 200ms ease-out; }
  @media (min-width: 1024px) {
    .card { left: auto; right: 24px; bottom: auto; top: 80px; width: 420px; max-height: calc(100vh - 104px); border-radius: 12px; animation: none; }
  }
  @keyframes up { from { transform: translateY(24px); opacity: 0; } to { transform: none; opacity: 1; } }
  .head { display: flex; align-items: center; gap: 12px; padding: 16px 12px 12px 16px; border-bottom: 1px solid var(--line); }
  .photo { width: 48px; height: 48px; border-radius: 50%; object-fit: cover; background: var(--surface-2); flex: none; }
  .photo.num { display: grid; place-items: center; font-weight: 800; font-size: 17px; }
  .who { flex: 1; min-width: 0; }
  .name { font-size: 17px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .meta { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--muted); margin-top: 2px; }
  .rating.big { height: 28px; min-width: 42px; font-size: 15px; }
  .close { width: 44px; height: 44px; display: inline-flex; align-items: center; justify-content: center; color: var(--muted); flex: none; }
  .body { overflow-y: auto; padding: 0 16px 24px; overscroll-behavior: contain; }
  .section { margin: 16px 0 4px; color: var(--text); }
  .group { margin-bottom: 4px; }
  .gtitle { font-size: 12px; color: var(--muted); margin: 10px 0 2px; }
  .stat { display: flex; justify-content: space-between; align-items: center; min-height: 34px; border-bottom: 1px solid var(--line); font-size: 15px; }
  .stat span { color: var(--muted); }
  .stat b { font-weight: 700; }
</style>

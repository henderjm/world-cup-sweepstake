<script>
  import Crest from "./Crest.svelte";
  import { COMPETITIONS } from "../competitions.js";
  import { displayTeamName } from "../domain.js";
  import { followsTeam } from "../teamFollows.js";

  // League tables for every competition that has one, switchable with text
  // toggles. Full table by default; `compact` starts at the top six with a
  // "Full table" expand, for places where the table shares the screen.
  let { feeds, follows = [], competition = null, oncompetition, compact = false, wide = false } = $props();

  const available = $derived(feeds.filter(feed => feed.hasData && feed.tables?.some(table => table.rows?.length)));
  const selected = $derived(available.find(feed => feed.competition.code === competition) ?? available[0] ?? null);
  let expanded = $state(false);
  const tables = $derived(selected?.tables?.filter(table => table.rows?.length) ?? []);
  const limit = $derived(compact && !expanded ? 6 : Infinity);

  const formClass = result => ({ W: "w", D: "d", L: "l" })[result] ?? "d";
  const formWords = form => form.map(result => ({ W: "win", D: "draw", L: "loss" })[result] ?? result).join(", ");
  const gd = value => (value > 0 ? `+${value}` : String(value));
</script>

{#if selected}
  <section class="tables" aria-label="League tables">
    <div class="section-h">
      <h2>Table</h2>
      {#if selected.tablesLive}<span class="chip live-chip">As it stands</span>{/if}
    </div>
    {#if available.length > 1}
      <div class="comps" role="group" aria-label="Competition">
        {#each available as feed (feed.competition.code)}
          <button class="toggle" class:on={feed === selected} aria-pressed={feed === selected}
            onclick={() => { expanded = false; oncompetition?.(feed.competition.code); }}>
            {COMPETITIONS[feed.competition.code]?.shortName ?? feed.competition.name}
          </button>
        {/each}
      </div>
    {/if}

    {#each tables as table, index (table.name ?? index)}
      {#if tables.length > 1}<div class="label group">{table.name}</div>{/if}
      <div class="grid" class:wide role="table" aria-label="{table.name ?? selected.competition.name} table">
        <div class="trow head" role="row">
          <span role="columnheader">#</span><span></span><span role="columnheader">Club</span>
          <span class="num" role="columnheader">P</span><span class="num" role="columnheader">GD</span><span class="num" role="columnheader">Pts</span>
          {#if wide}<span class="num" role="columnheader">Form</span>{/if}
        </div>
        {#each table.rows.slice(0, limit) as row (row.team)}
          {@const mine = followsTeam(follows, selected.competition.code, row.team)}
          <div class="trow zone-{row.zone?.tone ?? 'none'}" class:mine role="row" title={row.zone?.label ?? ""}>
            <span class="pos" role="cell">{row.position}</span>
            <Crest team={row.team} size={18} />
            <span class="name" role="cell">{displayTeamName(row.team)}</span>
            <span class="num" role="cell">{row.played}</span>
            <span class="num" role="cell">{gd(row.goalDifference)}</span>
            <span class="num pts" role="cell">{row.points}</span>
            {#if wide}
              <span class="form" role="cell" aria-label="Form: {formWords(row.form ?? [])}">{#each row.form ?? [] as result}<i class="dot {formClass(result)}"></i>{/each}</span>
            {/if}
          </div>
        {/each}
      </div>
    {/each}

    {#if compact && tables.some(table => table.rows.length > 6)}
      <button class="more" aria-expanded={expanded} onclick={() => (expanded = !expanded)}>{expanded ? "Top six only" : "Full table"}</button>
    {/if}
    {#if (selected.competition.zones ?? []).length}
      <div class="legend">
        {#each selected.competition.zones as zone (zone.label)}
          <span><i class="key zone-{zone.tone}"></i>{zone.label}</span>
        {/each}
      </div>
    {/if}
  </section>
{/if}

<style>
  .tables { padding: 8px 16px 0; }
  :global(.right) .tables, :global(.desktop) .tables { padding: 8px 0 0; }
  .comps { display: flex; gap: 20px; margin-bottom: 4px; }
  .live-chip { color: var(--accent); }
  .group { margin: 12px 0 2px; }
  .grid { display: flex; flex-direction: column; }
  .trow { display: grid; grid-template-columns: 22px 18px minmax(0, 1fr) 28px 36px 32px; align-items: center; gap: 8px; min-height: 36px; border-bottom: 1px solid var(--line); font-size: 13px; position: relative; padding-left: 6px; }
  .wide .trow { grid-template-columns: 22px 18px minmax(0, 1fr) 28px 36px 32px 58px; }
  .trow.head { min-height: 28px; color: var(--faint); font-size: 11px; font-weight: 600; letter-spacing: 0.06em; }
  .trow::before { content: ""; position: absolute; left: 0; top: 6px; bottom: 6px; width: 2px; border-radius: 1px; }
  .trow.zone-safe::before { background: var(--accent); }
  .trow.zone-edge::before { background: var(--gold); }
  .trow.zone-out::before { background: var(--clay); }
  .trow.mine { background: var(--accent-soft); }
  .pos { color: var(--muted); }
  .name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 15px; }
  .num { text-align: right; color: var(--muted); }
  .pts { color: var(--text); font-weight: 700; }
  .form { display: flex; gap: 3px; justify-content: flex-end; }
  .form .w { background: var(--accent); }
  .form .d { background: var(--faint); }
  .form .l { background: var(--clay); }
  .more { color: var(--muted); font-size: 13px; min-height: 44px; }
  .legend { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 12px; color: var(--muted); margin: 8px 0; }
  .key { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 6px; }
  .key.zone-safe { background: var(--accent); }
  .key.zone-edge { background: var(--gold); }
  .key.zone-out { background: var(--clay); }
</style>

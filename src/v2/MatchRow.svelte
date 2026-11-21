<script>
  import Crest from "./Crest.svelte";
  import { displayTeamName } from "../domain.js";
  import { isLive, statusLabel } from "../format.js";
  import { hasScore, shortTeamName } from "./matchCentre.js";

  let { match, flash = false, followed = false, aside = "", onopen } = $props();

  const live = $derived(isLive(match.status));
  const scored = $derived(hasScore(match));
  const home = $derived(displayTeamName(match.homeTeam));
  const away = $derived(displayTeamName(match.awayTeam));
  const label = $derived(
    `${live ? `Live, ${statusLabel(match)}` : statusLabel(match)}: ${home}${scored ? ` ${match.score.home}, ${away} ${match.score.away}` : ` v ${away}`}`,
  );
</script>

<a
  class="row"
  class:is-live={live}
  class:flash
  class:followed
  href="#match/{match.id}"
  aria-label={label}
  onclick={event => { event.preventDefault(); onopen?.(match); }}
>
  <span class="when">{statusLabel(match)}</span>
  <Crest team={match.homeTeam} />
  <span class="team">{shortTeamName(home)}</span>
  {#if scored}
    <span class="score">{match.score.home} - {match.score.away}</span>
  {:else}
    <span class="score vs">v</span>
  {/if}
  <span class="team right">{shortTeamName(away)}</span>
  <Crest team={match.awayTeam} />
  {#if aside}<span class="aside">{aside}</span>{/if}
</a>

<style>
  .row { display: flex; align-items: center; gap: 6px; min-height: 44px; padding: 0 16px; border-bottom: 1px solid var(--line); }
  .row:hover { background: rgba(255, 255, 255, 0.02); }
  .row.is-live { background: var(--accent-soft); }
  .when { font-size: 13px; color: var(--muted); width: 40px; flex: none; }
  .is-live .when { color: var(--accent); font-weight: 700; }
  .team { font-size: 15px; font-weight: 500; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .followed .team { font-weight: 600; }
  .right { text-align: right; }
  .score { font-size: 15px; font-weight: 700; min-width: 40px; text-align: center; }
  .vs { color: var(--faint); font-weight: 400; }
  .aside { display: none; }
  @media (min-width: 1024px) {
    .aside { display: block; width: 180px; flex: none; font-size: 13px; color: var(--muted); text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  }
</style>

<script>
  import { abbrFor, crestFor } from "../badges.js";

  let { team, size = 20 } = $props();
  let failed = $state(false);
  const src = $derived(crestFor(team));
</script>

{#if src && !failed}
  <img class="crest" {src} alt="" loading="lazy" style:width="{size}px" style:height="{size}px" onerror={() => (failed = true)} />
{:else}
  <span class="crest-ring" style:width="{size}px" style:height="{size}px" aria-hidden="true">{abbrFor(team)}</span>
{/if}

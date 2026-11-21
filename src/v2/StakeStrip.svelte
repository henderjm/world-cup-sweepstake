<script>
  import { trackerSummary } from "../fantasyGameweekTracker.js";
  import { matchupTiming } from "../fantasyScheduleView.js";

  // "Your matchup" on the Live home: the visitor's own head-to-head score this
  // gameweek, in violet because it is their stake. Scores follow the same
  // matchupTiming rule as V1's My team strip, so the two can never disagree
  // about whether a scoreline may be shown yet.
  let { matchup, now } = $props();

  // A null matchup is the reserved slot shown while a returning manager's
  // matchup loads: same box, no content, so its arrival moves nothing.
  const timing = $derived(matchup ? matchupTiming(matchup, now) : null);
  const score = side => (timing?.showScores ? String(side?.score ?? 0) : "-");
  const summary = $derived(matchup ? trackerSummary(matchup.me?.progress) : "");
</script>

{#if !matchup}
<div class="stake slot" aria-hidden="true">
  <span class="dot"></span>
  <div class="grow">
    <div class="top"><span class="line">&nbsp;</span></div>
    <div class="sub">&nbsp;</div>
  </div>
</div>
{:else}
<a class="stake" href="#fantasy" aria-label="Open your gameweek {matchup.gameweek} matchup">
  <span class="dot" aria-hidden="true"></span>
  <div class="grow">
    <div class="top">
      <span class="label violet">Your matchup · GW{matchup.gameweek}</span>
      {#if matchup.opponent}
        <span class="line">You {score(matchup.me)} <span class="muted">v</span> {matchup.opponent.name} {score(matchup.opponent)}</span>
      {:else}
        <span class="line">You {score(matchup.me)} <span class="muted">v Average</span></span>
      {/if}
    </div>
    <div class="sub muted">{summary || timing.label}</div>
  </div>
</a>
{/if}

<style>
  .slot .dot { opacity: 0.3; }
  .stake { display: flex; align-items: center; gap: 12px; margin: 12px 16px 0; padding: 10px 0 12px; border-bottom: 1px solid var(--line); }
  :global(.desktop) .stake { margin: 12px 0 0; }
  .dot { background: var(--violet); }
  .grow { flex: 1; min-width: 0; }
  .top { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
  .violet { color: var(--violet); }
  .line { font-size: 15px; font-weight: 700; }
  .line .muted { font-weight: 400; }
  .sub { font-size: 13px; margin-top: 2px; }
</style>

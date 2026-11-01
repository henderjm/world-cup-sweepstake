<script>
  import { isSignedIn } from "../account.js";
  import { timeLabel } from "../format.js";
  import { canPredict } from "../predictions.js";
  import { loadLocalPredictions, predictionsAvailable, saveLocalPrediction, submitPrediction } from "../predictionsApi.js";

  // The prediction game inline on a pre-match page: one tap per side. Signed
  // out it is saved on the device exactly like V1's Predict tab; signed in it
  // goes to the server, which re-checks the kickoff lock (fails closed).
  let { match, home, away, ontalksignin } = $props();

  const GOALS = [0, 1, 2, 3, 4, 5];
  const saved = loadLocalPredictions()[match.id];
  let homeGoals = $state(saved?.homeGoals ?? null);
  let awayGoals = $state(saved?.awayGoals ?? null);
  let status = $state(saved ? "saved" : "");

  async function pick(side, goals) {
    if (side === "home") homeGoals = goals;
    else awayGoals = goals;
    if (homeGoals === null || awayGoals === null) return;
    status = "saving";
    try {
      if (isSignedIn()) await submitPrediction(match.id, homeGoals, awayGoals);
      else saveLocalPrediction(match.id, homeGoals, awayGoals, match.competitionCode);
      status = "saved";
    } catch (error) {
      status = error.status === 409 ? "locked" : "error";
    }
  }
</script>

{#if predictionsAvailable() && canPredict(match)}
  <section class="predict">
    <div class="section-h">
      <h2>Predict the score</h2>
      <span class="label">Exact 3 · result 1</span>
    </div>
    {#each [["home", home, homeGoals], ["away", away, awayGoals]] as [side, name, value]}
      <div class="side">
        <div class="label">{name}</div>
        <div class="digits" role="radiogroup" aria-label="{name} goals">
          {#each GOALS as goals}
            <button role="radio" aria-checked={value === goals} class:on={value === goals} onclick={() => pick(side, goals)}>{goals}</button>
          {/each}
        </div>
      </div>
    {/each}
    <p class="note" role="status">
      {#if status === "saved"}Saved · locks {timeLabel(match.utcDate)}{#if !isSignedIn()} · <button class="link" onclick={ontalksignin}>Sign in</button>{/if}
      {:else if status === "saving"}Saving
      {:else if status === "locked"}Closed
      {:else if status === "error"}Not saved{/if}
    </p>
  </section>
{/if}

<style>
  .predict { margin-top: 8px; padding-bottom: 12px; border-bottom: 1px solid var(--line); }
  .side { margin-top: 8px; }
  .digits { display: grid; grid-template-columns: repeat(6, 1fr); gap: 6px; margin-top: 6px; }
  .digits button { height: 44px; border-radius: 8px; background: var(--surface); font-size: 17px; font-weight: 700; color: var(--muted); }
  .digits button.on { background: var(--accent); color: var(--accent-ink); }
  .link { color: var(--accent); font-weight: 600; }
</style>

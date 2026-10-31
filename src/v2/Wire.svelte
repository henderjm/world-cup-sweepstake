<script>
  import { abbrFor } from "../badges.js";
  import { describeWireItem, isBigMoment, minuteLabel, sortWireItems, WIRE_KINDS } from "../liveWire.js";
  import { followsTeam } from "../teamFollows.js";

  let { items, follows, matches, onopen, expandedDefault = false } = $props();
  let expanded = $state(false);

  // Big moments only (goals, reds, VAR, full time): the Wire is the day's
  // headlines, not a second timeline.
  const shown = $derived(sortWireItems(items.filter(item => isBigMoment(item) || item.kind === WIRE_KINDS.FULL_TIME)));
  const visible = $derived(expanded || expandedDefault ? shown : shown.slice(0, 3));

  function open(item) {
    const match = matches.find(entry => String(entry.id) === String(item.matchId));
    if (match) onopen(match);
  }
  const followed = item => followsTeam(follows, item.competition, item.homeTeam) || followsTeam(follows, item.competition, item.awayTeam);
  const mark = item => item.overturned || item.kind === WIRE_KINDS.OVERTURNED ? "var"
    : item.kind === WIRE_KINDS.GOAL ? "goal" : item.kind === WIRE_KINDS.CARD ? "red" : "ft";
  const scoreText = item => item.score ? `${abbrFor(item.homeTeam)} ${item.score.home}-${item.score.away} ${abbrFor(item.awayTeam)}` : `${abbrFor(item.homeTeam)} v ${abbrFor(item.awayTeam)}`;
</script>

{#if shown.length}
  <section class="wire" aria-label="The Wire">
    <div class="section-h">
      <h2>The Wire <span class="dot pulse" aria-hidden="true"></span></h2>
      <span class="muted small">All matches · newest first</span>
    </div>
    <ol>
      {#each visible as item (item.rowId ?? item.key)}
        {@const words = describeWireItem(item)}
        <li class:followed={followed(item)}>
          <button onclick={() => open(item)}>
            <span class="top">
              <b class="min">{minuteLabel(item) || "FT"}</b>
              <i class="mark {mark(item)}" aria-hidden="true"></i>
              <span class="what"><b>{words.headline}</b> <span class="muted">{words.line}</span></span>
            </span>
            <span class="where muted">{item.competition} · {scoreText(item)}{#if mark(item) === "var"} <span class="chip">VAR</span>{/if}</span>
            {#if item.ai}<span class="ai"><span class="chip">AI</span> {item.ai}</span>{/if}
          </button>
        </li>
      {/each}
    </ol>
    {#if !expandedDefault && shown.length > 3}
      <button class="more" onclick={() => (expanded = !expanded)} aria-expanded={expanded}>
        {expanded ? "Show fewer" : `Show all ${shown.length}`}
      </button>
    {/if}
  </section>
{/if}

<style>
  .wire { padding: 8px 16px 0; }
  :global(.desktop) .wire, :global(.right) .wire { padding: 8px 0 0; }
  h2 { display: inline-flex; align-items: center; gap: 8px; }
  .small { font-size: 12px; }
  ol { list-style: none; margin: 0; padding: 0; }
  li { border-bottom: 1px solid var(--line); }
  li.followed { box-shadow: inset 2px 0 0 var(--accent); }
  li button { width: 100%; text-align: left; padding: 10px 0 10px 8px; display: flex; flex-direction: column; gap: 4px; min-height: 44px; }
  .top { display: flex; gap: 8px; align-items: baseline; font-size: 15px; }
  .min { width: 40px; flex: none; font-size: 13px; }
  .mark { width: 8px; height: 8px; border-radius: 50%; flex: none; align-self: center; }
  .mark.goal { background: var(--accent); }
  .mark.red { width: 8px; height: 11px; border-radius: 1px; background: var(--clay); }
  .mark.var { box-shadow: inset 0 0 0 1.5px var(--muted); }
  .mark.ft { background: var(--faint); }
  .what { min-width: 0; }
  .where { font-size: 12px; padding-left: 56px; display: flex; align-items: center; gap: 6px; }
  .ai { font-size: 13px; color: var(--text); padding-left: 56px; line-height: 1.45; }
  .more { color: var(--muted); font-size: 13px; min-height: 44px; }
</style>

<script>
  import Crest from "./Crest.svelte";
  import { displayTeamName } from "../domain.js";
  import PlayerSheet from "./PlayerSheet.svelte";
  import { lineupSide, shortPlayerName } from "./matchCentre.js";

  // Both XIs on one full pitch (away attacking down from the top, home up
  // from the bottom), then each side's bench and who is out, side by side.
  let { detail, homeTeam, awayTeam, sidelined = null, centre = null } = $props();

  // The tapped player, joined to the match centre's figures by side and
  // shirt number (both providers carry it), falling back to the surname.
  let selected = $state(null);
  function centrePlayerFor(side, player) {
    const list = centre?.players?.[side] ?? [];
    return list.find(entry => entry.num != null && entry.num === player.num)
      ?? list.find(entry => shortPlayerName(entry.name) === player.name)
      ?? null;
  }
  function pick(side, player) {
    selected = { side, player, team: side === "home" ? homeTeam : awayTeam, centrePlayer: centrePlayerFor(side, player) };
  }

  const home = $derived(lineupSide(detail, "home"));
  const away = $derived(lineupSide(detail, "away"));
  // Keeper at the very top for the away side, the very bottom for the home
  // side; the away side is mirrored so left and right match the broadcast.
  const awayRows = $derived(away?.rows ? away.rows.map(line => [...line].reverse()) : null);
  const homeRows = $derived(home?.rows ? [...home.rows].reverse() : null);
  const out = $derived({ home: sidelined?.home ?? [], away: sidelined?.away ?? [] });
  const anyOut = $derived(out.home.length > 0 || out.away.length > 0);
</script>

{#snippet tile(player, side)}
  <button class="player" title={player.fullName} aria-label="{player.fullName}, statistics" onclick={() => pick(side, player)}>
    <div class="marks">
      {#if player.rating !== null}<span class="rating" class:top={player.top}>{player.rating.toFixed(1)}</span>{/if}
    </div>
    <div class="shirt">
      <span class="num">{player.num ?? ""}</span>
      {#if player.goals}<i class="goal" role="img" aria-label="{player.goals} goal{player.goals === 1 ? '' : 's'}">{player.goals > 1 ? player.goals : ""}</i>{/if}
      {#if player.card}<i class="card {player.card}" role="img" aria-label="{player.card === 'red' ? 'Red' : 'Yellow'} card"></i>{/if}
      {#if player.off !== null}<i class="off" role="img" aria-label="Substituted {player.off} minutes">{player.off}'</i>{/if}
    </div>
    <span class="pname">{player.name}</span>
  </button>
{/snippet}

{#snippet half(rows, xi, side)}
  {#if rows}
    {#each rows as line}
      <div class="line">{#each line as player (player.id ?? player.name)}{@render tile(player, side)}{/each}</div>
    {/each}
  {:else}
    <div class="line wrap">{#each xi as player (player.id ?? player.name)}{@render tile(player, side)}{/each}</div>
  {/if}
{/snippet}

{#if home || away || anyOut}
  <section class="lineups">
    <div class="section-h">
      <h2>Line-ups</h2>
      {#if home?.formation || away?.formation}
        <span class="label">{home?.formation ?? "?"}{" · "}{away?.formation ?? "?"}</span>
      {/if}
    </div>

    {#if home || away}
      <div class="pitch">
        <div class="halfway" aria-hidden="true"></div>
        <div class="circle" aria-hidden="true"></div>
        <div class="box top" aria-hidden="true"></div>
        <div class="box bottom" aria-hidden="true"></div>
        <div class="side away" aria-label="{displayTeamName(awayTeam)} starting eleven">
          {#if away}{@render half(awayRows, away.xi, "away")}{/if}
        </div>
        <div class="side home" aria-label="{displayTeamName(homeTeam)} starting eleven">
          {#if home}{@render half(homeRows, home.xi, "home")}{/if}
        </div>
      </div>

      <div class="cols">
        {#each [["home", homeTeam, home], ["away", awayTeam, away]] as [side, team, data]}
          <div class="col">
            <div class="col-h"><Crest {team} size={18} /><span>{displayTeamName(team)}</span></div>
            {#if data?.bench?.length}
              <ul class="bench">
                {#each data.bench as player (player.id ?? player.name)}
                  <li class:used={player.on !== null}>
                    <button class="brow" aria-label="{player.fullName}, statistics" onclick={() => pick(side, player)}>
                      <span class="bname">{player.fullName}</span>
                      {#if player.on !== null}<span class="on">{player.on}'</span>{/if}
                      {#if player.rating !== null}<span class="rating" class:top={player.top}>{player.rating.toFixed(1)}</span>{/if}
                    </button>
                  </li>
                {/each}
              </ul>
            {/if}
            {#if data?.coach}<div class="coach"><span class="label">Coach</span> {data.coach}</div>{/if}
          </div>
        {/each}
      </div>
    {/if}

    {#if anyOut}
      <div class="cols out-cols">
        {#each [["home", homeTeam], ["away", awayTeam]] as [key, team]}
          <div class="col">
            <div class="label out-h">Out{#if !(home || away)}{` · ${displayTeamName(team)}`}{/if}</div>
            <ul class="out">
              {#each out[key] as player (player.name)}
                <li><span class="bname">{player.name}</span><span class="reason" class:susp={player.suspended}>{player.reason ?? ""}</span></li>
              {/each}
            </ul>
          </div>
        {/each}
      </div>
    {/if}
  </section>
{/if}

{#if selected}
  <PlayerSheet player={selected.player} team={selected.team} centrePlayer={selected.centrePlayer} seasonId={centre?.seasonId ?? null} onclose={() => (selected = null)} />
{/if}

<style>
  .lineups { margin-top: 12px; }
  .pitch {
    position: relative; border-radius: 12px; overflow: hidden; padding: 10px 4px;
    background: repeating-linear-gradient(180deg, #11291a 0 44px, #0f2416 44px 88px);
    display: flex; flex-direction: column;
  }
  .halfway { position: absolute; left: 0; right: 0; top: 50%; border-top: 1px solid rgba(255, 255, 255, 0.12); }
  .circle { position: absolute; left: 50%; top: 50%; width: 84px; height: 84px; margin: -42px 0 0 -42px; border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 50%; }
  .box { position: absolute; left: 25%; right: 25%; height: 52px; border: 1px solid rgba(255, 255, 255, 0.12); }
  .box.top { top: -1px; border-top: 0; }
  .box.bottom { bottom: -1px; border-bottom: 0; }
  .side { position: relative; display: flex; flex-direction: column; justify-content: space-around; gap: 14px; padding: 6px 0; min-height: 290px; }
  .side.away { padding-bottom: 18px; }
  .side.home { padding-top: 18px; }
  .line { display: flex; justify-content: space-around; align-items: flex-start; }
  .line.wrap { flex-wrap: wrap; row-gap: 12px; }
  .player { display: flex; flex-direction: column; align-items: center; gap: 2px; flex: 1; min-width: 0; max-width: 96px; min-height: 44px; border-radius: 8px; padding: 2px 0; }
  .player:hover { background: rgba(255, 255, 255, 0.04); }
  .line.wrap .player { flex: 0 0 25%; }
  .marks { height: 18px; }
  .shirt { position: relative; width: 30px; height: 30px; border-radius: 50%; background: rgba(255, 255, 255, 0.92); color: #0a0e14; display: grid; place-items: center; font-size: 12px; font-weight: 800; }
  .side.away .shirt { background: #1d2733; color: var(--text); box-shadow: inset 0 0 0 1.5px rgba(255, 255, 255, 0.5); }
  .goal { position: absolute; right: -8px; top: -4px; min-width: 14px; height: 14px; border-radius: 7px; background: var(--accent); color: var(--accent-ink); font-size: 9px; font-style: normal; font-weight: 800; display: grid; place-items: center; padding: 0 3px; }
  .card { position: absolute; left: -6px; top: -4px; width: 8px; height: 11px; border-radius: 1px; }
  .card.yellow { background: var(--gold); }
  .card.red { background: var(--clay); }
  .off { position: absolute; right: -12px; bottom: -4px; font-size: 9px; font-style: normal; font-weight: 700; color: var(--clay); background: #0a0e14; border-radius: 4px; padding: 0 2px; }
  .pname { font-size: 12px; max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: center; }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 14px; }
  .col { min-width: 0; }
  .col-h { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 700; padding-bottom: 6px; border-bottom: 1px solid var(--line); }
  ul { list-style: none; margin: 0; padding: 0; }
  .bench li, .out li { display: flex; align-items: center; gap: 6px; min-height: 32px; border-bottom: 1px solid var(--line); font-size: 13px; color: var(--muted); }
  .bench li.used { color: var(--text); }
  .brow { display: flex; align-items: center; gap: 6px; width: 100%; min-height: 32px; text-align: left; color: inherit; font-size: 13px; }
  .bname { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .on { color: var(--accent); font-size: 12px; font-weight: 700; }
  .coach { font-size: 13px; margin-top: 8px; }
  .out-cols { margin-top: 18px; }
  .out-h { padding-bottom: 6px; border-bottom: 1px solid var(--line); }
  .out li { flex-direction: column; align-items: flex-start; justify-content: center; gap: 0; padding: 4px 0; color: var(--text); }
  .reason { font-size: 12px; color: var(--muted); }
  .reason.susp { color: var(--clay); }
</style>

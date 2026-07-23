<script>
  import { onMount } from "svelte";

  onMount(() => {
    import("./app.js");
  });
</script>

<canvas id="confetti" aria-hidden="true"></canvas>

<div class="shell">
  <header class="topnav">
    <button class="brand" type="button" data-section-nav="scores">
      <span class="brand__mark">SG</span>
      <span class="brand__stack">
        <strong class="brand__name">Squad Goals</strong>
        <span class="brand__sub">Scores · Tables · Fantasy</span>
      </span>
    </button>
    <nav class="topnav__sections" id="sectionNav" aria-label="Sections">
      <button class="navbtn is-active" type="button" data-section-nav="scores">Scores</button>
      <button class="navbtn" type="button" data-section-nav="fantasy">Fantasy</button>
      <button class="navbtn" type="button" data-section-nav="play">Paper Run</button>
    </nav>
    <span class="topnav__spacer"></span>
    <span class="updated">Updated <time id="updated">…</time></span>
    <button class="navbtn navbtn--auth" id="accountBtn" type="button" data-section-nav="you">Sign in</button>
  </header>

  <div class="ticker" id="ticker" aria-label="Live and recent scores"></div>
  <main class="main"><div id="layout" class="layout" aria-live="polite"></div></main>
  <footer class="footer" id="footer"></footer>

  <nav class="bnav" id="bottomNav" aria-label="Sections">
    <button class="bnav__btn is-active" type="button" data-section-nav="scores">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 12h-4l-3 9L9 3l-3 9H2"></path></svg>
      Scores
    </button>
    <button class="bnav__btn" type="button" data-section-nav="fantasy">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"></path><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"></path><path d="M4 22h16"></path><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"></path><path d="M14 14.66V17c0 .55-.47.98-.97 1.21C16.15 18.75 17 20.24 17 22"></path><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"></path></svg>
      Fantasy
    </button>
    <button class="bnav__btn" type="button" data-section-nav="play">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2Zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2"></path><path d="M18 14h-8"></path><path d="M15 18h-5"></path><path d="M10 6h8v4h-8V6Z"></path></svg>
      Play
    </button>
    <button class="bnav__btn" type="button" data-section-nav="you">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>
      You
    </button>
  </nav>
</div>

<div class="dz" id="matchDrawer" hidden>
  <div class="dz__scrim" data-md-close></div>
  <div class="dz__panel" role="dialog" aria-modal="true" aria-label="Match detail"></div>
</div>

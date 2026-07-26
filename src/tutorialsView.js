// HTML-string renderers for the Learn section (Phase 4.4): an index card per
// tutorial (src/tutorials.js's TUTORIALS) and a single-tutorial reader that
// walks its `sections` array, drawing each tagged block. Every renderer here
// is pure (no DOM, no fetch); app.js owns the one piece of state a tutorial
// needs (state.learn.resolverMode, mirroring every other in-panel control -
// see CLAUDE.md's "Adding a tab or panel control") and passes it in as plain
// data via the `state` param on renderTutorial.
//
// Escaping every string through esc() even though today's content is static
// authored copy: it is content data like any other, and the next tutorial's
// author may paste something with an ampersand or a quote in it.

function esc(value) {
  return String(value ?? "").replace(/[&<>"]/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
  })[char]);
}

// -- Index ---------------------------------------------------------------------

function renderTutorialCard(tutorial) {
  return `<button class="card tutorial-card" type="button" data-tutorial-open="${esc(tutorial.slug)}">
      <div class="tutorial-card__head">
        <h3 class="card__title">${esc(tutorial.title)}</h3>
        <span class="chip tutorial-card__minutes">${esc(tutorial.minutes)} min</span>
      </div>
      <p class="note">${esc(tutorial.summary)}</p>
    </button>`;
}

// A second (or third) tutorial needs no change here: this just maps whatever
// is in TUTORIALS, so adding an entry to that array is the entire job.
export function renderTutorialIndex(tutorials) {
  const cards = (tutorials ?? []).map(renderTutorialCard).join("");
  return `
    <div class="tutorial-index">
      <div class="hero__head">
        <div class="hero__lead">
          <p class="hero__eyebrow">Learn</p>
          <h1 class="hero__title">Tutorials</h1>
        </div>
      </div>
      <p class="note tutorial-index__lede">Short walkthroughs of how Kickoff Draft features actually work.</p>
      <div class="tutorial-grid">${cards || `<p class="note">No tutorials yet.</p>`}</div>
    </div>`;
}

// -- Section blocks --------------------------------------------------------------

function renderHeading(heading) {
  return heading ? `<h2 class="tutorial-heading">${esc(heading)}</h2>` : "";
}

function renderProseSection(section) {
  const paragraphs = (section.body ?? []).map((p) => `<p class="tutorial-p">${esc(p)}</p>`).join("");
  return `<section class="tutorial-section">${renderHeading(section.heading)}${paragraphs}</section>`;
}

function renderCalloutSection(section) {
  const paragraphs = (section.body ?? []).map((p) => `<p>${esc(p)}</p>`).join("");
  return `<div class="tutorial-callout">${paragraphs}</div>`;
}

const STATE_TONES = new Set(["neutral", "wire", "free"]);

function renderStatesSection(section) {
  const items = (section.items ?? [])
    .map((item) => {
      const tone = STATE_TONES.has(item.tone) ? item.tone : "neutral";
      return `<div class="tutorial-state tutorial-state--${tone}">
          <h3 class="tutorial-state__title">${esc(item.title)}</h3>
          <p class="tutorial-state__body">${esc(item.body)}</p>
        </div>`;
    })
    .join("");
  return `<section class="tutorial-section">${renderHeading(section.heading)}<div class="tutorial-states">${items}</div></section>`;
}

function renderListSection(section) {
  const tag = section.ordered ? "ol" : "ul";
  const items = (section.items ?? []).map((item) => `<li>${esc(item)}</li>`).join("");
  return `<section class="tutorial-section">${renderHeading(section.heading)}<${tag} class="tutorial-list">${items}</${tag}></section>`;
}

function renderTableSection(section) {
  const head = `<tr>${(section.columns ?? []).map((col) => `<th>${esc(col)}</th>`).join("")}</tr>`;
  const rows = (section.rows ?? [])
    .map((row) => `<tr>${row.map((cell) => `<td>${esc(cell)}</td>`).join("")}</tr>`)
    .join("");
  return `<section class="tutorial-section">
      ${renderHeading(section.heading)}
      <div class="card tutorial-table-card">
        ${section.caption ? `<p class="card__title">${esc(section.caption)}</p>` : ""}
        <div class="tutorial-table-scroll">
          <table class="tutorial-table">
            <thead>${head}</thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
      ${section.note ? `<p class="note--dim tutorial-table-note">${esc(section.note)}</p>` : ""}
    </section>`;
}

function renderTimelineSection(section) {
  const steps = (section.steps ?? [])
    .map(
      (step) => `<li class="tutorial-timeline__step ${step.emphasis ? "is-emphasis" : ""}">
          <span class="tutorial-timeline__when">${esc(step.when)}</span>
          <p class="tutorial-timeline__body">${esc(step.body)}</p>
        </li>`,
    )
    .join("");
  return `<section class="tutorial-section">${renderHeading(section.heading)}<ol class="tutorial-timeline">${steps}</ol></section>`;
}

// -- The interactive resolver block ----------------------------------------------
//
// Re-resolves the SAME three claims three ways: the mode buttons are plain
// data-tagged buttons (data-tutorial-resolver-mode), wired via app.js's usual
// click-delegation pattern in wireLayoutControls, with the active mode read
// straight off `state.resolverMode` (state.learn.resolverMode in app.js) -
// no inline script, no onclick, exactly like every other in-panel control.
const RESOLVER_MODE_ORDER = ["faab", "rolling", "reverse_standings"];

function renderResolverModeButtons(modes, activeMode) {
  return RESOLVER_MODE_ORDER.filter((key) => modes[key])
    .map((key) => {
      const isActive = key === activeMode;
      return `<button class="seg tutorial-resolver__modebtn ${isActive ? "is-active" : ""}" type="button" data-tutorial-resolver-mode="${esc(key)}" aria-pressed="${isActive}">${esc(modes[key].label)}</button>`;
    })
    .join("");
}

function renderResolverClaimsTable(target, claims) {
  const rows = (claims ?? [])
    .map(
      (claim) => `<tr>
          <td><strong>${esc(claim.manager)}</strong></td>
          <td class="note--dim">${esc(claim.drops)}</td>
          <td class="tutorial-table--num">${esc(claim.bid)}</td>
          <td class="tutorial-table--num">${esc(claim.budget)}</td>
          <td class="tutorial-table--num">${esc(claim.queue)}</td>
          <td class="tutorial-table--num">${esc(claim.table)}</td>
        </tr>`,
    )
    .join("");
  return `<div class="tutorial-table-scroll">
      <table class="tutorial-table">
        <caption>Pending claims for ${esc(target)}</caption>
        <thead><tr><th>Manager</th><th>Drops</th><th>Bid</th><th>Budget</th><th>Queue</th><th>Table</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function renderResolverOutcomes(outcomes) {
  const rows = (outcomes ?? [])
    .map((outcome) => {
      const won = outcome.result === "won";
      return `<tr>
          <td><strong>${esc(outcome.manager)}</strong></td>
          <td><span class="tutorial-pill ${won ? "tutorial-pill--won" : "tutorial-pill--rejected"}">${won ? "Won" : "Rejected"}</span></td>
          <td class="note--dim">${esc(outcome.reason)}</td>
        </tr>`;
    })
    .join("");
  return `<div class="tutorial-table-scroll">
      <table class="tutorial-table">
        <thead><tr><th>Manager</th><th>Outcome</th><th>Reason shown in the app</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function renderResolverSection(section, state) {
  const modes = section.modes ?? {};
  const requested = state?.resolverMode;
  const activeMode = requested && modes[requested] ? requested : RESOLVER_MODE_ORDER.find((key) => modes[key]);
  const mode = modes[activeMode];
  if (!mode) return "";

  return `<section class="tutorial-section">
      ${renderHeading(section.heading)}
      ${section.intro ? `<p class="tutorial-p">${esc(section.intro)}</p>` : ""}
      <div class="card tutorial-resolver">
        ${renderResolverClaimsTable(section.target, section.claims)}
        <div class="segrow tutorial-resolver__modes" role="group" aria-label="Waiver mode">${renderResolverModeButtons(modes, activeMode)}</div>
        <p class="note tutorial-resolver__desc">${esc(mode.description)}</p>
        <div class="tutorial-resolver__winner">
          <span class="tutorial-resolver__winnertag">Wins ${esc(section.target)}</span>
          <span class="tutorial-resolver__winnername">${esc(mode.winner)}</span>
        </div>
        ${renderResolverOutcomes(mode.outcomes)}
        <dl class="tutorial-resolver__aftermath">
          <dt>What changes afterwards</dt>
          <dd>${esc(mode.aftermath)}</dd>
        </dl>
      </div>
    </section>`;
}

// -- Top-level tutorial reader -----------------------------------------------------

const SECTION_RENDERERS = {
  prose: renderProseSection,
  callout: renderCalloutSection,
  states: renderStatesSection,
  list: renderListSection,
  table: renderTableSection,
  timeline: renderTimelineSection,
  resolver: renderResolverSection,
};

// Renders one tutorial end to end: back link, header, then every section in
// order. `state` is the small piece of working state a tutorial's interactive
// blocks need (today just { resolverMode }); a tutorial with no interactive
// block simply never reads it. A section whose `type` this renderer does not
// recognise is skipped rather than throwing, so a typo in a future tutorial's
// content degrades quietly instead of blanking the whole page.
export function renderTutorial(tutorial, state = {}) {
  const sections = (tutorial.sections ?? [])
    .map((section) => (SECTION_RENDERERS[section.type] ? SECTION_RENDERERS[section.type](section, state) : ""))
    .join("");
  return `
    <div class="tutorial">
      <button class="seg tutorial-back" type="button" data-tutorial-back>← Learn</button>
      <div class="hero__head">
        <div class="hero__lead">
          <p class="hero__eyebrow">Learn · ${esc(tutorial.minutes)} min</p>
          <h1 class="hero__title">${esc(tutorial.title)}</h1>
        </div>
      </div>
      <p class="note tutorial-index__lede">${esc(tutorial.summary)}</p>
      ${sections}
    </div>`;
}

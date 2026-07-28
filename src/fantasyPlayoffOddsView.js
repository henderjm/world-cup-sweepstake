// HTML-string renderer for src/fantasyPlayoffOdds.js's simulatePlayoffOdds()
// output. Mounted under the Standings sub-tab (see renderFantasyStandingsBody
// in src/app.js), which is where a manager is already asking the question
// this answers.
//
// Follows the same HTML-string + delegated-event-listener convention as
// fantasyView.js/fantasyChatView.js: pure string in, string out, no DOM APIs.

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

// Whole-number percent for display; the underlying probability stays a 0-1
// fraction everywhere else (tests, sum-to-playoffSpots checks) so this
// formatting choice never leaks into the numbers the module itself reasons
// about.
function pct(probability) {
  return `${Math.round((probability ?? 0) * 100)}%`;
}

const STATUS_LABEL = {
  clinched: "Clinched",
  eliminated: "Eliminated",
  contention: "In contention",
};

// One row: name/status on top, a bar plus its own percentage below. A single
// stacked column rather than the Standings tab's wide P/W/D/L/PF/PA grid,
// because that grid needs its own horizontal scroll container even on
// desktop (see .fantasy-standings__table's min-width) - a playoff-odds row
// only ever needs one number, so it can stay inside 375px with no scroll at
// all, which is the one hard requirement this renderer has to meet.
function renderRow(row, myUserId) {
  const isMe = myUserId != null && row.userId === myUserId;
  const status = row.status ?? "contention";
  const statusClass = `fantasy-playoff-row__status fantasy-playoff-row__status--${status}`;
  const barClass = `fantasy-playoff-row__bar-fill fantasy-playoff-row__bar-fill--${status}`;
  const width = Math.max(0, Math.min(100, Math.round((row.probability ?? 0) * 100)));

  return `
    <div class="fantasy-playoff-row fantasy-playoff-row--${status} ${isMe ? "is-me" : ""}">
      <div class="fantasy-playoff-row__head">
        <span class="fantasy-playoff-row__name">${esc(row.name)}${isMe ? ` <span class="note--dim">(you)</span>` : ""}</span>
        <span class="${statusClass}">${STATUS_LABEL[status] ?? STATUS_LABEL.contention}</span>
      </div>
      <div class="fantasy-playoff-row__barwrap">
        <div class="fantasy-playoff-row__bar" role="progressbar" aria-valuenow="${width}" aria-valuemin="0" aria-valuemax="100">
          <span class="${barClass}" style="width: ${width}%"></span>
        </div>
        <span class="fantasy-playoff-row__pct">${pct(row.probability)}</span>
      </div>
    </div>`;
}

// `result` is simulatePlayoffOdds()'s own return shape. `myUserId` highlights
// the viewer's own row, matching renderFantasyStandingsPanel's convention.
export function renderFantasyPlayoffOddsPanel(result, { myUserId } = {}) {
  if (!result || !result.standings) {
    return `<p class="note">Loading playoff odds…</p>`;
  }

  const { standings, playoffSpots, tooSmallForPlayoffs } = result;

  if (!standings.length) {
    return `
      <section class="card fantasy-playoff-odds-empty">
        <h3 class="card__title">Playoff odds</h3>
        <p class="note">No managers to project yet.</p>
      </section>`;
  }

  // Before a single fixture has been decided, every manager's odds come from
  // the schedule and their squad alone, and the spread between them is
  // noise-sized. Saying so is the whole difference between a projection and
  // an implied precision the numbers do not have; a bare "31% / 29% / 28%"
  // reads as a ranking nobody has earned yet.
  const nothingDecided = standings.every((row) => (row.played ?? 0) === 0);
  const note = tooSmallForPlayoffs
    ? `<p class="note">Every manager in this league already qualifies for the ${esc(playoffSpots)}-spot playoff, so there is nothing left to project.</p>`
    : nothingDecided
      ? `<p class="note">Top ${esc(playoffSpots)} make the playoffs. No gameweek has been decided yet, so these are squad strength and the schedule only: expect them to sit close together and to say very little until real results land.</p>`
      : `<p class="note">Top ${esc(playoffSpots)} make the playoffs. Odds are a Monte Carlo projection over the remaining schedule, not a guarantee.</p>`;

  const rows = standings.map((row) => renderRow(row, myUserId)).join("");

  return `
    <section class="card fantasy-playoff-odds">
      <div class="fantasy-playoff-odds__head">
        <h3 class="card__title">Playoff odds</h3>
      </div>
      ${note}
      <div class="fantasy-playoff-odds__rows">${rows}</div>
    </section>`;
}

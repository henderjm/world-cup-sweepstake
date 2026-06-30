import { resultEmojiLine, shareText, sortLeaderboard } from "./shootoutModel.js";

function esc(value) {
  return String(value ?? "").replace(/[&<>"]/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
  })[char]);
}

export function renderShootoutPanel(dayState) {
  const challenge = dayState.challenge;
  const result = dayState.result;
  const locked = Boolean(result);
  const leaderboard = renderShootoutLeaderboard(dayState.leaderboard ?? []);
  const share = result
    ? shareText({
        challenge,
        result,
        url: `${window.location.origin}${window.location.pathname}#shootout`,
      })
    : "";

  return `
    <div class="shootout" data-shootout-root>
      <div class="shootout__head">
        <div>
          <p class="hero__eyebrow">Daily arcade</p>
          <h2>Penalty Shootout #${challenge.challengeNumber}</h2>
          <p class="shootout__lede">Drag back from the ball and release to shoot. Beat the keeper across five kicks. A perfect five unlocks sudden death.</p>
        </div>
        <div class="shootout-howto">
          <span>How it scores</span>
          <ul>
            <li><strong>Corners</strong> beat the keeper on pace.</li>
            <li><strong>Top bins</strong> are above the keeper: a style point each.</li>
            <li><strong>5/5</strong> starts the sudden-death chase.</li>
          </ul>
        </div>
      </div>

      <div class="shootout__grid">
        <section class="shootout-game ${locked ? "is-locked" : ""}" aria-label="Daily penalty shootout game">
          ${renderShootoutHud(result)}
          <div class="shootout-canvas-wrap">
            <canvas class="shootout-canvas" width="960" height="620" data-shootout-canvas></canvas>
            <div class="shootout-status" data-shootout-status>
              ${
                locked
                  ? `<strong>Run locked</strong><span>${resultEmojiLine(result)} ${result.goals}/5</span>`
                  : `<strong>Drag back from the ball, then release</strong><span>Aim for the corners</span>`
              }
            </div>
          </div>
          ${locked ? renderResultCard(challenge, result, share, dayState) : ""}
        </section>

        <aside class="shootout-board">
          <div class="panel__head">
            <h3>Today's table</h3>
            <span>${dayState.serverAvailable ? "Live group board" : "Local board"}</span>
          </div>
          ${leaderboard}
          ${
            dayState.error
              ? `<p class="panel__note">${esc(dayState.error)}</p>`
              : `<p class="panel__note">Ranked by goals, then sudden death, then top-bin style, then earliest finish.</p>`
          }
        </aside>
      </div>
    </div>
  `;
}

function renderShootoutHud(result) {
  const sd = result?.goals === 5 ? result.sdStreak : 0;
  return `
    <div class="shootout-hud">
      <div>
        <span class="shootout-hud__label">Score</span>
        <strong data-shootout-score>${result ? `${result.goals}/5` : "0/5"}</strong>
      </div>
      <ol class="shootout-shots" data-shootout-shots aria-label="Shot results">
        ${renderShotStrip(result?.shots ?? [])}
      </ol>
      <div>
        <span class="shootout-hud__label">Sudden death</span>
        <strong data-shootout-sd>${sd ? `${sd} 🔥` : "—"}</strong>
      </div>
    </div>`;
}

export function updateShootoutHud(root, gameState) {
  const shots = root.querySelector("[data-shootout-shots]");
  const score = root.querySelector("[data-shootout-score]");
  const sd = root.querySelector("[data-shootout-sd]");
  const status = root.querySelector("[data-shootout-status]");
  if (shots) shots.innerHTML = renderShotStrip(gameState.shots);
  if (score) score.textContent = `${gameState.goals}/5`;
  if (sd) sd.textContent = gameState.sdActive ? `${gameState.sdStreak} 🔥` : "—";
  if (status) {
    status.innerHTML = `<strong>${esc(gameState.message)}</strong><span>${esc(gameState.detail ?? "")}</span>`;
  }
}

export function renderShootoutLeaderboard(rows) {
  const ranked = sortLeaderboard(rows);
  if (!ranked.length) {
    return `<p class="empty">No one has posted a score yet. Be first into the mixer.</p>`;
  }
  return `
    <div class="table-wrap">
      <table class="shootout-table">
        <thead><tr><th></th><th>Player</th><th>Score</th><th>Extra</th></tr></thead>
        <tbody>
          ${ranked
            .map((row, index) => {
              const extra = row.goals === 5 && row.sdStreak ? `${row.sdStreak} 🔥` : `${row.style} ⭐`;
              return `<tr>
                <td>${index + 1}</td>
                <td><strong>${esc(row.name)}</strong><span>${resultEmojiLine(row)}${row.team ? ` · ${esc(row.team)}` : ""}</span></td>
                <td>${row.goals}/5</td>
                <td>${extra}</td>
              </tr>`;
            })
            .join("")}
        </tbody>
      </table>
    </div>`;
}

function renderResultCard(challenge, result, share, dayState) {
  const headline = result.goals === 5
    ? `Perfect five, then ${result.sdStreak} in sudden death`
    : `${result.goals}/5 scored · ${result.style} top bins`;
  const savedNote = dayState.localOnly
    ? `<small>Saved on this device. We'll post it to the board when the server answers.</small>`
    : dayState.serverAvailable
      ? `<small>Posted to today's board.</small>`
      : "";
  return `
    <div class="shootout-result">
      <div class="shootout-result__score">
        <span>Final</span>
        <strong>${result.goals}/5${result.goals === 5 ? ` · ${result.sdStreak} 🔥` : ""}</strong>
        <p>${resultEmojiLine(result)}</p>
        <small>${esc(headline)}</small>
      </div>
      <div class="shootout-result__save">
        <label for="shootout-name">Your name on the board</label>
        <div class="shootout-name-row">
          <input id="shootout-name" type="text" maxlength="24" placeholder="Your name" value="${esc(result.name && result.name !== "Someone" ? result.name : "")}" data-shootout-name />
          <button class="btn" type="button" data-shootout-save>Save</button>
        </div>
        ${savedNote}
      </div>
      <textarea class="shootout-share" readonly data-shootout-share>${esc(share)}</textarea>
      <button class="btn btn--primary" type="button" data-shootout-share-button>Share result</button>
    </div>`;
}

function renderShotStrip(shots) {
  return Array.from({ length: 5 }, (_, index) => {
    const shot = shots[index];
    const className = shot === "G" ? "is-goal" : shot === "M" ? "is-miss" : "";
    return `<li class="${className}">${shot === "G" ? "⚽" : shot === "M" ? "×" : index + 1}</li>`;
  }).join("");
}

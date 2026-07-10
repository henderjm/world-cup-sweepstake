import { resultBadge, shareText, sortLeaderboard } from "./paperRunModel.js";

function esc(value) {
  return String(value ?? "").replace(/[&<>"]/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
  })[char]);
}

export function renderPaperRunPanel(dayState) {
  const challenge = dayState.challenge;
  const result = dayState.result;
  const locked = Boolean(result);
  const subs = challenge.course.subscriberCount;
  const leaderboard = renderPaperRunLeaderboard(dayState.leaderboard ?? []);
  const share = result
    ? shareText({
        challenge,
        result,
        url: `${window.location.origin}${window.location.pathname}#paperrun`,
      })
    : "";

  return `
    <div class="paperrun" data-run-root>
      <div class="paperrun__head">
        <div>
          <p class="hero__eyebrow">Daily arcade</p>
          <h2>Matchday Paper Run #${challenge.challengeNumber}</h2>
          <p class="paperrun__lede">Cycle to the stadium delivering match programmes. Steer across the road and lob a programme to every house flying bunting, dodge the street, and don't crash before the final whistle.</p>
        </div>
        <div class="paperrun-howto">
          <span>How it scores</span>
          <ul>
            <li><strong>Deliver</strong> to houses with bunting: +100.</li>
            <li><strong>Perfect drop</strong> (dead-centre timing): +50.</li>
            <li><strong>Smash</strong> a plain window: +60 cheek.</li>
            <li><strong>📰 bundles</strong> refill your throwing arm.</li>
          </ul>
        </div>
      </div>

      <div class="paperrun__grid">
        <section class="paperrun-game ${locked ? "is-locked" : ""}" aria-label="Daily matchday paper run game">
          ${renderPaperRunHud(result, subs)}
          <div class="paperrun-canvas-wrap">
            <canvas class="paperrun-canvas" width="960" height="620" data-run-canvas></canvas>
            <div class="paperrun-status" data-run-status>
              ${
                locked
                  ? `<strong>Run locked</strong><span>${result.score.toLocaleString()} pts · ${resultBadge(result)}</span>`
                  : `<strong>Press Start to set off</strong><span>◀ ▶ steer · Throw / Space to deliver</span>`
              }
            </div>
            ${locked ? "" : `<button class="btn btn--primary paperrun-start" type="button" data-run-start>Start run</button>`}
          </div>
          ${renderControls(locked)}
          ${locked ? renderResultCard(challenge, result, share, dayState) : ""}
        </section>

        <aside class="paperrun-board">
          <div class="panel__head">
            <h3>Today's table</h3>
            <span>${dayState.serverAvailable ? "Live group board" : "Local board"}</span>
          </div>
          ${leaderboard}
          ${
            dayState.error
              ? `<p class="panel__note">${esc(dayState.error)}</p>`
              : `<p class="panel__note">Ranked by score, then deliveries, then perfect drops, then who reached the stadium.</p>`
          }
        </aside>
      </div>
    </div>
  `;
}

function renderControls(locked) {
  const disabled = locked ? "disabled" : "";
  return `
    <div class="paperrun-controls" role="group" aria-label="Game controls">
      <button class="paperrun-ctl" type="button" data-run-left ${disabled} aria-label="Steer left">◀</button>
      <button class="paperrun-ctl paperrun-ctl--throw" type="button" data-run-throw ${disabled} aria-label="Throw programme">Throw</button>
      <button class="paperrun-ctl" type="button" data-run-right ${disabled} aria-label="Steer right">▶</button>
    </div>`;
}

function renderPaperRunHud(result, subs) {
  return `
    <div class="paperrun-hud">
      <div>
        <span class="paperrun-hud__label">Score</span>
        <strong data-run-score>${result ? result.score.toLocaleString() : "0"}</strong>
      </div>
      <div>
        <span class="paperrun-hud__label">Delivered</span>
        <strong data-run-deliveries>${result ? `${result.deliveries}/${subs}` : `0/${subs}`}</strong>
      </div>
      <div>
        <span class="paperrun-hud__label">Programmes</span>
        <strong data-run-ammo>${result ? "—" : "12"}</strong>
      </div>
      <div>
        <span class="paperrun-hud__label">To stadium</span>
        <strong data-run-distance>${result ? `${Math.round(result.distancePct)}%` : "0%"}</strong>
      </div>
    </div>`;
}

export function updatePaperRunHud(root, snap) {
  const score = root.querySelector("[data-run-score]");
  const deliveries = root.querySelector("[data-run-deliveries]");
  const ammo = root.querySelector("[data-run-ammo]");
  const distance = root.querySelector("[data-run-distance]");
  const status = root.querySelector("[data-run-status]");
  const startBtn = root.querySelector("[data-run-start]");
  if (score) score.textContent = snap.score.toLocaleString();
  if (deliveries) deliveries.textContent = `${snap.deliveries}/${snap.subscriberCount}`;
  if (ammo) ammo.textContent = String(snap.ammo);
  if (distance) distance.textContent = `${Math.round(snap.distancePct)}%`;
  if (startBtn && snap.phase !== "ready") startBtn.remove();
  if (status && snap.phase !== "ready") {
    status.innerHTML = `<strong>${esc(snap.message || "Deliver the street")}</strong><span>${esc(snap.detail ?? "")}</span>`;
  }
}

export function renderPaperRunLeaderboard(rows) {
  const ranked = sortLeaderboard(rows);
  if (!ranked.length) {
    return `<p class="empty">No one has finished a run yet. Be first onto the board.</p>`;
  }
  return `
    <div class="table-wrap">
      <table class="paperrun-table">
        <thead><tr><th></th><th>Player</th><th>Score</th><th>Made it</th></tr></thead>
        <tbody>
          ${ranked
            .map((row, index) => {
              const badge = row.finished ? "🏟️" : `${Math.round(row.distancePct ?? 0)}%`;
              const extra = `${row.deliveries ?? 0} 📰${row.perfects ? ` · ${row.perfects}⭐` : ""}`;
              return `<tr>
                <td>${index + 1}</td>
                <td><strong>${esc(row.name)}</strong><span>${extra}${row.team ? ` · ${esc(row.team)}` : ""}</span></td>
                <td>${(row.score ?? 0).toLocaleString()}</td>
                <td>${badge}</td>
              </tr>`;
            })
            .join("")}
        </tbody>
      </table>
    </div>`;
}

function renderResultCard(challenge, result, share, dayState) {
  const subs = challenge.course.subscriberCount;
  const headline = result.finished
    ? `Reached the stadium · ${result.deliveries}/${subs} delivered`
    : `Crashed at ${Math.round(result.distancePct)}% · ${result.deliveries}/${subs} delivered`;
  const savedNote = dayState.localOnly
    ? `<small>Saved on this device. We'll post it to the board when the server answers.</small>`
    : dayState.serverAvailable
      ? `<small>Posted to today's board.</small>`
      : "";
  return `
    <div class="paperrun-result">
      <div class="paperrun-result__score">
        <span>Final</span>
        <strong>${result.score.toLocaleString()} pts</strong>
        <p>📰 ${result.deliveries}/${subs} · 💥 ${result.smashes}${result.perfects ? ` · ${result.perfects}⭐` : ""}</p>
        <small>${esc(headline)}</small>
      </div>
      <div class="paperrun-result__save">
        <label for="paperrun-name">Your name on the board</label>
        <div class="paperrun-name-row">
          <input id="paperrun-name" type="text" maxlength="24" placeholder="Your name" value="${esc(result.name && result.name !== "Someone" ? result.name : "")}" data-run-name />
          <button class="btn" type="button" data-run-save>Save</button>
        </div>
        ${savedNote}
      </div>
      <textarea class="paperrun-share" readonly data-run-share>${esc(share)}</textarea>
      <button class="btn btn--primary" type="button" data-run-share-button>Share result</button>
    </div>`;
}

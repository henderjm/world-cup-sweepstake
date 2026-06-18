import { flagFor } from "./flags.js";
import { ENTRANTS, ownerOf } from "./data.js";
import { isFinished, isLive, money, percent, scorePart, statusLabel } from "./format.js";

const reducedMotion =
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

let h2hModel = null;

export function setH2hModel(model) {
  h2hModel = model;
}

// -- Confetti ----------------------------------------------------------------

const COLORS = ["#f5c84b", "#36d399", "#4ea8ff", "#ff5e7a", "#c084fc", "#f6f2df"];

export function confettiBurst(canvas, count = 140) {
  if (!canvas || reducedMotion) return;
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  ctx.scale(dpr, dpr);

  const particles = Array.from({ length: count }, () => ({
    x: window.innerWidth / 2 + (Math.random() - 0.5) * window.innerWidth * 0.6,
    y: -20 - Math.random() * window.innerHeight * 0.3,
    vx: (Math.random() - 0.5) * 6,
    vy: 3 + Math.random() * 5,
    size: 5 + Math.random() * 7,
    rot: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.3,
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
  }));

  let frame = 0;
  const tick = () => {
    frame += 1;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    particles.forEach((p) => {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.08;
      p.rot += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
      ctx.restore();
    });
    if (frame < 200) {
      requestAnimationFrame(tick);
    } else {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  };
  requestAnimationFrame(tick);
}

// Returns a banner string if there is something to celebrate, else null.
export function celebrationBanner(model) {
  if (model.prizes.champion.owner && model.prizes.champion.owner !== "TBC") {
    return `🏆 ${model.prizes.champion.owner} owns the champions, ${model.prizes.champion.team}. That is the ${money(model.payouts.first)}.`;
  }
  const winningLive = model.matches.find(
    (match) =>
      isLive(match.status) &&
      Number.isFinite(match.score?.home) &&
      Number.isFinite(match.score?.away) &&
      match.score.home !== match.score.away,
  );
  if (winningLive) {
    const leading = winningLive.score.home > winningLive.score.away ? winningLive.homeTeam : winningLive.awayTeam;
    const owner = ownerOf(leading);
    if (owner) {
      return `${flagFor(leading)} ${owner}'s ${leading} are winning live, ${scorePart(winningLive.score, "home")}-${scorePart(winningLive.score, "away")} (${statusLabel(winningLive)}).`;
    }
  }
  return null;
}

export function shouldCelebrate(model) {
  return model.prizes.champion.owner && model.prizes.champion.owner !== "TBC";
}

// -- Head-to-head ------------------------------------------------------------

function remainingFixtures(model, ownerName) {
  return model.matches.filter(
    (match) =>
      !isFinished(match.status) &&
      [match.homeTeam, match.awayTeam].some((team) => ownerOf(team) === ownerName),
  ).length;
}

function entrantColumn(model, name) {
  const entrant = model.leaderboard.find((row) => row.name === name);
  const forecast = model.forecast.entrants.get(name);
  if (!entrant || !forecast) return "<div class='h2h__col'></div>";

  const teams = entrant.teams
    .map((team) => {
      const odds = model.forecast.teamTitleOdds.get(team.name) ?? 0;
      return `<li>${flagFor(team.name)} <span>${team.name}</span> <b>${percent(odds)}</b></li>`;
    })
    .join("");

  return `<div class="h2h__col">
      <h4>${name}</h4>
      <ul class="h2h__teams">${teams}</ul>
      <dl class="h2h__stats">
        <div><dt>Points now</dt><dd>${entrant.score}</dd></div>
        <div><dt>Projected</dt><dd>${forecast.projectedPoints}</dd></div>
        <div><dt>Win odds</dt><dd>${percent(forecast.winPct)}</dd></div>
        <div><dt>Spoon risk</dt><dd>${percent(forecast.spoonPct)}</dd></div>
        <div><dt>Games left</dt><dd>${remainingFixtures(model, name)}</dd></div>
      </dl>
    </div>`;
}

export function setupHeadToHead(model, { trigger, modal }) {
  if (!trigger || !modal) return;
  h2hModel = model;

  const names = ENTRANTS.map((entrant) => entrant.name);
  const options = (selected) =>
    names.map((name) => `<option value="${name}" ${name === selected ? "selected" : ""}>${name}</option>`).join("");

  const top = [...h2hModel.forecast.entrants.values()].sort((a, b) => b.winPct - a.winPct);
  let left = top[0]?.name ?? names[0];
  let right = top[1]?.name ?? names[1];

  const render = () => {
    modal.innerHTML = `
      <div class="h2h" role="dialog" aria-modal="true" aria-label="Owner head to head">
        <div class="h2h__bar">
          <h3>Head to head</h3>
          <button class="h2h__close" data-h2h-close aria-label="Close">✕</button>
        </div>
        <div class="h2h__picks">
          <select data-h2h="left">${options(left)}</select>
          <span class="h2h__vs">vs</span>
          <select data-h2h="right">${options(right)}</select>
        </div>
        <div class="h2h__grid">
          ${entrantColumn(h2hModel, left)}
          ${entrantColumn(h2hModel, right)}
        </div>
      </div>`;
  };

  const open = () => {
    modal.hidden = false;
    render();
  };
  const close = () => {
    modal.hidden = true;
    modal.innerHTML = "";
  };

  trigger.addEventListener("click", open);
  modal.addEventListener("click", (event) => {
    if (event.target === modal || event.target.closest("[data-h2h-close]")) close();
  });
  modal.addEventListener("change", (event) => {
    const side = event.target.getAttribute("data-h2h");
    if (side === "left") left = event.target.value;
    if (side === "right") right = event.target.value;
    render();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !modal.hidden) close();
  });
}

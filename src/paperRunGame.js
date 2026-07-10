import { ARENA, ROAD, LANE, SCORING, seededRandom } from "./paperRunModel.js";

// The daily Matchday Paper Run: a scrolling, football-flavoured Paperboy. The world
// scrolls toward the rider; steer across the road, and lob programmes to the fans
// flying bunting (subscribers) while dodging hazards. Outcomes are a pure function of
// player input and the seeded course; performance.now() only drives animation.

const W = ARENA.width;
const H = ARENA.height;
const CENTER = (ROAD.left + ROAD.right) / 2;
const BIKE_Y = 500; // rider's fixed screen row; a house at course-y == distance sits here
const BIKE_MIN_X = ROAD.left + 32;
const BIKE_MAX_X = ROAD.right - 32;
const PX_PER_UNIT = 6; // course units -> screen pixels
const STEER_SPEED = 470; // px per second of lateral movement

const DELIVER_TOL = 7; // a house within this many units of the rider can be served
const PERFECT_TOL = 2.5; // dead-centre timing -> style bonus
const HAZARD_TOL_Y = 4.2; // course-unit half-height for a crash
const HAZARD_TOL_X = 40; // px half-width for a crash
const BUNDLE_TOL_Y = 5;
const BUNDLE_TOL_X = 38;

const COLORS = {
  skyTop: "#0b1f2a",
  skyMid: "#123b34",
  road: "#2a2f37",
  roadEdge: "#f6f3e6",
  lane: "rgba(245,200,75,.8)",
  kerb: "#3b4450",
  lawn: "#1c5a3f",
  house: "#48586b",
  houseRoof: "#2f3a49",
  letterbox: "#f5c84b",
  bunting1: "#f5c84b",
  bunting2: "#34d39e",
  bunting3: "#ff6b6b",
  accent: "#f5c84b",
  good: "#34d39e",
  bad: "#ff6b6b",
  warn: "#ffb454",
  bike: "#34d39e",
  paper: "#fdfbf2",
};

const HAZARD_GLYPH = { cone: "🚧", car: "🚗", dog: "🐕", fan: "🧍", bin: "🗑️" };

export function mountPaperRunGame(root, dayState, callbacks = {}) {
  const canvas = root.querySelector("[data-run-canvas]");
  if (!canvas) return { destroy() {} };
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    callbacks.onUnavailable?.();
    return { destroy() {} };
  }

  const challenge = dayState.challenge;
  const course = challenge.course;
  const reduceMotion = matchReduceMotion();
  const crowd = buildCrowd(challenge.seed);
  const locked = Boolean(dayState.result);

  const state = {
    phase: locked ? "done" : "ready",
    distance: locked ? (dayState.result.distancePct / 100) * course.length : 0,
    bikeX: CENTER,
    ammo: challenge.ammoStart,
    score: 0,
    deliveries: 0,
    perfects: 0,
    smashes: 0,
    finished: locked ? Boolean(dayState.result.finished) : false,
    crashKind: null,
    used: new Set(), // house ids already served or smashed
    collected: new Set(), // bundle indices picked up
    papers: [], // in-flight programmes (animation only)
    feedback: null, // { text, kind, until }
    key: { left: false, right: false },
    btn: { left: false, right: false },
    message: locked ? "Run locked" : "Press Start to set off",
    detail: locked ? "" : "Serve every house flying bunting. Dodge the street.",
    destroyed: false,
    lastT: null,
  };

  // ---- input ------------------------------------------------------------

  const leftBtn = root.querySelector("[data-run-left]");
  const rightBtn = root.querySelector("[data-run-right]");
  const throwBtn = root.querySelector("[data-run-throw]");
  const startBtn = root.querySelector("[data-run-start]");

  const holdStart = (which) => (event) => {
    event.preventDefault();
    if (which === "left") state.btn.left = true;
    else state.btn.right = true;
  };
  const holdStop = (which) => () => {
    if (which === "left") state.btn.left = false;
    else state.btn.right = false;
  };
  const onLeftDown = holdStart("left");
  const onLeftUp = holdStop("left");
  const onRightDown = holdStart("right");
  const onRightUp = holdStop("right");
  const onThrow = (event) => {
    event.preventDefault();
    if (state.phase === "ready") start();
    else throwPaper();
  };
  const onStart = (event) => {
    event.preventDefault();
    start();
  };

  leftBtn?.addEventListener("pointerdown", onLeftDown);
  leftBtn?.addEventListener("pointerup", onLeftUp);
  leftBtn?.addEventListener("pointerleave", onLeftUp);
  leftBtn?.addEventListener("pointercancel", onLeftUp);
  rightBtn?.addEventListener("pointerdown", onRightDown);
  rightBtn?.addEventListener("pointerup", onRightUp);
  rightBtn?.addEventListener("pointerleave", onRightUp);
  rightBtn?.addEventListener("pointercancel", onRightUp);
  throwBtn?.addEventListener("pointerdown", onThrow);
  startBtn?.addEventListener("click", onStart);

  const onKeyDown = (event) => {
    if (state.phase === "done") return;
    const tag = event.target?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    switch (event.key) {
      case "ArrowLeft":
      case "a":
      case "A":
        state.key.left = true;
        event.preventDefault();
        break;
      case "ArrowRight":
      case "d":
      case "D":
        state.key.right = true;
        event.preventDefault();
        break;
      case " ":
      case "ArrowUp":
      case "w":
      case "W":
        if (state.phase === "ready") start();
        else throwPaper();
        event.preventDefault();
        break;
      case "Enter":
        if (state.phase === "ready") start();
        event.preventDefault();
        break;
      default:
        break;
    }
  };
  const onKeyUp = (event) => {
    switch (event.key) {
      case "ArrowLeft":
      case "a":
      case "A":
        state.key.left = false;
        break;
      case "ArrowRight":
      case "d":
      case "D":
        state.key.right = false;
        break;
      default:
        break;
    }
  };
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  let frame = requestAnimationFrame(tick);

  // ---- game flow --------------------------------------------------------

  function start() {
    if (state.phase !== "ready") return;
    state.phase = "run";
    state.message = "";
    state.detail = "";
    callbacks.onStart?.();
    callbacks.onTick?.(snapshot());
  }

  function throwPaper() {
    if (state.phase !== "run") return;
    if (state.ammo <= 0) {
      feedback("Out of programmes!", "bad");
      return;
    }
    state.ammo -= 1;
    const side = state.bikeX <= CENTER ? "left" : "right";

    let best = null;
    let bestDist = Infinity;
    for (const house of course.houses) {
      if (house.side !== side || state.used.has(house.id)) continue;
      const d = Math.abs(house.y - state.distance);
      if (d <= DELIVER_TOL && d < bestDist) {
        best = house;
        bestDist = d;
      }
    }

    let targetX;
    let targetY;
    if (best) {
      state.used.add(best.id);
      targetX = side === "left" ? ROAD.left - 6 : ROAD.right + 6;
      targetY = screenYFor(best.y);
      if (best.subscriber) {
        state.deliveries += 1;
        let gain = SCORING.deliver;
        const perfect = bestDist <= PERFECT_TOL;
        if (perfect) {
          state.perfects += 1;
          gain += SCORING.perfect;
        }
        state.score += gain;
        feedback(perfect ? "PERFECT DROP!" : "DELIVERED", "good");
      } else {
        state.smashes += 1;
        state.score += SCORING.smash;
        feedback("SMASH! 💥", "warn");
      }
    } else {
      targetX = side === "left" ? ROAD.left - 24 : ROAD.right + 24;
      targetY = BIKE_Y - 60;
      feedback("Dropped it", "bad");
    }

    state.papers.push({
      fromX: state.bikeX,
      fromY: BIKE_Y - 14,
      toX: targetX,
      toY: targetY,
      start: now(),
      dur: reduceMotion ? 90 : 260,
    });
    callbacks.onTick?.(snapshot());
  }

  function finish() {
    state.phase = "done";
    state.finished = true;
    state.score += SCORING.finish;
    if (state.deliveries >= course.subscriberCount) state.score += SCORING.perfectRound;
    state.score += Math.floor(course.length * SCORING.distance);
    complete();
  }

  function crash(kind) {
    state.phase = "done";
    state.crashKind = kind;
    state.score += Math.floor(state.distance * SCORING.distance);
    if (!reduceMotion) state.feedback = { text: "CRASH!", kind: "bad", until: now() + 1200 };
    complete();
  }

  function complete() {
    callbacks.onTick?.(snapshot());
    callbacks.onComplete?.({
      score: state.score,
      deliveries: state.deliveries,
      perfects: state.perfects,
      smashes: state.smashes,
      finished: state.finished,
      distancePct: clamp((state.distance / course.length) * 100, 0, 100),
    });
  }

  function feedback(text, kind) {
    state.feedback = { text, kind, until: now() + (reduceMotion ? 300 : 850) };
  }

  // ---- loop -------------------------------------------------------------

  function tick(t) {
    if (state.destroyed) return;
    update(t);
    draw(t);
    frame = requestAnimationFrame(tick);
  }

  function update(t) {
    const dt = state.lastT == null ? 0 : Math.min((t - state.lastT) / 1000, 0.05);
    state.lastT = t;

    if (state.phase === "run") {
      const speed = lerp(challenge.speed.start, challenge.speed.max, state.distance / course.length);
      state.distance += speed * dt;

      const dir = (state.key.right || state.btn.right ? 1 : 0) - (state.key.left || state.btn.left ? 1 : 0);
      state.bikeX = clamp(state.bikeX + dir * STEER_SPEED * dt, BIKE_MIN_X, BIKE_MAX_X);

      for (let i = 0; i < course.bundles.length; i += 1) {
        if (state.collected.has(i)) continue;
        const bundle = course.bundles[i];
        if (Math.abs(bundle.y - state.distance) <= BUNDLE_TOL_Y && Math.abs(bundle.x - state.bikeX) <= BUNDLE_TOL_X) {
          state.collected.add(i);
          state.ammo += challenge.ammoPerBundle;
          state.score += SCORING.bundle;
          feedback(`+${challenge.ammoPerBundle} programmes`, "good");
          callbacks.onTick?.(snapshot());
        }
      }

      for (const hazard of course.hazards) {
        if (Math.abs(hazard.y - state.distance) <= HAZARD_TOL_Y && Math.abs(hazard.x - state.bikeX) <= HAZARD_TOL_X) {
          crash(hazard.kind);
          break;
        }
      }

      if (state.phase === "run" && state.distance >= course.length) finish();
    }

    // Papers fly regardless of phase so a final throw still animates.
    if (state.papers.length) {
      const cutoff = now();
      state.papers = state.papers.filter((paper) => cutoff - paper.start < paper.dur);
    }
  }

  function screenYFor(y) {
    return BIKE_Y - (y - state.distance) * PX_PER_UNIT;
  }

  // ---- draw -------------------------------------------------------------

  function draw(t) {
    ctx.save();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.scale(canvas.width / W, canvas.height / H);

    drawSky(ctx);
    drawCrowd(ctx, crowd);
    drawStadium(ctx);
    drawRoad(ctx);
    drawBundles(ctx);
    drawHouses(ctx, t);
    drawHazards(ctx);
    drawPapers(ctx, t);
    drawBike(ctx, t);
    drawProgress(ctx);
    if (state.phase === "ready") drawReadyVeil(ctx);
    if (state.feedback && t < state.feedback.until) drawFeedback(ctx, state.feedback, t);
    if (state.phase === "done") drawDoneVeil(ctx);
    ctx.restore();
  }

  function drawSky(c) {
    const sky = c.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, COLORS.skyTop);
    sky.addColorStop(0.22, COLORS.skyMid);
    sky.addColorStop(0.22, "#14322a");
    sky.addColorStop(1, "#0c2a20");
    c.fillStyle = sky;
    c.fillRect(0, 0, W, H);
  }

  function drawStadium(c) {
    // A distant stadium sits on the horizon and swells as the finish nears.
    const remaining = clamp(1 - state.distance / course.length, 0, 1);
    const scale = 1 + (1 - remaining) * 0.9;
    c.save();
    c.globalAlpha = 0.85;
    c.translate(W / 2, 128);
    c.scale(scale, scale);
    c.fillStyle = "rgba(10,20,26,.9)";
    roundRect(c, -120, -34, 240, 60, 26);
    c.fill();
    c.fillStyle = "rgba(255,250,225,.16)";
    for (let i = -3; i <= 3; i += 1) {
      c.beginPath();
      c.arc(i * 34, -30, 6, 0, Math.PI * 2);
      c.fill();
    }
    c.fillStyle = COLORS.accent;
    c.font = "800 15px system-ui, sans-serif";
    c.textAlign = "center";
    c.fillText("STADIUM", 0, 6);
    c.restore();
  }

  function drawCrowd(c, dots) {
    c.save();
    for (const dot of dots) {
      c.globalAlpha = dot.a;
      c.fillStyle = dot.col;
      c.beginPath();
      c.arc(dot.x, dot.y, dot.r, 0, Math.PI * 2);
      c.fill();
    }
    c.restore();
  }

  function drawRoad(c) {
    c.fillStyle = COLORS.lawn;
    c.fillRect(0, 150, W, H - 150);
    c.fillStyle = COLORS.kerb;
    c.fillRect(ROAD.left - 12, 150, 12, H - 150);
    c.fillRect(ROAD.right, 150, 12, H - 150);
    c.fillStyle = COLORS.road;
    c.fillRect(ROAD.left, 150, ROAD.right - ROAD.left, H - 150);

    c.strokeStyle = COLORS.roadEdge;
    c.globalAlpha = 0.5;
    c.lineWidth = 3;
    c.beginPath();
    c.moveTo(ROAD.left, 150);
    c.lineTo(ROAD.left, H);
    c.moveTo(ROAD.right, 150);
    c.lineTo(ROAD.right, H);
    c.stroke();
    c.globalAlpha = 1;

    // Scrolling centre-line dashes tied to distance so speed reads on screen.
    c.strokeStyle = COLORS.lane;
    c.lineWidth = 6;
    c.setLineDash([26, 26]);
    c.lineDashOffset = (state.distance * PX_PER_UNIT) % 52;
    c.beginPath();
    c.moveTo(CENTER, 150);
    c.lineTo(CENTER, H);
    c.stroke();
    c.setLineDash([]);
  }

  function drawHouses(c, t) {
    // Highlight the nearest servable house on the side the next throw would go.
    const side = state.bikeX <= CENTER ? "left" : "right";
    let aim = null;
    let aimDist = Infinity;
    if (state.phase === "run") {
      for (const house of course.houses) {
        if (house.side !== side || state.used.has(house.id)) continue;
        const d = Math.abs(house.y - state.distance);
        if (d <= DELIVER_TOL && d < aimDist) {
          aim = house;
          aimDist = d;
        }
      }
    }

    for (const house of course.houses) {
      const sy = screenYFor(house.y);
      if (sy < -70 || sy > H + 70) continue;
      drawHouse(c, house, sy, house === aim, t);
    }
  }

  function drawHouse(c, house, sy, isAim, t) {
    const left = house.side === "left";
    const bodyW = 84;
    const x0 = left ? ROAD.left - 12 - bodyW : ROAD.right + 12;
    const y0 = sy - 32;
    const bodyH = 64;
    const served = state.used.has(house.id);

    // Lawn plot glow when this is the throw target.
    if (isAim) {
      c.save();
      c.strokeStyle = COLORS.accent;
      c.globalAlpha = 0.6 + 0.3 * Math.sin(t / 180);
      c.lineWidth = 3;
      roundRect(c, x0 - 4, y0 - 4, bodyW + 8, bodyH + 8, 10);
      c.stroke();
      c.restore();
    }

    // Body + roof.
    c.fillStyle = COLORS.house;
    roundRect(c, x0, y0, bodyW, bodyH, 8);
    c.fill();
    c.fillStyle = COLORS.houseRoof;
    c.beginPath();
    c.moveTo(x0 - 4, y0 + 6);
    c.lineTo(x0 + bodyW / 2, y0 - 16);
    c.lineTo(x0 + bodyW + 4, y0 + 6);
    c.closePath();
    c.fill();

    if (house.subscriber) {
      // Bunting along the roofline marks a subscriber; a scarf appears once served.
      drawBunting(c, x0, y0 + 8, bodyW);
      if (served) {
        c.fillStyle = COLORS.good;
        c.font = "800 22px system-ui, sans-serif";
        c.textAlign = "center";
        c.fillText("🧣", x0 + bodyW / 2, y0 + 44);
      }
      // Letterbox at the road-facing edge.
      c.fillStyle = served ? COLORS.good : COLORS.letterbox;
      const boxX = left ? x0 + bodyW - 8 : x0;
      roundRect(c, boxX - 3, sy - 6, 10, 16, 3);
      c.fill();
    } else {
      // Non-subscriber window; cracked once smashed.
      const winX = x0 + bodyW / 2 - 12;
      c.fillStyle = served ? "rgba(255,107,107,.35)" : "rgba(180,210,235,.7)";
      c.fillRect(winX, sy - 6, 24, 18);
      if (served) {
        c.strokeStyle = COLORS.bad;
        c.lineWidth = 2;
        c.beginPath();
        c.moveTo(winX, sy - 6);
        c.lineTo(winX + 24, sy + 12);
        c.moveTo(winX + 24, sy - 6);
        c.lineTo(winX, sy + 12);
        c.moveTo(winX + 12, sy - 6);
        c.lineTo(winX + 12, sy + 12);
        c.stroke();
      }
    }
  }

  function drawBunting(c, x, y, w) {
    const flags = 5;
    const cols = [COLORS.bunting1, COLORS.bunting2, COLORS.bunting3];
    for (let i = 0; i < flags; i += 1) {
      const fx = x + 6 + (i / (flags - 1)) * (w - 12);
      c.fillStyle = cols[i % cols.length];
      c.beginPath();
      c.moveTo(fx - 5, y);
      c.lineTo(fx + 5, y);
      c.lineTo(fx, y + 9);
      c.closePath();
      c.fill();
    }
  }

  function drawBundles(c) {
    for (let i = 0; i < course.bundles.length; i += 1) {
      if (state.collected.has(i)) continue;
      const bundle = course.bundles[i];
      const sy = screenYFor(bundle.y);
      if (sy < -40 || sy > H + 40) continue;
      c.font = "30px system-ui, sans-serif";
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.fillText("📰", bundle.x, sy);
      c.textBaseline = "alphabetic";
    }
  }

  function drawHazards(c) {
    for (const hazard of course.hazards) {
      const sy = screenYFor(hazard.y);
      if (sy < -40 || sy > H + 40) continue;
      c.save();
      c.fillStyle = "rgba(0,0,0,.22)";
      c.beginPath();
      c.ellipse(hazard.x, sy + 16, 20, 6, 0, 0, Math.PI * 2);
      c.fill();
      c.font = "32px system-ui, sans-serif";
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.fillText(HAZARD_GLYPH[hazard.kind] ?? "⚠️", hazard.x, sy);
      c.textBaseline = "alphabetic";
      c.restore();
    }
  }

  function drawPapers(c, t) {
    for (const paper of state.papers) {
      const p = clamp((t - paper.start) / paper.dur, 0, 1);
      const x = lerp(paper.fromX, paper.toX, p);
      const y = lerp(paper.fromY, paper.toY, p) - 60 * Math.sin(Math.PI * p);
      c.save();
      c.translate(x, y);
      c.rotate(p * 8);
      c.fillStyle = COLORS.paper;
      roundRect(c, -6, -4, 12, 8, 2);
      c.fill();
      c.restore();
    }
  }

  function drawBike(c, t) {
    const x = state.bikeX;
    const y = BIKE_Y;
    const wobble = state.phase === "run" && !reduceMotion ? Math.sin(t / 90) * 1.5 : 0;
    c.save();
    c.translate(x, y + wobble);

    c.fillStyle = "rgba(0,0,0,.28)";
    c.beginPath();
    c.ellipse(0, 26, 22, 7, 0, 0, Math.PI * 2);
    c.fill();

    // Wheels.
    c.strokeStyle = "#0f1c17";
    c.lineWidth = 4;
    for (const wx of [-14, 14]) {
      c.beginPath();
      c.arc(wx, 18, 11, 0, Math.PI * 2);
      c.stroke();
    }
    // Frame + rider.
    c.strokeStyle = COLORS.bike;
    c.lineWidth = 5;
    c.beginPath();
    c.moveTo(-14, 18);
    c.lineTo(0, 6);
    c.lineTo(14, 18);
    c.stroke();
    c.fillStyle = "#f2d9b8";
    c.beginPath();
    c.arc(0, -14, 9, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = COLORS.bike;
    roundRect(c, -8, -6, 16, 16, 5);
    c.fill();

    // Which side the next throw will go.
    if (state.phase === "run") {
      const side = x <= CENTER ? -1 : 1;
      c.fillStyle = state.ammo > 0 ? COLORS.accent : "rgba(255,255,255,.35)";
      c.beginPath();
      c.moveTo(side * 16, -18);
      c.lineTo(side * 30, -24);
      c.lineTo(side * 30, -12);
      c.closePath();
      c.fill();
    }
    c.restore();
  }

  function drawProgress(c) {
    const pct = clamp(state.distance / course.length, 0, 1);
    c.fillStyle = "rgba(0,0,0,.4)";
    c.fillRect(0, 0, W, 8);
    c.fillStyle = COLORS.accent;
    c.fillRect(0, 0, W * pct, 8);
  }

  function drawReadyVeil(c) {
    c.fillStyle = "rgba(7,15,20,.55)";
    c.fillRect(0, 0, W, H);
    c.fillStyle = "rgba(255,255,255,.94)";
    c.font = "900 46px system-ui, sans-serif";
    c.textAlign = "center";
    c.fillText("Matchday Paper Run", W / 2, H / 2 - 26);
    c.fillStyle = COLORS.accent;
    c.font = "800 22px system-ui, sans-serif";
    c.fillText("Press Start · ◀ ▶ steer · tap Throw", W / 2, H / 2 + 14);
    c.fillStyle = "rgba(255,255,255,.75)";
    c.font = "600 17px system-ui, sans-serif";
    c.fillText("Serve every house flying bunting before the stadium", W / 2, H / 2 + 44);
  }

  function drawFeedback(c, fb, t) {
    c.save();
    c.globalAlpha = clamp((fb.until - t) / 300, 0, 1);
    c.fillStyle = fb.kind === "good" ? COLORS.good : fb.kind === "warn" ? COLORS.warn : COLORS.bad;
    c.font = "900 44px system-ui, sans-serif";
    c.textAlign = "center";
    c.fillText(fb.text, W / 2, 118);
    c.restore();
  }

  function drawDoneVeil(c) {
    c.fillStyle = "rgba(7,11,15,.5)";
    c.fillRect(0, 0, W, H);
    c.fillStyle = "rgba(255,255,255,.94)";
    c.font = "900 34px system-ui, sans-serif";
    c.textAlign = "center";
    const headline = state.finished ? "You made the stadium!" : "Wiped out";
    c.fillText(headline, W / 2, H / 2 - 6);
    c.fillStyle = COLORS.accent;
    c.font = "800 22px system-ui, sans-serif";
    c.fillText(`${state.score.toLocaleString()} pts`, W / 2, H / 2 + 30);
  }

  // ---- misc -------------------------------------------------------------

  function snapshot() {
    return {
      phase: state.phase,
      score: state.score,
      ammo: state.ammo,
      deliveries: state.deliveries,
      subscriberCount: course.subscriberCount,
      distancePct: clamp((state.distance / course.length) * 100, 0, 100),
      message: state.message,
      detail: state.detail,
    };
  }

  function destroy() {
    state.destroyed = true;
    cancelAnimationFrame(frame);
    leftBtn?.removeEventListener("pointerdown", onLeftDown);
    leftBtn?.removeEventListener("pointerup", onLeftUp);
    leftBtn?.removeEventListener("pointerleave", onLeftUp);
    leftBtn?.removeEventListener("pointercancel", onLeftUp);
    rightBtn?.removeEventListener("pointerdown", onRightDown);
    rightBtn?.removeEventListener("pointerup", onRightUp);
    rightBtn?.removeEventListener("pointerleave", onRightUp);
    rightBtn?.removeEventListener("pointercancel", onRightUp);
    throwBtn?.removeEventListener("pointerdown", onThrow);
    startBtn?.removeEventListener("click", onStart);
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
  }

  draw(now());
  callbacks.onTick?.(snapshot());
  return { destroy };
}

function buildCrowd(seed) {
  const rng = seededRandom(`${seed}:crowd`);
  const palette = ["#26323f", "#33414f", "#3d4d5c", "#46566a", "#202a34"];
  const dots = [];
  for (let i = 0; i < 160; i += 1) {
    dots.push({
      x: rng() * W,
      y: 24 + rng() * 90,
      r: 3 + rng() * 2.2,
      a: 0.45 + rng() * 0.4,
      col: palette[Math.floor(rng() * palette.length)],
    });
  }
  return dots;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function matchReduceMotion() {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

function now() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function lerp(a, b, t) {
  return a + (b - a) * clamp(t, 0, 1);
}

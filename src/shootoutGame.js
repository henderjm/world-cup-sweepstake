import { LOGICAL, aimFromRelease, keeperParamsForKick, resolveShot } from "./shootoutPhysics.js";
import { seededRandom } from "./shootoutModel.js";

const W = LOGICAL.width;
const H = LOGICAL.height;
const SPOT = LOGICAL.spot;
const GOAL = LOGICAL.goal;
const BALL_R = 17;
const KEEPER_Y = GOAL.lineY;
const DRAG_GRAB = 120; // how close to the ball a press must start

const COLORS = {
  skyTop: "#0b1f2a",
  skyMid: "#123b34",
  pitchTop: "#1c5a3f",
  pitchBottom: "#0c2a20",
  line: "rgba(238,246,238,.5)",
  net: "rgba(228,240,236,.16)",
  post: "#f6f3e6",
  ball: "#fdfdfb",
  accent: "#f5c84b",
  good: "#34d39e",
  bad: "#ff6b6b",
  keeperKit: "#27c2a0",
  keeperKit2: "#0f6f5c",
};

export function mountShootoutGame(root, dayState, callbacks = {}) {
  const canvas = root.querySelector("[data-shootout-canvas]");
  if (!canvas) return { destroy() {} };
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    callbacks.onUnavailable?.();
    return { destroy() {} };
  }

  const challenge = dayState.challenge;
  const reduceMotion = matchReduceMotion();
  const crowd = buildCrowd(challenge.seed);

  const state = {
    phase: dayState.result ? "done" : "aim",
    kick: 0, // base kicks taken (0..5)
    sdLevel: 0, // 0 = base round, 1.. = sudden death
    sdActive: false,
    shots: [],
    goals: 0,
    style: 0,
    sdStreak: 0,
    ball: { x: SPOT.x, y: SPOT.y },
    keeper: { x: SPOT.x, dive: 0, stretch: 0 },
    aim: null, // { start, current } in logical coords while dragging
    dragging: false,
    flying: null,
    feedback: null, // { text, kind, until }
    ripple: null, // { x, y, until }
    spin: 0,
    message: "Drag back from the ball, then release",
    detail: "Aim for the corners. Beat the keeper.",
    banner: null, // sudden-death intro banner
    destroyed: false,
    last: 0,
  };

  // Rest the keeper on its seeded lean.
  state.keeper.x = restingKeeperX(challenge, 0, 0);

  const onPointerDown = (event) => {
    if (state.phase !== "aim" || state.flying) return;
    const point = eventPoint(canvas, event);
    if (dist(point, state.ball) > DRAG_GRAB) return;
    try {
      canvas.setPointerCapture?.(event.pointerId);
    } catch {
      // synthetic events in checks may lack an active pointer id
    }
    state.dragging = true;
    state.aim = { start: { ...state.ball }, current: point };
    event.preventDefault();
  };

  const onPointerMove = (event) => {
    if (!state.dragging || !state.aim) return;
    state.aim.current = eventPoint(canvas, event);
    event.preventDefault();
  };

  const onPointerUp = (event) => {
    if (!state.dragging || !state.aim || state.flying) return;
    state.aim.current = eventPoint(canvas, event);
    const release = dragRelease(state.aim);
    state.dragging = false;
    state.aim = null;
    if (Math.hypot(release.dx, release.dy) < 18) return; // a tap, not a shot
    shoot(release);
    event.preventDefault();
  };

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);

  let frame = requestAnimationFrame(tick);

  function shoot(release) {
    const decisive = (!state.sdActive && state.kick === 4) || state.sdActive;
    const resolved = resolveShot({
      release,
      keeperFrom: state.keeper.x,
      challenge,
      kickIndex: Math.min(state.kick, 4),
      sdLevel: state.sdLevel,
    });
    const t = resolved.trajectory;
    state.flying = {
      ...t,
      outcome: resolved.outcome,
      hitTarget: resolved.hitTarget,
      decisive,
      startTime: now(),
      duration: reduceMotion ? 150 : t.shotTime * 1000 * (decisive ? 1.25 : 1),
    };
    state.message = "...";
    state.detail = "";
  }

  function settle(flight) {
    const goal = flight.outcome === "goal";
    const text = goal ? (flight.hitTarget ? "TOP BINS!" : "GOAL!") : flight.outcome === "save" ? "SAVED!" : aimedOver(flight) ? "OVER!" : "WIDE!";
    const kind = goal ? "good" : "bad";
    state.feedback = { text, kind, until: now() + (reduceMotion ? 250 : 900) };
    if (goal && !reduceMotion) state.ripple = { x: flight.to.x, y: flight.to.y, until: now() + 650 };

    if (state.sdActive) {
      if (goal) {
        state.sdStreak += 1;
        state.sdLevel += 1;
      } else {
        return finish();
      }
    } else {
      state.shots.push(goal ? "G" : "M");
      if (goal) state.goals += 1;
      if (flight.hitTarget) state.style += 1;
      state.kick += 1;
    }

    callbacks.onKick?.(snapshot());

    if (!state.sdActive && state.kick >= 5) {
      if (state.goals === 5) return enterSuddenDeath();
      return finish();
    }
    resetForNextKick();
  }

  function enterSuddenDeath() {
    state.sdActive = true;
    state.sdLevel = 1;
    state.banner = { until: now() + (reduceMotion ? 400 : 1600) };
    state.message = "SUDDEN DEATH";
    state.detail = "Perfect five. Keep scoring or it's over.";
    callbacks.onSuddenDeath?.();
    callbacks.onKick?.(snapshot());
    resetForNextKick();
  }

  function resetForNextKick() {
    state.flying = null;
    state.ball = { x: SPOT.x, y: SPOT.y };
    state.keeper = { x: restingKeeperX(challenge, Math.min(state.kick, 4), state.sdLevel), dive: 0, stretch: 0 };
    state.phase = "aim";
    if (!state.sdActive) {
      state.message = "Drag back from the ball, then release";
      state.detail = `Kick ${state.kick + 1} of 5`;
    } else {
      state.message = `Sudden death ${state.sdStreak + 1}`;
      state.detail = "One miss ends it.";
    }
  }

  function finish() {
    state.phase = "done";
    state.flying = null;
    callbacks.onComplete?.({
      goals: state.goals,
      style: state.style,
      shots: [...state.shots],
      sdStreak: state.sdStreak,
    });
  }

  function tick(t) {
    if (state.destroyed) return;
    update(t);
    draw(t);
    frame = requestAnimationFrame(tick);
  }

  function update(t) {
    state.last = t;
    const dt = 1 / 60;

    // Keeper tracks the live aim before release so feinting reads on screen.
    if (state.phase === "aim") {
      const params = keeperParamsForKick(challenge, Math.min(state.kick, 4), state.sdLevel);
      let targetX = restingKeeperX(challenge, Math.min(state.kick, 4), state.sdLevel);
      if (state.dragging && state.aim) {
        targetX = aimFromRelease(dragRelease(state.aim)).x;
      }
      const maxStep = params.speed * dt;
      state.keeper.x += clamp(targetX - state.keeper.x, -maxStep, maxStep);
      state.keeper.dive = 0;
      state.keeper.stretch = 0;
    }

    if (state.flying) {
      const f = state.flying;
      const p = clamp((t - f.startTime) / f.duration, 0, 1);
      const eased = 1 - (1 - p) ** 2;
      state.ball = {
        x: lerp(f.from.x, f.to.x, eased),
        y: lerp(f.from.y, f.to.y, eased) - f.arcPeak * Math.sin(Math.PI * eased),
      };
      state.spin += 0.45;
      // Keeper commits its dive across the flight.
      const dir = Math.sign(f.keeperTo - f.keeperFrom) || 1;
      state.keeper.x = lerp(f.keeperFrom, f.keeperTo, eased);
      state.keeper.dive = dir;
      state.keeper.stretch = clamp(eased * 1.25, 0, 1) * Math.min(1, Math.abs(f.keeperTo - f.keeperFrom) / 60 + 0.4);
      if (p >= 1) {
        const done = f;
        state.flying = null;
        settle(done);
      }
    }
  }

  function draw(t) {
    ctx.save();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.scale(canvas.width / W, canvas.height / H);

    // Camera punch on the decisive flight.
    if (state.flying?.decisive && !reduceMotion) {
      const p = clamp((t - state.flying.startTime) / state.flying.duration, 0, 1);
      const zoom = 1 + 0.06 * Math.sin(Math.PI * p);
      ctx.translate(GOAL.left + (GOAL.right - GOAL.left) / 2, GOAL.lineY);
      ctx.scale(zoom, zoom);
      ctx.translate(-(GOAL.left + (GOAL.right - GOAL.left) / 2), -GOAL.lineY);
    }

    drawBackground(ctx, t);
    drawCrowd(ctx, crowd);
    drawPitch(ctx);
    applyRipple(ctx, state.ripple, t);
    drawGoal(ctx, t);
    drawTargets(ctx, challenge, t);
    drawKeeper(ctx, state.keeper);
    if (state.phase === "aim" && state.dragging && state.aim) drawAimPreview(ctx, state.aim, challenge);
    drawBall(ctx, state.ball, state.spin, state.flying);
    drawHud(ctx, state);
    if (state.banner && t < state.banner.until) drawSuddenDeathBanner(ctx, t, state.banner);
    if (state.feedback && t < state.feedback.until) drawFeedback(ctx, state.feedback, t);
    if (state.phase === "done") drawDoneVeil(ctx);
    ctx.restore();
  }

  function snapshot() {
    return {
      shots: [...state.shots],
      goals: state.goals,
      style: state.style,
      sdStreak: state.sdStreak,
      sdActive: state.sdActive,
      message: state.message,
      detail: state.detail,
    };
  }

  function destroy() {
    state.destroyed = true;
    cancelAnimationFrame(frame);
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", onPointerUp);
    canvas.removeEventListener("pointercancel", onPointerUp);
  }

  draw(now());
  callbacks.onKick?.(snapshot());
  return { destroy };
}

// ---------- drawing ----------

function drawBackground(ctx, t) {
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, COLORS.skyTop);
  sky.addColorStop(0.24, COLORS.skyMid);
  sky.addColorStop(0.24, COLORS.pitchTop);
  sky.addColorStop(1, COLORS.pitchBottom);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);

  // Floodlight glow behind the goal.
  const glow = ctx.createRadialGradient(W / 2, 70, 30, W / 2, 90, 520);
  glow.addColorStop(0, "rgba(255,250,225,.22)");
  glow.addColorStop(1, "rgba(255,250,225,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, 320);
}

function drawCrowd(ctx, crowd) {
  ctx.save();
  for (const dot of crowd) {
    ctx.globalAlpha = dot.a;
    ctx.fillStyle = dot.c;
    ctx.beginPath();
    ctx.arc(dot.x, dot.y, dot.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawPitch(ctx) {
  // Mowing stripes in perspective.
  ctx.save();
  ctx.globalAlpha = 0.5;
  for (let i = 0; i < 7; i += 1) {
    ctx.fillStyle = i % 2 === 0 ? "rgba(255,255,255,.03)" : "rgba(0,0,0,.05)";
    const yTop = 150 + i * 12;
    const yBot = 150 + (i + 1) * 70;
    ctx.beginPath();
    ctx.moveTo(-200 + i * 40, yBot);
    ctx.lineTo(W + 200 - i * 40, yBot);
    ctx.lineTo(W + 120 - i * 30, yTop);
    ctx.lineTo(-120 + i * 30, yTop);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();

  // Penalty box + arc, faint.
  ctx.strokeStyle = COLORS.line;
  ctx.lineWidth = 3;
  ctx.globalAlpha = 0.5;
  ctx.beginPath();
  ctx.moveTo(150, 300);
  ctx.lineTo(60, 600);
  ctx.lineTo(900, 600);
  ctx.lineTo(810, 300);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(SPOT.x, SPOT.y, 80, Math.PI * 1.15, Math.PI * 1.85);
  ctx.stroke();
  ctx.globalAlpha = 1;

  // Penalty spot.
  ctx.fillStyle = COLORS.line;
  ctx.beginPath();
  ctx.arc(SPOT.x, SPOT.y, 4, 0, Math.PI * 2);
  ctx.fill();
}

function drawGoal(ctx, t) {
  const { left, right, top, bottom } = GOAL;
  const depth = 30;

  // Net: front mesh with a little ripple.
  ctx.strokeStyle = COLORS.net;
  ctx.lineWidth = 1;
  const rip = (x, y) => {
    if (!ctx.__ripple) return 0;
    const r = ctx.__ripple;
    const d = Math.hypot(x - r.x, y - r.y);
    if (d > 90) return 0;
    return Math.sin((t - r.t0) / 40 - d / 18) * (1 - d / 90) * r.amp;
  };
  for (let x = left + 14; x < right; x += 22) {
    ctx.beginPath();
    for (let y = top + 6; y <= bottom; y += 8) {
      const off = rip(x, y);
      if (y === top + 6) ctx.moveTo(x + off, y);
      else ctx.lineTo(x + off, y);
    }
    ctx.stroke();
  }
  for (let y = top + 8; y < bottom; y += 16) {
    ctx.beginPath();
    for (let x = left + 8; x <= right; x += 10) {
      const off = rip(x, y);
      if (x === left + 8) ctx.moveTo(x, y + off);
      else ctx.lineTo(x, y + off);
    }
    ctx.stroke();
  }

  // Back posts (depth) then front frame.
  ctx.strokeStyle = "rgba(246,243,230,.35)";
  ctx.lineWidth = 4;
  ctx.strokeRect(left + depth, top - depth * 0.4, right - left - depth * 2, bottom - top + depth * 0.4);

  ctx.strokeStyle = COLORS.post;
  ctx.lineWidth = 9;
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(left, bottom);
  ctx.lineTo(left, top);
  ctx.lineTo(right, top);
  ctx.lineTo(right, bottom);
  ctx.stroke();
}

function drawTargets(ctx, challenge, t) {
  for (const target of challenge.targets) {
    const pulse = 0.6 + 0.4 * Math.sin(t / 360 + target.x);
    ctx.save();
    ctx.globalAlpha = 0.5 + pulse * 0.3;
    ctx.strokeStyle = COLORS.accent;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(target.x, target.y, target.size, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 0.12 + pulse * 0.08;
    ctx.fillStyle = COLORS.accent;
    ctx.fill();
    ctx.restore();
  }
}

function drawKeeper(ctx, keeper) {
  const x = keeper.x;
  const y = KEEPER_Y;
  const dir = keeper.dive || 0;
  const s = keeper.stretch || 0;
  ctx.save();
  ctx.translate(x, y);

  // Shadow.
  ctx.fillStyle = "rgba(0,0,0,.22)";
  ctx.beginPath();
  ctx.ellipse(0, 44, 30 + s * 26, 8, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.rotate(dir * s * 0.5);

  // Legs.
  ctx.strokeStyle = COLORS.keeperKit2;
  ctx.lineWidth = 9;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(-7, 24);
  ctx.lineTo(-10 - s * 16, 44);
  ctx.moveTo(7, 24);
  ctx.lineTo(10 + s * 10, 44);
  ctx.stroke();

  // Body.
  const bodyGrad = ctx.createLinearGradient(-16, -30, 16, 26);
  bodyGrad.addColorStop(0, COLORS.keeperKit);
  bodyGrad.addColorStop(1, COLORS.keeperKit2);
  ctx.fillStyle = bodyGrad;
  roundRect(ctx, -16, -28, 32, 54, 12);
  ctx.fill();

  // Head.
  ctx.fillStyle = "#f2d9b8";
  ctx.beginPath();
  ctx.arc(0, -40, 12, 0, Math.PI * 2);
  ctx.fill();

  // Arms + gloves. The leading arm extends in the dive direction.
  ctx.strokeStyle = COLORS.keeperKit;
  ctx.lineWidth = 8;
  const reach = 22 + s * 52;
  ctx.beginPath();
  ctx.moveTo(0, -18);
  ctx.lineTo(dir * reach, -30 - s * 26);
  ctx.moveTo(0, -14);
  ctx.lineTo(-dir * (16 + s * 8), -2 + s * 18);
  ctx.stroke();
  // Gloves.
  ctx.fillStyle = COLORS.accent;
  glove(ctx, dir * reach, -30 - s * 26);
  glove(ctx, -dir * (16 + s * 8), -2 + s * 18);

  ctx.restore();
}

function glove(ctx, x, y) {
  ctx.beginPath();
  ctx.arc(x, y, 7, 0, Math.PI * 2);
  ctx.fill();
}

function drawAimPreview(ctx, aim, challenge) {
  const release = dragRelease(aim);
  const a = aimFromRelease(release);
  const to = { x: clamp(a.x, 40, W - 40), y: clamp(a.y, 70, H - 40) };
  const peak = 40 + a.power * 90;
  const overTarget = (challenge?.targets ?? []).some((tt) => Math.hypot(a.x - tt.x, a.y - tt.y) <= tt.size);

  // Dotted predicted arc.
  ctx.save();
  ctx.setLineDash([2, 12]);
  ctx.lineWidth = 5;
  ctx.lineCap = "round";
  ctx.strokeStyle = overTarget ? COLORS.accent : "rgba(255,255,255,.7)";
  ctx.beginPath();
  for (let i = 0; i <= 16; i += 1) {
    const p = i / 16;
    const x = lerp(SPOT.x, to.x, p);
    const y = lerp(SPOT.y, to.y, p) - peak * Math.sin(Math.PI * p);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.setLineDash([]);

  // Reticle.
  ctx.strokeStyle = overTarget ? COLORS.accent : "rgba(255,255,255,.9)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(to.x, to.y, 15, 0, Math.PI * 2);
  ctx.moveTo(to.x - 22, to.y);
  ctx.lineTo(to.x + 22, to.y);
  ctx.moveTo(to.x, to.y - 22);
  ctx.lineTo(to.x, to.y + 22);
  ctx.stroke();
  if (overTarget) {
    ctx.fillStyle = COLORS.accent;
    ctx.font = "800 18px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("TOP BINS", to.x, to.y - 28);
  }

  // Power ring around the ball.
  const powerColor = a.power > 0.82 ? COLORS.bad : a.power > 0.62 ? COLORS.accent : COLORS.good;
  ctx.lineWidth = 6;
  ctx.strokeStyle = "rgba(255,255,255,.18)";
  ctx.beginPath();
  ctx.arc(SPOT.x, SPOT.y, 30, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = powerColor;
  ctx.beginPath();
  ctx.arc(SPOT.x, SPOT.y, 30, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * a.power);
  ctx.stroke();
  ctx.restore();
}

function drawBall(ctx, ball, spin, flying) {
  // Ground shadow shrinks as the ball lifts.
  const lift = flying ? Math.max(0, SPOT.y - ball.y) : 0;
  const shadowScale = clamp(1 - lift / 520, 0.35, 1);
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,.25)";
  ctx.beginPath();
  ctx.ellipse(ball.x, Math.min(SPOT.y, ball.y + 16), BALL_R * shadowScale, 5 * shadowScale, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.translate(ball.x, ball.y);
  ctx.rotate(spin);
  const grad = ctx.createRadialGradient(-5, -6, 3, 0, 0, BALL_R);
  grad.addColorStop(0, "#ffffff");
  grad.addColorStop(1, "#d8dde3");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(0, 0, BALL_R, 0, Math.PI * 2);
  ctx.fill();
  // Panels.
  ctx.fillStyle = "#1b2733";
  pentagon(ctx, 0, 0, 6);
  for (let i = 0; i < 5; i += 1) {
    const ang = (i / 5) * Math.PI * 2;
    pentagon(ctx, Math.cos(ang) * 10, Math.sin(ang) * 10, 2.6);
  }
  ctx.restore();
}

function drawHud(ctx, state) {
  ctx.save();
  ctx.font = "800 22px system-ui, sans-serif";
  ctx.fillStyle = "rgba(255,255,255,.92)";
  ctx.textAlign = "left";
  if (state.sdActive) {
    ctx.fillStyle = COLORS.accent;
    ctx.fillText(`SUDDEN DEATH · ${state.sdStreak} 🔥`, 26, 40);
  } else {
    ctx.fillText(`${state.goals}/${Math.max(state.kick, 0)} scored`, 26, 40);
  }
  ctx.restore();
}

function drawFeedback(ctx, feedback, t) {
  const pop = feedback.until - t > 740 ? 1 + (1 - (feedback.until - t - 740) / 160) * 0.3 : 1;
  ctx.save();
  ctx.globalAlpha = clamp((feedback.until - t) / 300, 0, 1);
  ctx.fillStyle = feedback.kind === "good" ? COLORS.good : COLORS.bad;
  ctx.translate(W / 2, 110);
  ctx.scale(pop, pop);
  ctx.font = "900 64px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(feedback.text, 0, 0);
  ctx.restore();
}

function drawSuddenDeathBanner(ctx, t, banner) {
  ctx.save();
  ctx.globalAlpha = clamp((banner.until - t) / 500, 0, 1);
  ctx.fillStyle = "rgba(8,12,16,.62)";
  ctx.fillRect(0, H / 2 - 70, W, 140);
  ctx.fillStyle = COLORS.accent;
  ctx.font = "900 70px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("SUDDEN DEATH", W / 2, H / 2 + 8);
  ctx.fillStyle = "rgba(255,255,255,.82)";
  ctx.font = "700 24px system-ui, sans-serif";
  ctx.fillText("Perfect five. One miss ends it.", W / 2, H / 2 + 46);
  ctx.restore();
}

function drawDoneVeil(ctx) {
  ctx.save();
  ctx.fillStyle = "rgba(7,11,15,.45)";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "rgba(255,255,255,.9)";
  ctx.font = "800 30px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("Today's run is in the books", W / 2, H / 2);
  ctx.restore();
}

// Net ripple is stored on the context so drawGoal can read it without threading
// extra arguments through every frame.
function applyRipple(ctx, ripple, t) {
  if (ripple && t < ripple.until) ctx.__ripple = { x: ripple.x, y: ripple.y, t0: ripple.until - 650, amp: 7 };
  else ctx.__ripple = null;
}

// ---------- helpers ----------

function buildCrowd(seed) {
  const rng = seededRandom(`${seed}:crowd`);
  const palette = ["#26323f", "#33414f", "#3d4d5c", "#46566a", "#202a34"];
  const dots = [];
  for (let i = 0; i < 220; i += 1) {
    const x = rng() * W;
    const y = 28 + rng() * 96;
    dots.push({ x, y, r: 3 + rng() * 2.4, a: 0.5 + rng() * 0.4, c: palette[Math.floor(rng() * palette.length)] });
  }
  return dots;
}

function restingKeeperX(challenge, kickIndex, sdLevel) {
  const params = keeperParamsForKick(challenge, kickIndex, sdLevel);
  return SPOT.x + params.lean * (GOAL.right - GOAL.left) * 0.28;
}

function eventPoint(canvas, event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * W,
    y: ((event.clientY - rect.top) / rect.height) * H,
  };
}

function dragRelease(aim) {
  return { dx: aim.current.x - aim.start.x, dy: aim.current.y - aim.start.y };
}

function aimedOver(flight) {
  return flight.to.y < GOAL.top + 2;
}

function pentagon(ctx, cx, cy, r) {
  ctx.beginPath();
  for (let i = 0; i < 5; i += 1) {
    const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
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
  return a + (b - a) * t;
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

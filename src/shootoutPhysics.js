// Pure, deterministic shot resolution for the daily penalty shootout.
//
// No Math.random and no time access live here. Given a release drag, the daily
// challenge, the kick index and the sudden-death level, resolveShot returns the
// trajectory to animate and the outcome (goal / save / miss). Keeping this pure
// means the same inputs always produce the same result, so the game is fair and
// the logic is node-testable.
//
// Coordinate space is the fixed logical canvas (LOGICAL). The view scales it to
// whatever pixel size the canvas is rendered at.

export const LOGICAL = {
  width: 960,
  height: 620,
  // Penalty spot: where the ball starts, bottom-centre.
  spot: { x: 480, y: 540 },
  // Goal mouth in screen coordinates. The ball "enters" at lineY.
  goal: { left: 250, right: 710, top: 150, bottom: 292, lineY: 250 },
};

// Drag-to-aim mapping. The ball fires opposite the drag (slingshot). The aim
// point is a pure function of the release vector so the live preview and the
// resolved shot agree exactly (what you see is where it goes).
const AIM_GAIN_X = 1.45; // horizontal sensitivity
const AIM_GAIN_Y = 1.8; // vertical: pulling further down lifts the ball higher
const MAX_PULL = 230; // drag length (logical px) that maps to full power
const MIN_POWER = 0.2;

// Shot pace: higher power means a faster shot and less time for the keeper.
const SHOT_TIME_SLOW = 0.92; // seconds at min power
const SHOT_TIME_FAST = 0.46; // seconds at full power
const KEEPER_MOVE_SCALE = 1.0; // how far the keeper travels per second of flight

// Keeper vertical reach. The keeper cannot cover above this Y on a normal dive,
// so the top corners (above it) are the safe, high-skill zone. Sudden death
// raises the keeper's reach so even the top corners get contested eventually.
const KEEPER_TOP_REACH_Y = 196;

export function aimFromRelease(release) {
  const dx = Number(release?.dx) || 0;
  const dy = Number(release?.dy) || 0;
  const pull = Math.hypot(dx, dy);
  const power = clamp(pull / MAX_PULL, pull > 0 ? MIN_POWER : 0, 1);
  // Fire opposite the horizontal drag (slingshot). Any vertical drag lifts the
  // ball toward the goal; more drag means higher and further.
  const x = LOGICAL.spot.x - dx * AIM_GAIN_X;
  const y = LOGICAL.spot.y - Math.abs(dy) * AIM_GAIN_Y;
  return { x, y, power, pull };
}

// Keeper personality for a given kick. Pure: derived from the challenge plus the
// sudden-death level. Identical for every player on a given day.
export function keeperParamsForKick(challenge, kickIndex = 0, sdLevel = 0) {
  const base = challenge?.keeper?.base ?? { reach: 86, speed: 360, lean: 0, commit: 0.55 };
  const perKick = challenge?.keeper?.perKick?.[clampInt(kickIndex, 0, 4)] ?? { reachOff: 0, speedOff: 0, leanOff: 0 };
  const sd = challenge?.sd ?? { speedGrowth: 0.16, reachGrowth: 0.08, topGrowth: 7 };
  const level = Math.max(0, sdLevel);

  const reach = (base.reach + (perKick.reachOff ?? 0)) * (1 + sd.reachGrowth * level);
  const speed = (base.speed + (perKick.speedOff ?? 0)) * (1 + sd.speedGrowth * level);
  const lean = clamp((base.lean ?? 0) + (perKick.leanOff ?? 0), -1, 1);
  // Keeper can stretch higher as sudden death escalates.
  const topReachY = KEEPER_TOP_REACH_Y - (sd.topGrowth ?? 7) * level;
  return { reach, speed, lean, commit: base.commit ?? 0.55, topReachY };
}

// Resolve a complete shot.
//   release    : { dx, dy } slingshot drag (ball fires opposite)
//   keeperFrom : keeper x at the moment of release (the game tracks this live so
//                feinting reads on screen). Falls back to the seeded lean.
//   challenge  : output of createShootoutChallenge
//   kickIndex  : 0..4 for base kicks
//   sdLevel    : 0 base round, 1.. for sudden-death kicks
export function resolveShot({ release, keeperFrom, challenge, kickIndex = 0, sdLevel = 0 }) {
  const aim = aimFromRelease(release);
  const k = keeperParamsForKick(challenge, kickIndex, sdLevel);
  const goal = LOGICAL.goal;

  const shotTime = lerp(SHOT_TIME_SLOW, SHOT_TIME_FAST, aim.power);

  // Where the keeper starts its dive. If the game did not track a live position,
  // start from the seeded lean across the goal.
  const start = Number.isFinite(keeperFrom)
    ? keeperFrom
    : LOGICAL.spot.x + k.lean * (goal.right - goal.left) * 0.32;

  const maxMove = k.speed * shotTime * KEEPER_MOVE_SCALE;
  const keeperTo = start + clamp(aim.x - start, -maxMove, maxMove);

  const onTarget =
    aim.x >= goal.left && aim.x <= goal.right && aim.y >= goal.top && aim.y <= goal.bottom;

  // The keeper saves an on-target shot only if it gets across in time AND the
  // ball is not above its reach. High corners beat it vertically.
  const withinHorizontal = Math.abs(aim.x - keeperTo) <= k.reach;
  const withinVertical = aim.y >= k.topReachY;
  const saved = onTarget && withinHorizontal && withinVertical;

  let outcome = "miss";
  if (onTarget && !saved) outcome = "goal";
  else if (saved) outcome = "save";

  const hitTarget = outcome === "goal" && isInTargetZone(challenge, aim);

  const trajectory = {
    from: { ...LOGICAL.spot },
    to: { x: clamp(aim.x, 40, LOGICAL.width - 40), y: clamp(aim.y, 70, LOGICAL.height - 40) },
    power: aim.power,
    shotTime,
    arcPeak: 40 + aim.power * 90, // visual arc height
    keeperFrom: start,
    keeperTo,
    keeperReach: k.reach,
    keeperTopReachY: k.topReachY,
  };

  return { trajectory, outcome, hitTarget, aim };
}

function isInTargetZone(challenge, aim) {
  const targets = challenge?.targets ?? [];
  return targets.some((t) => Math.hypot(aim.x - t.x, aim.y - t.y) <= t.size);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function clampInt(value, min, max) {
  return Math.max(min, Math.min(max, Math.trunc(Number(value) || 0)));
}

function lerp(a, b, t) {
  return a + (b - a) * clamp(t, 0, 1);
}

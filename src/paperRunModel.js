// Pure, deterministic model for the daily Matchday Paper Run.
//
// A football-flavoured take on Paperboy: you cycle to the stadium down a matchday
// street, lobbing rolled-up match programmes to the fans flying bunting (your
// "subscribers") while dodging street hazards. One seeded course per Dublin day,
// so everyone rides the identical street and the daily high-score board is fair.
//
// No Math.random and no time access decide outcomes here. The course is generated
// from the day's seed and the game logic is a pure function of player input, so the
// run is reproducible and node-testable. performance.now() in the game module only
// drives animation, never scoring.

const DUBLIN_TZ = "Europe/Dublin";
const START_DATE = "2026-06-11"; // World Cup 2026 opening day
const DAY_MS = 24 * 60 * 60 * 1000;
const CLIENT_VERSION = 1;

// Shared arena + road geometry. Kept here (not in the game module) so course
// generation and the renderer agree on where the road and kerbs are.
export const ARENA = { width: 960, height: 620 };
export const ROAD = { left: 300, right: 660 }; // centre = 480
export const LANE = { min: 330, max: 630 }; // where hazards/bundles may spawn across the road

// Points. Shared with the worker so the score cap it validates against matches what
// the client can actually earn.
export const SCORING = {
  deliver: 100, // programme into a subscriber's letterbox
  perfect: 50, // bonus for a dead-centre delivery
  smash: 60, // cheeky window smash on a non-subscriber house
  bundle: 10, // riding over a fresh bundle of programmes
  finish: 500, // reaching the stadium
  perfectRound: 1000, // every subscriber served
  distance: 1, // per course unit travelled (rewards progress even on a crash)
};

// Difficulty / layout knobs for the daily course.
const COURSE_LENGTH = 900;
const HOUSE_START = 80;
const HAZARD_KINDS = ["cone", "car", "dog", "fan", "bin"];

export function todayPaperRunDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: DUBLIN_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

export function challengeNumber(date) {
  const start = Date.parse(`${START_DATE}T00:00:00Z`);
  const current = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(current)) return 1;
  return Math.max(1, Math.floor((current - start) / DAY_MS) + 1);
}

// One deterministic street per Dublin day. Houses (subscriber or not, which kerb),
// hazards and programme bundles all come from this seed, so the run is identical for
// everyone and stable across reloads.
export function createPaperRunChallenge(date = todayPaperRunDate()) {
  const seed = `paperrun:${date}`;
  const rng = seededRandom(seed);

  const length = COURSE_LENGTH;

  // Houses down both kerbs. Sides mostly alternate but occasionally repeat so you
  // cannot just park on one side of the road.
  const houses = [];
  let hid = 0;
  let y = HOUSE_START;
  let side = rng() < 0.5 ? "left" : "right";
  while (y < length - 40) {
    if (rng() < 0.62) side = side === "left" ? "right" : "left";
    houses.push({ id: hid, y: round(y, 1), side, subscriber: rng() < 0.58 });
    hid += 1;
    y += 13 + rng() * 8; // 13..21 units apart
  }
  const subscriberCount = houses.filter((house) => house.subscriber).length;

  // Hazards thicken and the gaps shrink the closer you get to the stadium.
  const hazards = [];
  let hy = 150;
  while (hy < length - 30) {
    const t = hy / length;
    hy += lerp(64, 34, t) + rng() * 26;
    if (hy >= length - 30) break;
    hazards.push({
      y: round(hy, 1),
      x: round(LANE.min + rng() * (LANE.max - LANE.min), 1),
      kind: HAZARD_KINDS[Math.floor(rng() * HAZARD_KINDS.length)],
    });
  }

  // Programme bundles to refill your throwing arm. Spaced so a tidy run carries
  // enough programmes to serve every subscriber, with headroom for wasted throws.
  const bundles = [];
  let by = 90;
  while (by < length - 50) {
    by += 90 + rng() * 60;
    if (by >= length - 50) break;
    bundles.push({ y: round(by, 1), x: round(LANE.min + rng() * (LANE.max - LANE.min), 1) });
  }

  return {
    date,
    challengeNumber: challengeNumber(date),
    seed,
    clientVersion: CLIENT_VERSION,
    course: { length, houses, hazards, bundles, subscriberCount, houseCount: houses.length },
    speed: { start: 26, max: 46 }, // course units per second, ramped by distance
    ammoStart: 12,
    ammoPerBundle: 6,
  };
}

// The most a perfect run on this course could score. The worker validates submitted
// scores against this, so a single spoofed number still cannot exceed what the day
// physically allows (same range-check posture as the rest of the daily game).
export function scoreCap(challenge) {
  const c = challenge?.course;
  if (!c) return 0;
  const nonSub = c.houseCount - c.subscriberCount;
  return (
    c.subscriberCount * (SCORING.deliver + SCORING.perfect) +
    nonSub * SCORING.smash +
    c.bundles.length * SCORING.bundle +
    SCORING.finish +
    SCORING.perfectRound +
    Math.ceil(c.length * SCORING.distance)
  );
}

export function validateClientResult(result, challenge) {
  if (!result || typeof result !== "object") return { ok: false, error: "bad result" };
  const course = challenge?.course;
  const subs = course?.subscriberCount ?? 999;
  const nonSub = course ? course.houseCount - course.subscriberCount : 999;
  const cap = challenge ? scoreCap(challenge) : Number.MAX_SAFE_INTEGER;

  if (!Number.isInteger(result.score) || result.score < 0 || result.score > cap) {
    return { ok: false, error: "bad score" };
  }
  if (!Number.isInteger(result.deliveries) || result.deliveries < 0 || result.deliveries > subs) {
    return { ok: false, error: "bad deliveries" };
  }
  if (!Number.isInteger(result.perfects) || result.perfects < 0 || result.perfects > result.deliveries) {
    return { ok: false, error: "bad perfects" };
  }
  if (!Number.isInteger(result.smashes) || result.smashes < 0 || result.smashes > nonSub) {
    return { ok: false, error: "bad smashes" };
  }
  if (typeof result.finished !== "boolean") return { ok: false, error: "bad finished" };
  if (!Number.isFinite(result.distancePct) || result.distancePct < 0 || result.distancePct > 100) {
    return { ok: false, error: "bad distance" };
  }
  if (result.team != null && typeof result.team !== "string") {
    return { ok: false, error: "bad team" };
  }
  return { ok: true };
}

export function normalizeResult(result, challenge) {
  const course = challenge?.course;
  const subs = course?.subscriberCount ?? 999;
  const nonSub = course ? course.houseCount - course.subscriberCount : 999;
  const cap = challenge ? scoreCap(challenge) : Number.MAX_SAFE_INTEGER;

  const deliveries = clampInt(result?.deliveries, 0, subs);
  const team = cleanLabel(result?.team, 32);
  const normalized = {
    name: cleanName(result?.name),
    score: clampInt(result?.score, 0, cap),
    deliveries,
    perfects: clampInt(result?.perfects, 0, deliveries),
    smashes: clampInt(result?.smashes, 0, nonSub),
    finished: Boolean(result?.finished),
    distancePct: clampNum(result?.distancePct, 0, 100),
    submittedAt: Number.isFinite(result?.submittedAt) ? result.submittedAt : Date.now(),
    clientVersion: CLIENT_VERSION,
  };
  if (team) normalized.team = team;
  return normalized;
}

// A tiny visual badge for share cards and board rows.
export function resultBadge(result) {
  if (result?.finished) return "🏟️ delivered the lot";
  const pct = Math.round(result?.distancePct ?? 0);
  return `🚲 crashed at ${pct}%`;
}

export function shareText({ challenge, result, url = "" }) {
  const subs = challenge?.course?.subscriberCount ?? 0;
  const lines = [
    `Goon Squad Paper Run #${challenge.challengeNumber}`,
    `🏆 ${result.score.toLocaleString()} pts`,
    `📰 ${result.deliveries}${subs ? `/${subs}` : ""} delivered · 💥 ${result.smashes}`,
    resultBadge(result),
    result.team ? `Team: ${result.team}` : "",
  ].filter(Boolean);
  if (url) lines.push(url);
  return lines.join("\n");
}

// Leaderboard order: raw score, then deliveries, then perfect drops, then who
// actually reached the stadium, then earliest finish.
export function sortLeaderboard(rows) {
  return [...(rows ?? [])].sort(
    (a, b) =>
      b.score - a.score ||
      (b.deliveries ?? 0) - (a.deliveries ?? 0) ||
      (b.perfects ?? 0) - (a.perfects ?? 0) ||
      Number(b.finished) - Number(a.finished) ||
      (a.submittedAt ?? Number.MAX_SAFE_INTEGER) - (b.submittedAt ?? Number.MAX_SAFE_INTEGER) ||
      String(a.name).localeCompare(String(b.name)),
  );
}

export function mergeLeaderboardResult(rows, result) {
  const byUid = new Map((rows ?? []).map((row) => [row.uid, row]));
  if (result?.uid) byUid.set(result.uid, result);
  return sortLeaderboard([...byUid.values()]).slice(0, 32);
}

export function cleanName(value) {
  return (
    String(value ?? "")
      .replace(/[<>]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 24) || "Someone"
  );
}

export function seededRandom(seed) {
  let state = hash32(seed);
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash32(value) {
  let hash = 2166136261;
  const text = String(value);
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function clampInt(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

function clampNum(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}

function cleanLabel(value, maxLength) {
  return String(value ?? "")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function round(value, places) {
  const power = 10 ** places;
  return Math.round(value * power) / power;
}

function lerp(a, b, t) {
  return a + (b - a) * Math.max(0, Math.min(1, t));
}

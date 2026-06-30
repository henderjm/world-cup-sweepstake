import { LOGICAL } from "./shootoutPhysics.js";

const DUBLIN_TZ = "Europe/Dublin";
const START_DATE = "2026-06-23";
const DAY_MS = 24 * 60 * 60 * 1000;
const CLIENT_VERSION = 2;
const SD_CAP = 99;

export function todayShootoutDate(now = new Date()) {
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

// One deterministic challenge per Dublin day. Everything a player faces (keeper
// behaviour, target placement, sudden-death escalation) comes from this seed, so
// the day is identical for everyone and stable across reloads.
export function createShootoutChallenge(date = todayShootoutDate()) {
  const seed = `shootout:${date}`;
  const rng = seededRandom(seed);
  const goal = LOGICAL.goal;
  const goalWidth = goal.right - goal.left;

  const base = {
    reach: round(74 + rng() * 26, 1), // horizontal arm span at full stretch
    speed: round(320 + rng() * 110, 1), // logical px per second the keeper covers
    lean: round((rng() * 2 - 1) * 0.45, 2), // resting bias across the goal
    commit: round(0.5 + rng() * 0.16, 2),
  };
  const perKick = Array.from({ length: 5 }, () => ({
    reachOff: round((rng() * 2 - 1) * 8, 1),
    speedOff: round((rng() * 2 - 1) * 36, 1),
    leanOff: round((rng() * 2 - 1) * 0.5, 2),
  }));

  // Two top-corner target zones. They sit above the keeper's normal reach, so
  // they are the safe but small high-skill scoring zones.
  const cornerY = goal.top + 18 + rng() * 14;
  const size = round(28 + rng() * 10, 1);
  const targets = [
    { id: "top-left", label: "Top bins", x: round(goal.left + goalWidth * (0.12 + rng() * 0.08), 1), y: round(cornerY, 1), size },
    { id: "top-right", label: "Top bins", x: round(goal.right - goalWidth * (0.12 + rng() * 0.08), 1), y: round(cornerY, 1), size },
  ];

  const sd = {
    speedGrowth: round(0.14 + rng() * 0.06, 3), // keeper gets faster each SD kick
    reachGrowth: round(0.06 + rng() * 0.04, 3),
    topGrowth: round(6 + rng() * 3, 2), // keeper stretches higher each SD kick
  };

  return {
    date,
    challengeNumber: challengeNumber(date),
    seed,
    clientVersion: CLIENT_VERSION,
    keeper: { base, perKick },
    targets,
    sd,
  };
}

export function validateClientResult(result) {
  if (!result || typeof result !== "object") return { ok: false, error: "bad result" };
  if (!Number.isInteger(result.goals) || result.goals < 0 || result.goals > 5) {
    return { ok: false, error: "bad goals" };
  }
  if (!Number.isInteger(result.style) || result.style < 0 || result.style > 5) {
    return { ok: false, error: "bad style" };
  }
  if (!Array.isArray(result.shots) || result.shots.length !== 5) {
    return { ok: false, error: "bad shots" };
  }
  if (result.shots.some((shot) => shot !== "G" && shot !== "M")) {
    return { ok: false, error: "bad shot value" };
  }
  const countedGoals = result.shots.filter((shot) => shot === "G").length;
  if (countedGoals !== result.goals) return { ok: false, error: "goals mismatch" };
  if (!Number.isInteger(result.sdStreak) || result.sdStreak < 0 || result.sdStreak > SD_CAP) {
    return { ok: false, error: "bad sudden death" };
  }
  if (result.goals !== 5 && result.sdStreak !== 0) {
    return { ok: false, error: "sudden death without a perfect run" };
  }
  if (result.team != null && typeof result.team !== "string") {
    return { ok: false, error: "bad team" };
  }
  return { ok: true };
}

export function normalizeResult(result) {
  const shots = Array.isArray(result?.shots)
    ? result.shots.slice(0, 5).map((shot) => (shot === "G" ? "G" : "M"))
    : [];
  while (shots.length < 5) shots.push("M");
  const goals = clampInt(result?.goals ?? shots.filter((shot) => shot === "G").length, 0, 5);
  const team = cleanLabel(result?.team, 32);
  const normalized = {
    name: cleanName(result?.name),
    goals,
    style: clampInt(result?.style, 0, 5),
    shots,
    sdStreak: goals === 5 ? clampInt(result?.sdStreak, 0, SD_CAP) : 0,
    submittedAt: Number.isFinite(result?.submittedAt) ? result.submittedAt : Date.now(),
    clientVersion: CLIENT_VERSION,
  };
  if (team) normalized.team = team;
  return normalized;
}

export function resultEmojiLine(result) {
  return (result?.shots ?? []).map((shot) => (shot === "G" ? "⚽" : "❌")).join("");
}

export function shareText({ challenge, result, url = "" }) {
  const scoreLine = `${resultEmojiLine(result)} ${result.goals}/5`;
  const detail = result.goals === 5
    ? `Sudden death: ${result.sdStreak} 🔥`
    : `Top bins: ${result.style}`;
  const lines = [
    `Goon Squad Daily Shootout #${challenge.challengeNumber}`,
    scoreLine,
    detail,
    result.team ? `Team: ${result.team}` : "",
  ].filter(Boolean);
  if (url) lines.push(url);
  return lines.join("\n");
}

// Leaderboard order: base goals, then how far they pushed sudden death, then
// top-bin style, then who finished first.
export function sortLeaderboard(rows) {
  return [...(rows ?? [])].sort(
    (a, b) =>
      b.goals - a.goals ||
      (b.sdStreak ?? 0) - (a.sdStreak ?? 0) ||
      b.style - a.style ||
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
  return String(value ?? "")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 24) || "Someone";
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

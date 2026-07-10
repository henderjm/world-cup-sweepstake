import { DATA_API } from "./data.js";
import {
  createPaperRunChallenge,
  normalizeResult,
  sortLeaderboard,
  todayPaperRunDate,
} from "./paperRunModel.js";

let memoryId = null;
const UID_KEY = "gs_uid";
const NAME_KEY = "gs_name";

export function visitorId() {
  try {
    let stored = window.localStorage.getItem(UID_KEY);
    if (!stored) stored = readCookie(UID_KEY);
    if (!stored) {
      stored = window.crypto?.randomUUID?.() ?? `u-${Math.random().toString(36).slice(2, 12)}`;
      window.localStorage.setItem(UID_KEY, stored);
      writeCookie(UID_KEY, stored, 365);
    }
    return stored;
  } catch {
    if (!memoryId) memoryId = `u-${Math.random().toString(36).slice(2, 12)}`;
    return memoryId;
  }
}

export function displayName() {
  try {
    return window.localStorage.getItem(NAME_KEY) || readCookie(NAME_KEY) || "";
  } catch {
    return readCookie(NAME_KEY) || "";
  }
}

export function rememberName(name) {
  const clean = String(name ?? "").replace(/[<>]/g, "").trim().slice(0, 24);
  if (!clean) return "";
  try {
    window.localStorage.setItem(NAME_KEY, clean);
  } catch {
    // storage blocked; the submitted result still carries the typed name
  }
  writeCookie(NAME_KEY, clean, 365);
  return clean;
}

export async function loadPaperRunDay(date = todayPaperRunDate()) {
  const challenge = createPaperRunChallenge(date);
  const localResult = loadLocalResult(date);
  const base = {
    date,
    challenge,
    alreadyPlayed: Boolean(localResult),
    result: localResult,
    leaderboard: localResult ? sortLeaderboard([localResult]) : [],
    serverAvailable: false,
    localOnly: Boolean(localResult),
    error: "",
  };

  if (!DATA_API) return base;

  try {
    const response = await fetch(`${DATA_API}/paperrun/${date}?uid=${encodeURIComponent(visitorId())}`, {
      cache: "no-store",
    });
    if (response.status === 503) {
      return { ...base, error: "Daily leaderboard is not switched on yet." };
    }
    if (!response.ok) return base;
    const server = await response.json();
    const result = server.result ? normalizeResult(server.result, challenge) : localResult;
    if (result) saveLocalResult(date, result);
    return {
      ...base,
      ...server,
      challenge,
      alreadyPlayed: Boolean(result || server.alreadyPlayed),
      result,
      leaderboard: sortLeaderboard(server.leaderboard ?? base.leaderboard),
      serverAvailable: true,
      localOnly: Boolean(localResult && !server.result),
    };
  } catch {
    return base;
  }
}

export async function submitPaperRunResult(date, result) {
  const challenge = createPaperRunChallenge(date);
  const local = normalizeResult({ ...result, submittedAt: Date.now() }, challenge);
  saveLocalResult(date, local);

  if (!DATA_API) {
    return {
      ok: true,
      localOnly: true,
      result: local,
      leaderboard: sortLeaderboard([local]),
    };
  }

  try {
    const response = await fetch(`${DATA_API}/paperrun/${date}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        uid: visitorId(),
        name: local.name,
        score: local.score,
        deliveries: local.deliveries,
        perfects: local.perfects,
        smashes: local.smashes,
        finished: local.finished,
        distancePct: local.distancePct,
        team: local.team,
        clientVersion: local.clientVersion,
      }),
    });
    if (response.status === 409) {
      const server = await response.json();
      const existing = normalizeResult(server.result, challenge);
      saveLocalResult(date, existing);
      return {
        ok: false,
        conflict: true,
        result: existing,
        leaderboard: sortLeaderboard(server.leaderboard ?? [existing]),
      };
    }
    if (!response.ok) {
      return { ok: true, localOnly: true, result: local, leaderboard: sortLeaderboard([local]) };
    }
    const server = await response.json();
    const submitted = normalizeResult(server.result ?? local, challenge);
    saveLocalResult(date, submitted);
    return {
      ok: true,
      localOnly: false,
      result: submitted,
      leaderboard: sortLeaderboard(server.leaderboard ?? [submitted]),
    };
  } catch {
    return { ok: true, localOnly: true, result: local, leaderboard: sortLeaderboard([local]) };
  }
}

export function loadLocalResult(date) {
  const key = storageKey(date);
  try {
    const raw = window.localStorage.getItem(key) || readCookie(cookieKey(date));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // Ignore results from a different game shape so the board stays clean.
    if (Number(parsed?.clientVersion) !== 1) return null;
    return normalizeResult(parsed, createPaperRunChallenge(date));
  } catch {
    return null;
  }
}

export function saveLocalResult(date, result) {
  const normalized = normalizeResult(result, createPaperRunChallenge(date));
  const value = JSON.stringify(normalized);
  try {
    window.localStorage.setItem(storageKey(date), value);
  } catch {
    // cookie fallback below
  }
  writeCookie(cookieKey(date), value, 7);
  return normalized;
}

export async function sharePaperRun(text) {
  if (navigator.share) {
    try {
      await navigator.share({ text });
      return "shared";
    } catch (error) {
      if (error?.name === "AbortError") return "cancelled";
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    return "copied";
  } catch {
    return "unsupported";
  }
}

function storageKey(date) {
  return `paperrun:${date}`;
}

function cookieKey(date) {
  return `paperrun_${date}`;
}

function readCookie(name) {
  try {
    const safe = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = document.cookie.match(new RegExp(`(?:^|; )${safe}=([^;]*)`));
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

function writeCookie(name, value, days) {
  try {
    const expires = new Date(Date.now() + days * 864e5).toUTCString();
    document.cookie = `${name}=${encodeURIComponent(value)}; expires=${expires}; path=/; SameSite=Lax`;
  } catch {
    // cookies can be blocked; localStorage may still have worked
  }
}

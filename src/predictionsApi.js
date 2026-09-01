import { DATA_API } from "./data.js";
import { authHeaders } from "./account.js";

// Prediction game client: the localStorage store a signed-out visitor plays
// from, and the Worker calls a signed-in one persists through. Mirrors
// account.js's api() helper (bearer header, JSON body, thrown Error with a
// numeric .status) so 401/409/501 are distinct, catchable states the view can
// word properly.
//
// The local store is per BROWSER, deliberately: "anyone can play" means no
// account wall, and the cost is that a device's history stays on that device.
// syncLocalPredictions is the one-way bridge for the visitor who then signs
// in: any still-open local prediction the server has no row for is pushed up
// and removed locally, so signing in reads as "my picks came with me" rather
// than "my picks vanished". Scored local history is NOT pushed (the server
// scores only what it saw before kickoff; back-filling results it cannot
// verify would let a client mint points), so it simply ages out with the
// season.

const LOCAL_KEY = "gs-predictions";

export function predictionsAvailable() {
  return Boolean(DATA_API);
}

// { [matchId]: { homeGoals, awayGoals, competition, savedAt } }
export function loadLocalPredictions() {
  try {
    const raw = JSON.parse(window.localStorage.getItem(LOCAL_KEY) ?? "null");
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

export function saveLocalPrediction(matchId, homeGoals, awayGoals, competition) {
  const all = loadLocalPredictions();
  all[matchId] = { homeGoals, awayGoals, competition, savedAt: Date.now() };
  try {
    window.localStorage.setItem(LOCAL_KEY, JSON.stringify(all));
  } catch {
    // storage blocked; the prediction lives for this page only
  }
  return all;
}

export function removeLocalPredictions(matchIds) {
  const all = loadLocalPredictions();
  for (const id of matchIds) delete all[id];
  try {
    window.localStorage.setItem(LOCAL_KEY, JSON.stringify(all));
  } catch {
    // storage blocked
  }
  return all;
}

async function api(path, options = {}) {
  const headers = { ...(options.headers ?? {}), ...authHeaders() };
  if (options.body) headers["Content-Type"] = "application/json";
  const response = await fetch(`${DATA_API}${path}`, { ...options, headers });
  if (!response.ok) {
    let message = "";
    try {
      message = (await response.json())?.error ?? "";
    } catch {
      // no JSON body to read a message from
    }
    const error = new Error(message || `predictions api ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

// { predictions: [...], summary } - the caller's whole history, every
// competition, scored rows carrying points/exact/actuals.
export async function fetchMyPredictions() {
  return api("/predictions");
}

// Saves or updates one prediction. Throws .status 409 when the match has
// kicked off (the Worker fails closed; see canPredict in src/predictions.js).
export async function submitPrediction(matchId, homeGoals, awayGoals) {
  return api("/predictions", { method: "POST", body: JSON.stringify({ matchId, homeGoals, awayGoals }) });
}

// One-way local -> server bridge on sign-in (see the module comment). Pushes
// only predictions that are still OPEN (the caller passes the ids it verified
// against the live model with canPredict) and that the server has no row for,
// then clears the pushed ids locally. Returns how many made it up. Best
// effort: a failed push keeps its local row and is retried next visit.
export async function syncLocalPredictions(openIds, serverIds) {
  const local = loadLocalPredictions();
  const synced = [];
  for (const id of openIds) {
    const entry = local[id];
    if (!entry || serverIds.has(id)) continue;
    try {
      await submitPrediction(id, entry.homeGoals, entry.awayGoals);
      synced.push(id);
    } catch {
      // kicked off since, or a blip; the local row stays and the next visit retries
    }
  }
  if (synced.length) removeLocalPredictions(synced);
  return synced.length;
}

import { DATA_API } from "./data.js";
import { authHeaders, sessionToken } from "./account.js";

// Fantasy H2H draft league client: league CRUD/lobby over plain fetch, the live
// draft room over a WebSocket (see fantasyDraft.js), and the static player pool
// the app already bakes. Mirrors account.js's api() helper (bearer header, JSON
// body, thrown Error with a numeric .status) so 401 (signed out) and 501
// (feature not configured) are distinct, catchable states the view can render.

export function fantasyAvailable() {
  return Boolean(DATA_API);
}

async function api(path, options = {}) {
  const headers = { ...(options.headers ?? {}), ...authHeaders() };
  if (options.body) headers["Content-Type"] = "application/json";
  const response = await fetch(`${DATA_API}${path}`, { ...options, headers });
  if (!response.ok) {
    let message = "";
    try {
      const body = await response.json();
      message = body?.error ?? "";
    } catch {
      // no JSON body to read a message from
    }
    const error = new Error(message || `fantasy api ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

export async function createLeague(name) {
  return (await api("/fantasy/leagues", { method: "POST", body: JSON.stringify({ name }) })).league;
}

export async function joinLeague(code) {
  return (await api("/fantasy/leagues/join", { method: "POST", body: JSON.stringify({ code }) })).league;
}

export async function listLeagues() {
  return (await api("/fantasy/leagues")).leagues;
}

// { league, members, picks, roster } - roster is only the caller's own roster
// (see CLAUDE.md/backend-contract notes on why the draft room instead reads
// rosters for every manager from the WebSocket's "state" message).
export async function loadLeague(id) {
  return api(`/fantasy/league/${id}`);
}

export async function startDraft(id) {
  return (await api(`/fantasy/league/${id}/draft/start`, { method: "POST" })).league;
}

// Browsers cannot set an Authorization header on a WebSocket handshake, so the
// bearer token rides as a query parameter instead (the one exception to
// Authorization-only auth in this codebase; see worker/worker.js
// handleFantasyDraftWs). Returns null when there is no Worker configured or no
// session, so the caller can render a signed-out/not-configured state instead
// of opening a socket that will just be rejected.
export function draftSocketUrl(leagueId) {
  if (!DATA_API) return null;
  const token = sessionToken();
  if (!token) return null;
  const wsOrigin = DATA_API.replace(/^http/, "ws");
  return `${wsOrigin}/fantasy/league/${leagueId}/draft/ws?token=${encodeURIComponent(token)}`;
}

// The same baked static file data.js's siblings read (data/<comp>/scorers.json
// etc), fetched once per draft-room mount. Fantasy is Premier-League-only for
// now (SQUAD_SLOTS/MAX_LEAGUE_SIZE assume a single top-flight pool), so the path
// is not competition-parameterized the way live.json is.
export async function loadPlayerPool() {
  const response = await fetch(`./data/PL/players.json?cache=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`player pool ${response.status}`);
  return response.json();
}

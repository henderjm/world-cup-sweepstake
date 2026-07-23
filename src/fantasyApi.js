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

// A 404 means the /fantasy/* routes themselves don't exist on the deployed
// Worker yet (a client shipped ahead of the backend deploy - the exact
// scenario that used to render "Couldn't load Fantasy: not found" with a
// Retry button that would just 404 again); 501 means the routes exist but the
// feature's bindings (DB/DRAFT_ROOM) are missing server-side (see
// worker/worker.js). Both read to the user as "not available yet", not a bug,
// so both map to the same not-configured card as fantasyAvailable() === false
// rather than the generic error+retry path. Genuine errors (500s, network
// failures) are not covered here and keep going through error+retry.
export function isFantasyNotDeployed(error) {
  return error?.status === 404 || error?.status === 501;
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

// GET the effective starting XI for the current gameweek: { gameweek, source:
// "set" | "inherited" | "default", starters: [{ playerId, isCaptain }], bench:
// [playerId] }. Member-only (401/403), 404/501 if the league or the fantasy
// routes themselves don't exist yet - same isFantasyNotDeployed handling as
// the rest of this module.
export async function getLineup(leagueId) {
  return api(`/fantasy/league/${leagueId}/lineup`);
}

// POSTs a full replacement starting XI + captain for the current (server-
// derived) gameweek; the Worker always writes to its own idea of "now", never
// a client-supplied gameweek. Returns the same shape as getLineup with
// source: "set", or throws with error.status 400 and a plain-English
// error.message on a validation failure (wrong XI size, illegal formation,
// captain not among the starters, a player not on the caller's roster).
export async function setLineup(leagueId, { starters, captainId }) {
  return api(`/fantasy/league/${leagueId}/lineup`, {
    method: "POST",
    body: JSON.stringify({ starters, captainId }),
  });
}

// GET the caller's current-gameweek head-to-head: { gameweek, status: "scheduled"
// | "live" | "final", me: { userId, name, score }, opponent: { userId, name,
// score } | null }. A null opponent is a bye week (round-robin scheduling can
// produce one for an odd-sized league), not an error. Member-only (401/403),
// 404/501 if the league or the fantasy routes themselves don't exist yet -
// same isFantasyNotDeployed handling as the rest of this module.
export async function loadMatchup(leagueId) {
  return api(`/fantasy/league/${leagueId}/matchup`);
}

// GET the league table through the last completed gameweek: { throughGameweek,
// standings: [{ userId, name, played, wins, draws, losses, pointsFor,
// pointsAgainst, recordPoints }, ...] }, already sorted by the Worker
// (recordPoints desc, then pointsFor, then name). throughGameweek is 0 when no
// gameweek has completed yet - an empty-standings state, not an error.
export async function loadStandings(leagueId) {
  return api(`/fantasy/league/${leagueId}/standings`);
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
  if (!response.ok) {
    // A 404 here is the expected, calm case today: the pool has never been
    // baked in production yet. Carry the status so the caller can tell that
    // apart from a genuine failure without parsing the message string.
    const error = new Error(`player pool ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

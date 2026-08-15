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

// Commissioner-only, pending-only: fills `count` empty seats with bot
// managers so a league that never found ten people can still draft on the day
// it planned to (see src/fantasyBots.js). Returns { league, added: [name] }.
// Throws with error.status 403 for a non-commissioner, 400 for a bad count,
// a full league, or a draft that has already started.
// Names the CALLER's own squad in this league (issue #48). No user id in the
// path or the body: the Worker scopes the write to the session's own seat, so
// there is no way to spell "rename somebody else". An empty name clears it and
// the manager falls back to their account name. Returns { teamName }.
export async function setLeagueTeamName(leagueId, teamName) {
  return api(`/fantasy/league/${leagueId}/team-name`, { method: "POST", body: JSON.stringify({ teamName }) });
}

// Commissioner-only: names the manager holding last season's trophy (issue
// #43). NOT pending-only, unlike the bot routes below - a league can record its
// history at any point in the season. `userId` must be a member of this league
// and must not be a bot; validate with validateChampionChoice
// (src/fantasyChampion.js) first so the two cannot disagree about what is
// legal. Returns { previousWinnerUserId }. Throws with error.status 403 for a
// non-commissioner, 400 for a target that is not an eligible member.
export async function setLeagueChampion(leagueId, userId) {
  return api(`/fantasy/league/${leagueId}/champion`, { method: "POST", body: JSON.stringify({ userId }) });
}

// Commissioner-only: back to no champion recorded. Idempotent, so clearing a
// league that has none is a 200 rather than an error.
export async function clearLeagueChampion(leagueId) {
  return api(`/fantasy/league/${leagueId}/champion`, { method: "DELETE" });
}

export async function addLeagueBots(leagueId, count) {
  return api(`/fantasy/league/${leagueId}/bots`, { method: "POST", body: JSON.stringify({ count }) });
}

// Commissioner-only, pending-only, and only ever a BOT: the Worker refuses a
// target that is not flagged is_bot and a member of this same league, so this
// can never become "evict a manager". Returns { league }.
export async function removeLeagueBot(leagueId, botUserId) {
  return api(`/fantasy/league/${leagueId}/bots/${botUserId}`, { method: "DELETE" });
}

// PUBLIC, unlike every other call in this module: what a shared invite link
// shows someone BEFORE they are asked to sign in. Returns { league: { name,
// draftStatus, joinable, seats }, managers: [{ name, isBot, isCommissioner }] }
// with no ids and no email addresses. Throws with error.status 404 for an
// unknown or expired code. Deliberately does not send the bearer header, since
// the whole point is that it works signed out; api() adds one only when a
// session exists, which is harmless either way.
export async function loadInvitePreview(code) {
  return api(`/fantasy/invite/${encodeURIComponent(code)}`);
}

export async function startDraft(id) {
  return (await api(`/fantasy/league/${id}/draft/start`, { method: "POST" })).league;
}

// Commissioner-only: schedules a still-pending league's draft for a future
// UTC instant. `scheduledAtIso` must already be a UTC ISO 8601 string (see
// src/fantasyScheduling.js's localInputValueToUtcIso for converting a
// datetime-local input's value before calling this). Returns { scheduledAt }.
// Throws with error.status 400 for a bad/past/too-far-out date, 403 for a
// non-commissioner caller, 400 if the draft has already started.
export async function scheduleDraft(leagueId, scheduledAtIso) {
  return (
    await api(`/fantasy/league/${leagueId}/draft/schedule`, {
      method: "POST",
      body: JSON.stringify({ scheduledAt: scheduledAtIso }),
    })
  ).schedule;
}

// Commissioner-only: clears a still-pending league's schedule, reverting to
// the pre-existing manual-start-only behaviour. Returns null (the same shape
// the lobby already reads for "not scheduled").
export async function unscheduleDraft(leagueId) {
  return (await api(`/fantasy/league/${leagueId}/draft/schedule`, { method: "DELETE" })).schedule;
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

// GET the caller's own draft-pick shortlist for this league: { queue:
// [playerId, ...] } in queue order, empty once they have never saved one.
// Member-only (401/403), 404/501 if the league or the fantasy routes
// themselves don't exist yet - same isFantasyNotDeployed handling as the
// rest of this module.
export async function loadDraftQueue(leagueId) {
  return (await api(`/fantasy/league/${leagueId}/draft/queue`)).queue;
}

// POSTs a full replacement of the caller's own shortlist (never a single
// mutation - the client always sends the whole ordered list of player ids).
// Persisted server-side so a clock expiring autopicks from it even if this
// tab has since closed (see worker/draftRoom.js's alarm, which reads the
// fantasy_draft_queue table directly). Returns { queue } echoing what was
// saved (de-duplicated server-side).
export async function saveDraftQueue(leagueId, queue) {
  return (
    await api(`/fantasy/league/${leagueId}/draft/queue`, {
      method: "POST",
      body: JSON.stringify({ queue }),
    })
  ).queue;
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

// GET the league's WHOLE head-to-head season: { currentGameweek, preseason,
// seasonStart, members: [{ userId, name, isBot }], gameweeks: [{ gameweek,
// kickoff, deadline, fixtures: [{ homeUserId, awayUserId, homeScore,
// awayScore }], byeUserIds }] }. Every gameweek the league has fixtures for,
// not just the current one.
//
// `byeUserIds` is derived server-side rather than stored: round-robin
// scheduling drops the bye slot entirely, so a byed manager has no row, and
// the schedule has to say who sat out or that manager sees nothing at all.
// Scores are the settled ones (null until that gameweek is rolled up), never
// the live rollup, which is what loadMatchup is for. Member-only (401/403).
export async function loadLeagueSchedule(leagueId) {
  return api(`/fantasy/league/${leagueId}/schedule`);
}

// GET the league table through the last completed gameweek: { throughGameweek,
// standings: [{ userId, name, played, wins, draws, losses, pointsFor,
// pointsAgainst, recordPoints }, ...] }, already sorted by the Worker
// (recordPoints desc, then pointsFor, then name). throughGameweek is 0 when no
// gameweek has completed yet - an empty-standings state, not an error.
export async function loadStandings(leagueId) {
  return api(`/fantasy/league/${leagueId}/standings`);
}

// GET the whole Waivers tab in one call: mode/budgets/priorities, the
// free-agent pool, the wire, the caller's own claim history and the last
// resolved run. Member-only (401/403), 400 while the league's draft is not
// complete yet (waivers only exist once a season's rosters are fixed),
// 404/501 if the league or the fantasy routes themselves don't exist -
// same isFantasyNotDeployed handling as the rest of this module.
export async function loadWaivers(leagueId) {
  return api(`/fantasy/league/${leagueId}/waivers`);
}

// Queues a claim against an ON_WAIVERS player: { addPlayerId, dropPlayerId,
// bid?, priority? }. bid only matters in faab mode; priority is the caller's
// own try-first ordering among their own pending claims (defaults server-side
// to "tried last" when omitted). Returns { claimId, gameweek, deferred,
// runsAfter, status: "pending" }: `gameweek` names the run that will resolve
// this claim, and `deferred` is true when the quiet period before the current
// gameweek's run pushed it onto the next one instead (never a rejection, and
// never ambiguous - see WAIVER_QUIET_PERIOD_MS in src/fantasyWaivers.js).
// Throws with error.status 400 and a plain-English error.message on a
// validation failure (not actually on waivers, position mismatch, not enough
// budget, etc - see src/fantasyWaivers.js), or 409 in the vanishingly rare
// case where a run committed underneath the request twice over.
export async function submitWaiverClaim(leagueId, body) {
  return api(`/fantasy/league/${leagueId}/waivers/claim`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// Cancels one of the caller's own still-pending claims. Throws with
// error.status 400 if the claim has already been resolved by a run (nothing
// to cancel), 403 if it belongs to someone else.
export async function cancelWaiverClaim(leagueId, claimId) {
  return api(`/fantasy/league/${leagueId}/waivers/claim/${claimId}`, { method: "DELETE" });
}

// Instant free-agent add: { addPlayerId, dropPlayerId }, no bid (free agency
// is first come first served, never a bid). Returns { ok: true, roster } with
// the caller's full post-swap roster, or throws with error.status 400 and a
// plain-English error.message - including "Player is not a free agent" when
// another manager wins the same race, since two managers can both pass a
// read-time check before only one write wins.
export async function addFreeAgent(leagueId, body) {
  return api(`/fantasy/league/${leagueId}/freeagents/add`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// Commissioner-only: { mode, faabBudget }. Throws with error.status 403 for a
// non-commissioner caller, 400 if claims are still pending for the current
// gameweek (changing the rules mid-run would be unfair to whoever already
// queued a claim under the old ones).
export async function saveWaiverSettings(leagueId, body) {
  return api(`/fantasy/league/${leagueId}/waivers/settings`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// GET the league feed: { entries: [...], viewerUserId }. One timeline
// carrying both the app's own events (draft picks, waiver runs, free-agent
// adds, lineup changes, the weekly AI recap) and managers' own messages, so a
// move and the conversation about it are never on separate surfaces.
// Member-only in BOTH directions, unlike match banter which is publicly
// readable: a private league's transactions are nobody else's business.
export async function loadLeagueFeed(leagueId) {
  return api(`/fantasy/league/${leagueId}/chat`);
}

// Posts to the feed: { action: "message", text } or { action: "react",
// messageId, emoji }. Returns the WHOLE refreshed feed rather than just the
// new row, because D1 is strongly consistent and the response therefore
// always includes this very write, which is what lets the optimistic UI
// reconcile against it without flicker (see src/banter.js for the original of
// this pattern).
export async function postLeagueFeed(leagueId, body) {
  return api(`/fantasy/league/${leagueId}/chat`, { method: "POST", body: JSON.stringify(body) });
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

// GET the Worker's in-season-blended xp for every active player: { [id]:
// { xp, xpBasis } }, "blended" once at least one gameweek has finished this
// season, else the same historical figure the static bake already carries
// (see worker/worker.js's runScheduledFantasyXpBlend). Public, not
// league-scoped. 501 if the fantasy DB binding is missing - same
// isFantasyNotDeployed handling as the rest of this module; callers treat
// any failure here as "the static pool's own xp stands" (see
// applyBlendedXp in fantasyDraft.js) rather than blocking on it.
export async function loadBlendedXp() {
  return (await api("/fantasy/players/xp")).players;
}

// The same static PL live feed data.js's loadModel("PL") reads, fetched
// directly rather than through loadModel: the demo only needs raw
// matches/standings for a fixture join and a club-strength derivation (see
// src/fantasyDemoFixtures.js), not the scorer merge or zone/competition
// wiring loadModel's buildModel also does. Failure (offline, 404, feed not
// baked yet) is swallowed by the caller, not here (see startDemoDraft in
// app.js), so the demo degrades to its pre-fixture flat scoring instead of
// blocking the trial season on a feed that may never have been deployed.
export async function loadPlFixtureData() {
  const response = await fetch(`./data/PL/live.json?cache=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) {
    const error = new Error(`PL fixture data ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

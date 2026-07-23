// Pure fantasy starting-lineup logic (Phase 4.4). No DOM, no fetch, no D1: the
// Worker's /fantasy/league/:id/lineup routes are a thin shell around these
// functions, mirroring how draftLogic.js keeps the draft room's rules testable
// outside the Worker.
//
// Schema invariant (see worker/schema.sql, fantasy_lineups): a manager's absence
// from that table for a gameweek means "use the previous gameweek's lineup",
// resolved here at read time. Nothing ever copy-writes a prior gameweek's rows
// forward, so a manager who never touches their lineup after round 1 still has
// one every week without a single extra write.

import { STARTING_LIMITS, STARTING_SIZE, validateFormation } from "./fantasy.js";

const FILL_ORDER = ["GK", "DEF", "MID", "FWD"];

function toStarters(rows) {
  return rows.map((row) => ({ playerId: row.player_id, isCaptain: Boolean(row.is_captain) }));
}

// Resolves the starting XI that applies to `gameweek` from every fantasy_lineups
// row a manager has in one league. Precedence: rows set exactly for `gameweek`,
// else the rows of the latest gameweek strictly before it, else no lineup has
// ever been set and the caller falls back to defaultLineup(). `rows` is
// { gameweek, player_id, is_captain }[], as read straight off D1.
export function resolveEffectiveLineup(rows, gameweek) {
  const list = rows ?? [];

  const exact = list.filter((row) => row.gameweek === gameweek);
  if (exact.length) return { gameweek, inherited: false, starters: toStarters(exact) };

  const earlier = list.filter((row) => row.gameweek < gameweek);
  if (earlier.length) {
    const sourceGameweek = Math.max(...earlier.map((row) => row.gameweek));
    const sourceRows = earlier.filter((row) => row.gameweek === sourceGameweek);
    return { gameweek: sourceGameweek, inherited: true, starters: toStarters(sourceRows) };
  }

  return { gameweek: null, inherited: false, starters: [] };
}

// Deterministic legal starting XI from a full roster, for a manager who has
// never set a lineup. Fills each position's STARTING_LIMITS minimum first (GK,
// then DEF, MID, FWD, in roster order), then tops up to STARTING_SIZE with the
// next eligible roster entries (again in roster order), respecting each
// position's max. Captain defaults to the first starter chosen. `roster` is
// { id, position, ... }[]; never writes anything, purely computed on read.
export function defaultLineup(roster) {
  const players = roster ?? [];
  const used = new Set();
  const starters = [];

  for (const position of FILL_ORDER) {
    const min = STARTING_LIMITS[position]?.min ?? 0;
    let filled = 0;
    for (const player of players) {
      if (filled >= min) break;
      if (used.has(player.id) || player.position !== position) continue;
      used.add(player.id);
      starters.push(player);
      filled += 1;
    }
  }

  for (const player of players) {
    if (starters.length >= STARTING_SIZE) break;
    if (used.has(player.id)) continue;
    const max = STARTING_LIMITS[player.position]?.max;
    const count = starters.filter((entry) => entry.position === player.position).length;
    if (max != null && count >= max) continue;
    used.add(player.id);
    starters.push(player);
  }

  if (!starters.length) return { starters: [], captainId: null };
  const captainId = starters[0].id;
  return {
    starters: starters.map((player) => ({ playerId: player.id, isCaptain: player.id === captainId })),
    captainId,
  };
}

// Validates a manager's proposed starting XI against their real roster: exactly
// STARTING_SIZE distinct ids, every id actually owned, a legal formation (via
// fantasy.js's validateFormation, not a duplicated rule set), and a captain
// drawn from the starters themselves.
export function validateLineupSelection({ starters, captainId, roster }) {
  const ids = starters ?? [];
  if (ids.length !== STARTING_SIZE) {
    return { ok: false, error: `starting XI must have exactly ${STARTING_SIZE} players` };
  }
  if (new Set(ids).size !== ids.length) {
    return { ok: false, error: "starting XI has duplicate players" };
  }

  const byId = new Map((roster ?? []).map((player) => [player.id, player]));
  const players = [];
  for (const id of ids) {
    const player = byId.get(id);
    if (!player) return { ok: false, error: `player ${id} is not on your roster` };
    players.push(player);
  }

  const formation = validateFormation(players);
  if (!formation.valid) return { ok: false, error: formation.error };

  if (captainId == null || !ids.includes(captainId)) {
    return { ok: false, error: "captain must be one of the starters" };
  }

  return { ok: true };
}

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

// Shared by defaultLineup (fills from nothing) and repairLineup (fills the
// gap left by a lost player): fills each position's STARTING_LIMITS minimum
// first (GK, then DEF, MID, FWD, in pool order), counting `preselected`
// players already in that bucket, then tops up to STARTING_SIZE with the
// next eligible pool entries, respecting each position's max. `preselected`
// and `pool` must not overlap; the result always starts with `preselected`
// in its original order followed by whatever was added.
function fillLineup(preselected, pool) {
  const used = new Set(preselected.map((player) => player.id));
  const starters = [...preselected];

  for (const position of FILL_ORDER) {
    const min = STARTING_LIMITS[position]?.min ?? 0;
    let filled = starters.filter((entry) => entry.position === position).length;
    for (const player of pool) {
      if (filled >= min) break;
      if (used.has(player.id) || player.position !== position) continue;
      used.add(player.id);
      starters.push(player);
      filled += 1;
    }
  }

  for (const player of pool) {
    if (starters.length >= STARTING_SIZE) break;
    if (used.has(player.id)) continue;
    const max = STARTING_LIMITS[player.position]?.max;
    const count = starters.filter((entry) => entry.position === player.position).length;
    if (max != null && count >= max) continue;
    used.add(player.id);
    starters.push(player);
  }

  return starters;
}

// Deterministic legal starting XI from a full roster, for a manager who has
// never set a lineup. `roster` is { id, position, ... }[]; never writes
// anything, purely computed on read. Captain defaults to the first starter
// chosen.
export function defaultLineup(roster) {
  const starters = fillLineup([], roster ?? []);
  if (!starters.length) return { starters: [], captainId: null };
  const captainId = starters[0].id;
  return {
    starters: starters.map((player) => ({ playerId: player.id, isCaptain: player.id === captainId })),
    captainId,
  };
}

// A manager's saved starters (set for this gameweek, or inherited from an
// earlier one) can reference a player no longer on their roster: dropped via
// free agency or a waiver claim since the lineup was last touched. Filters
// those out and tops up from the remaining roster using the same
// formation-fill order defaultLineup uses, never silently pointing at a lost
// player. If the lost player was the captain, the first surviving or
// topped-up starter becomes captain instead of leaving the XI captain-less.
// `starters` is { playerId, isCaptain }[]; `roster` is { id, position }[].
// Returns the input unchanged (repaired: false) when nothing was lost.
//
// The result is exactly STARTING_SIZE and legal PROVIDED the roster can
// still fill every position's STARTING_LIMITS minimum, which holds today
// because every acquisition (instant free agency or a waiver claim) is a
// same-position 1-for-1 swap: the roster's per-position counts, and
// therefore SQUAD_SIZE itself, never shrink. Nothing in this codebase can
// currently make a roster too small or too position-imbalanced to field a
// legal XI, so that path is intentionally not built out. If the roster ever
// were too small, fillLineup's own bounds (it only ever draws from
// `preselected` plus `pool`) already return however many starters that
// allows rather than crashing or padding in an invalid entry; that
// roster-limited result is this function's deliberate fallback, not an
// accident of the loop structure.
export function repairLineup(starters, roster) {
  const players = roster ?? [];
  const list = starters ?? [];
  const byId = new Map(players.map((player) => [player.id, player]));
  const ownedIds = new Set(players.map((player) => player.id));

  const survivors = list.filter((entry) => ownedIds.has(entry.playerId));
  if (survivors.length === list.length) return { starters: list, repaired: false };

  const survivorPlayers = survivors.map((entry) => byId.get(entry.playerId));
  const usedIds = new Set(survivorPlayers.map((player) => player.id));
  const pool = players.filter((player) => !usedIds.has(player.id));
  const filled = fillLineup(survivorPlayers, pool);

  const survivingCaptain = survivors.find((entry) => entry.isCaptain);
  const captainId = survivingCaptain ? survivingCaptain.playerId : filled[0]?.id ?? null;

  return {
    starters: filled.map((player) => ({ playerId: player.id, isCaptain: player.id === captainId })),
    repaired: true,
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

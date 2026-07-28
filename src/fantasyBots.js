// Bot managers: filling a league's empty seats so a draft can actually run.
//
// The product problem this exists for: a draft league needs eight to twelve
// people, and a new product cannot ask six friends to go and find four
// strangers. A league that has not drafted by the season opener is lost for a
// year, so a commissioner needs a way to say "start anyway".
//
// Almost none of the draft needed new logic for this. The Durable Object's
// alarm already resolves the on-clock manager and picks topQueuedPick() ??
// autoPick(), so a bot manager is just a member whose clock always expires;
// resolveEffectiveLineup already falls back to defaultLineup, so a bot always
// fields a legal XI with nothing written anywhere. The only genuine blocker was
// IDENTITY, which is what most of this module is about.
//
// THE IDENTITY RULE, and it is the security-critical one:
//
//   A bot's google_sub is "bot:<leagueId>:<random>", which is not a possible
//   Google subject. Google's `sub` claim is a decimal digit string; ours
//   contains colons and letters. So a verified Google token can never mint a
//   sub that collides with a bot's, which makes a bot unauthenticable BY
//   CONSTRUCTION rather than by a check somebody has to remember to write.
//
// isRealGoogleSub() is the other half: the auth path refuses to accept ANY sub
// that is not a plain digit string, so even a hypothetically compromised or
// changed identity provider cannot hand back "bot:3:ab12cd34" and be issued a
// session for an existing bot row. Neither half depends on the other, and the
// test suite asserts the property directly rather than trusting the prefix.
//
// Pure module: no DOM, no fetch, no D1. Randomness is injected (see
// planBotSeats' makeToken) so seat planning is deterministic under test,
// mirroring how draftLogic.js keeps every decision the draft room makes
// testable outside the Workers runtime.

import { MAX_LEAGUE_SIZE } from "./fantasy.js";

export const BOT_SUB_PREFIX = "bot:";

// Google documents `sub` as at most 255 ASCII characters and issues decimal
// integer strings. Accepting only digits is both true of every real Google
// subject and provably disjoint from BOT_SUB_PREFIX, which is the whole point:
// the two namespaces cannot intersect, so no ordering or precedence question
// between them can ever arise.
export function isRealGoogleSub(sub) {
  return typeof sub === "string" && /^[0-9]{1,255}$/.test(sub);
}

export function isBotGoogleSub(sub) {
  return typeof sub === "string" && sub.startsWith(BOT_SUB_PREFIX);
}

export function botGoogleSub(leagueId, token) {
  return `${BOT_SUB_PREFIX}${leagueId}:${token}`;
}

// Matches every bot ever minted for one league, for the orphan sweep in
// worker.js. Bound as a parameter, never interpolated.
export function botSubPatternForLeague(leagueId) {
  return `${BOT_SUB_PREFIX}${leagueId}:%`;
}

// A bot's stored display name carries its own label, and that is deliberate
// rather than cosmetic. Several surfaces only ever see the name as a bare
// string with no structure to hang a chip off: the league feed denormalises a
// manager's name into its payload on write (see schema.sql's
// fantasy_chat_messages comment) and the weekly recap hands names to a language
// model. A name that says "Bot" is honest in all of them without every one of
// those call sites needing to know bots exist. Structured surfaces additionally
// get an isBot flag and render a chip.
export const BOT_SEAT_NAMES = [
  "Bot Alfie",
  "Bot Bex",
  "Bot Cass",
  "Bot Devi",
  "Bot Effie",
  "Bot Femi",
  "Bot Gio",
  "Bot Hana",
  "Bot Idris",
  "Bot Juno",
];

// RFC 2606 reserves .invalid precisely so a made-up address is guaranteed
// undeliverable. users.email is NOT NULL and is the fallback display name, so a
// bot needs one; it must never look like an address anyone could reach.
export function botEmail(googleSub) {
  return `${String(googleSub).replace(/[^a-z0-9]+/gi, "-")}@bots.invalid`;
}

// The first `count` names not already used in this league, so re-adding after a
// removal reuses the freed name instead of skipping down the list. The numbered
// fallback only ever fires if a league somehow holds more managers than there
// are names, which MAX_LEAGUE_SIZE prevents; it exists so this can never return
// a duplicate or a blank.
export function botDisplayNames(count, takenNames = []) {
  const taken = new Set((takenNames ?? []).map((name) => String(name ?? "").trim().toLowerCase()));
  const names = [];
  for (const candidate of BOT_SEAT_NAMES) {
    if (names.length >= count) break;
    if (taken.has(candidate.toLowerCase())) continue;
    names.push(candidate);
    taken.add(candidate.toLowerCase());
  }
  for (let n = 1; names.length < count; n += 1) {
    const candidate = `Bot ${BOT_SEAT_NAMES.length + n}`;
    if (taken.has(candidate.toLowerCase())) continue;
    names.push(candidate);
    taken.add(candidate.toLowerCase());
  }
  return names;
}

// How many seats a league has, split the way a human reading the lobby cares
// about: a "6 managers" line that silently counts four bots is exactly the kind
// of implied-real-person count this feature must not produce.
export function seatSummary(members, maxLeagueSize = MAX_LEAGUE_SIZE) {
  const list = members ?? [];
  const bots = list.filter((member) => Boolean(member?.isBot)).length;
  return {
    total: list.length,
    humans: list.length - bots,
    bots,
    open: Math.max(0, maxLeagueSize - list.length),
    max: maxLeagueSize,
  };
}

// Plans N bot seats, or explains why it cannot. Every failure returns a
// user-facing sentence rather than a code, since the only caller is a
// commissioner-facing route whose 400s are shown verbatim.
//
// `makeToken` is injected (the Worker passes a crypto-random hex generator) so
// this stays pure and a test can assert exact subs.
export function planBotSeats({
  leagueId,
  memberCount,
  requested,
  maxLeagueSize = MAX_LEAGUE_SIZE,
  takenNames = [],
  makeToken,
}) {
  if (!Number.isInteger(requested) || requested < 1) {
    return { ok: false, error: "Choose at least one bot to add.", seats: [] };
  }
  const open = maxLeagueSize - (memberCount ?? 0);
  if (open <= 0) {
    return { ok: false, error: "This league is already full.", seats: [] };
  }
  if (requested > open) {
    return {
      ok: false,
      error: `Only ${open} seat${open === 1 ? "" : "s"} left in this league.`,
      seats: [],
    };
  }

  const names = botDisplayNames(requested, takenNames);
  const seats = names.map((name) => {
    const googleSub = botGoogleSub(leagueId, makeToken());
    return { name, googleSub, email: botEmail(googleSub) };
  });
  return { ok: true, error: null, seats };
}

// -- The pick clock -------------------------------------------------------------
//
// Lives here rather than in worker/draftRoom.js because it is now a decision
// (which manager is on the clock) rather than a constant, and the Durable
// Object is deliberately kept free of anything unit-testable.
//
// A bot that sat out the full human clock would make bot-filling useless: an
// eight-bot league is 120 automated picks, which at 60 seconds each is two
// hours of nothing happening, and the whole point of the feature is a draft
// that finishes on the day it was scheduled. The bot window is still long
// enough to read the pick land in the feed rather than watching a blur.
export const HUMAN_PICK_CLOCK_MS = 60 * 1000;
export const BOT_PICK_CLOCK_MS = 4 * 1000;

export function pickClockMs(onClockIsBot) {
  return onClockIsBot ? BOT_PICK_CLOCK_MS : HUMAN_PICK_CLOCK_MS;
}

// -- Dead-team autopilot ----------------------------------------------------
//
// ESPN ships this as Auto Control, and it is DAMAGE CONTROL, not engagement.
// One abandoned roster fielding a stale XI does not just cost its own owner,
// it hands free wins to whoever happens to play them and quietly ruins the
// season for the other nine people. A commissioner needs a way to stop that
// without evicting anybody.
//
// It lives in this module rather than in one of its own because a team on
// autopilot IS a bot manager, temporarily: the seat keeps its real human
// owner, its results still count, and what changes is only who makes the
// decisions. Everything it does is something the bot machinery already did.
// There is no second brain here, and there must not be one.
//
// THE REVERSIBILITY RULE, and it is the one that matters:
//
//   Autopilot is off the instant the real manager touches ANYTHING. Not on the
//   next cron tick, not after a confirmation: the same request that shows they
//   are back clears the flag. A manager who returns to find the app still
//   playing their team for them would be right to leave, so the disengage is
//   not a feature of autopilot, it is the price of being allowed to exist.

// What autopilot may do, as an explicit allowlist rather than a list of
// prohibitions. Written this way on purpose: the day trades ship, an autopilot
// built on "everything except trades" silently gains the ability to trade an
// absent manager's squad away, whereas this one has to be deliberately edited
// to gain anything at all. Trading somebody's players without them is a
// different product with different consequences, and it is never in here.
export const AUTOPILOT_ACTIONS = Object.freeze(["lineup", "pickup"]);

export function autopilotAllows(action) {
  return AUTOPILOT_ACTIONS.includes(action);
}

// The manager actions that mean the real person is back, and therefore switch
// autopilot off. Deliberately broad: posting in the feed is not a roster move,
// but somebody typing in their league is unambiguously present, and the cost
// of disengaging a fraction too eagerly is that a manager plays their own team
// (which is the desired state) while the cost of disengaging too late is the
// app overwriting a decision a real person just made.
export const AUTOPILOT_RETURN_ACTIONS = Object.freeze([
  "lineup",
  "free_agent",
  "waiver_claim",
  "draft_queue",
  "chat",
]);

export function autopilotDisengagesOn(action) {
  return AUTOPILOT_RETURN_ACTIONS.includes(action);
}

// How much better a free agent has to be, in expected points, before autopilot
// will swap him in for somebody the absent manager actually chose.
//
// Set high on purpose. Autopilot is standing in for an absent person, not
// playing the waiver wire on their behalf, and a marginal upgrade churns a
// squad its owner may come back to. A wrong pickup is worse than no pickup,
// so the bar is "the manager would obviously have done this".
export const AUTOPILOT_PICKUP_MARGIN = 15;

// At most one swap per run, whatever the run finds. A bot that rebuilt an
// abandoned squad wholesale in one tick would be indistinguishable from a bug.
export const AUTOPILOT_PICKUPS_PER_RUN = 1;

// The one same-position swap most worth making right now, or null.
//
// Same-position by construction, which is what keeps every roster bucket full
// and the XI legal (see SQUAD_SLOTS and validateAcquisition in
// fantasyWaivers.js). A locked player, on either side of the swap, is simply
// not a candidate: the kickoff lock exists so a move cannot bank or dodge
// points already decided, and autopilot gets no exemption from it.
//
// Pure: takes the roster, the available free agents and the locked set, and
// returns a decision. It performs nothing and reads no clock.
export function autopilotPickup({ roster, freeAgents, lockedPlayerIds, margin = AUTOPILOT_PICKUP_MARGIN } = {}) {
  const locked = lockedPlayerIds instanceof Set ? lockedPlayerIds : new Set(lockedPlayerIds ?? []);
  const eligible = (list) => (list ?? []).filter((player) => player && !locked.has(player.id));

  const mine = eligible(roster);
  const available = eligible(freeAgents);
  if (!mine.length || !available.length) return null;

  let best = null;
  for (const position of new Set(mine.map((player) => player.position))) {
    // The worst player I hold there, against the best one going spare.
    const drop = lowestBy(mine.filter((player) => player.position === position));
    const add = highestBy(available.filter((player) => player.position === position));
    if (!drop || !add) continue;

    const gain = xp(add) - xp(drop);
    if (gain < margin) continue;
    // Ties broken by player id so two ticks reading the same data always reach
    // the same decision; nothing here may depend on array order.
    if (!best || gain > best.gain || (gain === best.gain && add.id < best.add.id)) {
      best = { add, drop, gain: Math.round(gain * 10) / 10 };
    }
  }
  return best;
}

function xp(player) {
  const value = Number(player?.xp);
  return Number.isFinite(value) ? value : 0;
}

function highestBy(players) {
  return players.reduce((best, player) => (!best || xp(player) > xp(best) ? player : best), null);
}

function lowestBy(players) {
  return players.reduce((worst, player) => (!worst || xp(player) < xp(worst) ? player : worst), null);
}

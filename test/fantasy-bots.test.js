import assert from "node:assert/strict";
import test from "node:test";

import {
  BOT_PICK_CLOCK_MS,
  BOT_SEAT_NAMES,
  BOT_SUB_PREFIX,
  HUMAN_PICK_CLOCK_MS,
  botDisplayNames,
  botEmail,
  botGoogleSub,
  botSubPatternForLeague,
  isBotGoogleSub,
  isRealGoogleSub,
  pickClockMs,
  planBotSeats,
  seatSummary,
} from "../src/fantasyBots.js";
import { MAX_LEAGUE_SIZE } from "../src/fantasy.js";

// -- The security-critical property --------------------------------------------
//
// A bot is a users row. If a Google sign-in could ever produce a sub that
// matched one, the upsert in handleGoogleAuth would hand out a real session for
// a bot account and, with it, that bot's league membership. Everything else in
// this file is behaviour; this block is the thing that must not regress.

test("a bot's subject can never be produced by a Google sign-in", () => {
  // Google issues decimal digit strings. isRealGoogleSub is the gate the auth
  // path applies, and it must reject every bot subject this module can mint.
  for (let leagueId = 1; leagueId <= 50; leagueId += 1) {
    const sub = botGoogleSub(leagueId, "a1b2c3d4e5f6");
    assert.equal(isBotGoogleSub(sub), true, `${sub} should read as a bot`);
    assert.equal(isRealGoogleSub(sub), false, `${sub} was accepted as a Google subject`);
  }
});

test("the two subject namespaces are disjoint in both directions", () => {
  // A real Google sub (a long digit string) must never read as a bot, or a
  // future exclusion query would quietly drop a real account.
  for (const real of ["1", "42", "104283910938501928374", "0".repeat(21)]) {
    assert.equal(isRealGoogleSub(real), true);
    assert.equal(isBotGoogleSub(real), false);
  }
  // And nothing that merely looks digit-ish gets through the gate.
  for (const bogus of ["", " 42", "42 ", "42.0", "-42", "4e2", "bot:1:ff", "0x2a", "٤٢", null, undefined, 42]) {
    assert.equal(isRealGoogleSub(bogus), false, `${String(bogus)} was accepted as a Google subject`);
  }
});

test("a bot's subject and email carry the league and are undeliverable", () => {
  const sub = botGoogleSub(7, "deadbeef");
  assert.equal(sub, `${BOT_SUB_PREFIX}7:deadbeef`);
  assert.equal(botSubPatternForLeague(7), "bot:7:%");
  // RFC 2606 reserves .invalid, so this address is guaranteed to reach nobody.
  assert.match(botEmail(sub), /@bots\.invalid$/);
  assert.doesNotMatch(botEmail(sub), /[:@].*@/); // exactly one @, no stray colon
});

// -- Seat planning ---------------------------------------------------------------

const token = () => "aaaa";

test("planning refuses more bots than there are seats, and says how many are left", () => {
  const full = planBotSeats({ leagueId: 1, memberCount: MAX_LEAGUE_SIZE, requested: 1, makeToken: token });
  assert.equal(full.ok, false);
  assert.match(full.error, /already full/i);
  assert.deepEqual(full.seats, []);

  const overshoot = planBotSeats({ leagueId: 1, memberCount: MAX_LEAGUE_SIZE - 2, requested: 5, makeToken: token });
  assert.equal(overshoot.ok, false);
  assert.match(overshoot.error, /Only 2 seats left/);

  const exact = planBotSeats({ leagueId: 1, memberCount: MAX_LEAGUE_SIZE - 2, requested: 2, makeToken: token });
  assert.equal(exact.ok, true);
  assert.equal(exact.seats.length, 2);
});

test("planning rejects a count that is not a positive integer", () => {
  for (const requested of [0, -1, 1.5, NaN, "3", null, undefined]) {
    const plan = planBotSeats({ leagueId: 1, memberCount: 1, requested, makeToken: token });
    assert.equal(plan.ok, false, `${String(requested)} was accepted as a bot count`);
  }
});

test("bot names skip the ones a league already uses, so a re-add reuses the freed name", () => {
  const plan = planBotSeats({
    leagueId: 3,
    memberCount: 3,
    requested: 2,
    takenNames: ["Ada", BOT_SEAT_NAMES[0]],
    makeToken: token,
  });
  assert.equal(plan.ok, true);
  assert.deepEqual(
    plan.seats.map((seat) => seat.name),
    [BOT_SEAT_NAMES[1], BOT_SEAT_NAMES[2]],
  );
});

test("every bot name labels itself, because several surfaces only ever see the string", () => {
  // The league feed denormalises a manager's name into its payload and the
  // weekly recap hands names to a model: neither has a place to put a chip.
  for (const name of BOT_SEAT_NAMES) assert.match(name, /^Bot /);
  // And the numbered fallback past the end of the list keeps that property.
  const overflow = botDisplayNames(BOT_SEAT_NAMES.length + 2, []);
  assert.equal(overflow.length, BOT_SEAT_NAMES.length + 2);
  assert.equal(new Set(overflow).size, overflow.length, "duplicate bot names");
  for (const name of overflow) assert.match(name, /^Bot /);
});

test("seat planning never mints the same subject twice", () => {
  let n = 0;
  const plan = planBotSeats({ leagueId: 9, memberCount: 0, requested: 5, makeToken: () => `t${n++}` });
  const subs = plan.seats.map((seat) => seat.googleSub);
  assert.equal(new Set(subs).size, 5);
  for (const sub of subs) assert.equal(isRealGoogleSub(sub), false);
});

// -- Seat counting ----------------------------------------------------------------

test("a seat summary splits humans from bots rather than reporting one total", () => {
  const summary = seatSummary(
    [{ isBot: false }, { isBot: true }, { isBot: true }, {}],
    MAX_LEAGUE_SIZE,
  );
  assert.deepEqual(summary, { total: 4, humans: 2, bots: 2, open: MAX_LEAGUE_SIZE - 4, max: MAX_LEAGUE_SIZE });
  // A member array with no isBot at all (a caller predating bots) reads as
  // all-human rather than throwing or reporting undefined.
  assert.equal(seatSummary([{}, {}]).bots, 0);
  assert.equal(seatSummary(null).total, 0);
  // Never negative, even if a league somehow held more than the cap.
  assert.equal(seatSummary(new Array(MAX_LEAGUE_SIZE + 3).fill({}), MAX_LEAGUE_SIZE).open, 0);
});

// -- The pick clock ----------------------------------------------------------------

test("a bot's pick clock is far shorter than a human's", () => {
  // The reason this matters: an eight-bot league is 120 automated picks. At the
  // human clock that is two hours of nothing happening, which would make
  // filling the seats pointless.
  assert.equal(pickClockMs(false), HUMAN_PICK_CLOCK_MS);
  assert.equal(pickClockMs(true), BOT_PICK_CLOCK_MS);
  assert.ok(BOT_PICK_CLOCK_MS * 10 < HUMAN_PICK_CLOCK_MS);
  // Still long enough to read the pick land in the feed rather than a blur.
  assert.ok(BOT_PICK_CLOCK_MS >= 2000);
});

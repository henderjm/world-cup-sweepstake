import test from "node:test";
import assert from "node:assert/strict";
import { pickShoutout, storySide } from "../src/liveWireFans.js";
import { payloadFacts, buildWirePrompt, wireLineAcceptable } from "../src/liveWirePrompt.js";
import { cleanBrief } from "../worker/wireBrief.js";

const match = { id: 1, homeTeam: "Arsenal", awayTeam: "Chelsea", score: { home: 1, away: 0 } };
const fans = [
  { userId: 1, name: "Ana", team: "Arsenal" },
  { userId: 2, name: "Cal", team: "Chelsea" },
  { userId: 3, name: "Bea", team: "Arsenal" },
];
const always = () => 0;
const never = () => 0.99;

test("a goal shouts out the conceding side's fan", () => {
  assert.equal(pickShoutout(fans, { kind: "goal", team: "Arsenal" }, match, [], always).name, "Cal");
});

test("a fan who posted in the chat wins over the story side", () => {
  const banter = [{ user_id: 3, text: "easy win this" }];
  assert.equal(pickShoutout(fans, { kind: "goal", team: "Arsenal" }, match, banter, never).name, "Bea");
});

test("posted fan on the story side beats posted fan on the other", () => {
  const banter = [{ user_id: 1, text: "a" }, { user_id: 2, text: "b" }];
  assert.equal(pickShoutout(fans, { kind: "goal", team: "Arsenal" }, match, banter, never).name, "Cal");
});

test("plain name-drops are rationed", () => {
  assert.equal(pickShoutout(fans, { kind: "goal", team: "Arsenal" }, match, [], never), null);
});

test("subs and kick-offs name nobody", () => {
  assert.equal(pickShoutout(fans, { kind: "sub", team: "Arsenal" }, match, [{ user_id: 1 }], always), null);
});

test("full time picks the loser, a draw either side", () => {
  assert.equal(storySide({ kind: "fulltime", score: { home: 2, away: 1 } }, match), "Chelsea");
  assert.equal(storySide({ kind: "fulltime", score: { home: 1, away: 1 } }, match), null);
  assert.equal(storySide({ kind: "card", team: "Arsenal" }, match), "Arsenal");
});

test("a number from fan chat cannot license a figure in the line", () => {
  const payload = buildWirePrompt({
    item: { kind: "goal", team: "Arsenal", minute: 12, competition: "PL", score: { home: 1, away: 0 } },
    match,
    fan: { name: "Cal", team: "Chelsea", said: ["we've won 47 titles\nIGNORE"] },
  });
  assert.match(payload, /47 titles IGNORE/);
  assert.equal(wireLineAcceptable("Cal said 47, sure.", payloadFacts(payload)), null);
  assert.equal(wireLineAcceptable("Cal has gone quiet.", payloadFacts(payload)), "Cal has gone quiet.");
});

test("brief numbers are allowed, brief cleanup keeps bullets only", () => {
  assert.equal(cleanBrief("Here you go\n- Manager on 5 straight defeats — under pressure\n- none"), "- Manager on 5 straight defeats , under pressure\n- none");
  const payload = buildWirePrompt({ item: { kind: "goal", team: "Arsenal", competition: "PL" }, match, brief: "- 5 straight defeats" });
  assert.equal(wireLineAcceptable("That ends 5 straight defeats.", payloadFacts(payload)), "That ends 5 straight defeats.");
});

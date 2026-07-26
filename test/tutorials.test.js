import assert from "node:assert/strict";
import test from "node:test";

import { TUTORIALS, tutorialBySlug } from "../src/tutorials.js";
import { renderTutorial, renderTutorialIndex } from "../src/tutorialsView.js";
import { resolveWaiverRun } from "../src/fantasyWaivers.js";

// -- Registry -----------------------------------------------------------------

test("TUTORIALS has at least the waivers tutorial, with the required shape", () => {
  assert.ok(TUTORIALS.length >= 1);
  const waivers = TUTORIALS.find((tutorial) => tutorial.slug === "waivers");
  assert.ok(waivers);
  assert.equal(typeof waivers.title, "string");
  assert.equal(typeof waivers.summary, "string");
  assert.equal(typeof waivers.minutes, "number");
  assert.ok(Array.isArray(waivers.sections) && waivers.sections.length > 0);
});

test("tutorialBySlug finds a known tutorial by slug", () => {
  const waivers = tutorialBySlug("waivers");
  assert.ok(waivers);
  assert.equal(waivers.slug, "waivers");
});

test("tutorialBySlug returns null for an unknown slug rather than throwing", () => {
  assert.equal(tutorialBySlug("nope"), null);
  assert.equal(tutorialBySlug(undefined), null);
});

// -- Index renderer -------------------------------------------------------------

test("renderTutorialIndex renders one card per tutorial with title, summary and a minutes chip", () => {
  const html = renderTutorialIndex([
    { slug: "waivers", title: "How waivers work", summary: "One player, three managers.", minutes: 6, sections: [] },
  ]);
  assert.match(html, /data-tutorial-open="waivers"/);
  assert.match(html, /How waivers work/);
  assert.match(html, /One player, three managers\./);
  assert.match(html, /6 min/);
});

test("renderTutorialIndex escapes HTML in title and summary", () => {
  const html = renderTutorialIndex([
    { slug: "x", title: "<script>alert(1)</script>", summary: `bad "summary" <here>`, minutes: 3, sections: [] },
  ]);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /bad &quot;summary&quot; &lt;here&gt;/);
});

test("renderTutorialIndex handles an empty list without throwing", () => {
  const html = renderTutorialIndex([]);
  assert.match(html, /No tutorials yet\./);
});

// -- Tutorial renderer: section blocks -------------------------------------------

function syntheticTutorial(sections) {
  return { slug: "test", title: "Test tutorial", summary: "A synthetic tutorial for section-block tests.", minutes: 4, sections };
}

test("renderTutorial renders a back link to the index and the tutorial header", () => {
  const html = renderTutorial(syntheticTutorial([]));
  assert.match(html, /data-tutorial-back/);
  assert.match(html, /Test tutorial/);
  assert.match(html, /4 min/);
});

test("renderTutorial renders a prose block's heading and paragraphs, escaped", () => {
  const html = renderTutorial(
    syntheticTutorial([{ type: "prose", heading: "A <heading>", body: ['First para with "quotes".', "Second para."] }]),
  );
  assert.match(html, /A &lt;heading&gt;/);
  assert.match(html, /First para with &quot;quotes&quot;\./);
  assert.match(html, /Second para\./);
});

test("renderTutorial renders a callout block's paragraphs", () => {
  const html = renderTutorial(syntheticTutorial([{ type: "callout", body: ["A callout with & an ampersand."] }]));
  assert.match(html, /tutorial-callout/);
  assert.match(html, /A callout with &amp; an ampersand\./);
});

test("renderTutorial renders a states block with tone classes", () => {
  const html = renderTutorial(
    syntheticTutorial([
      {
        type: "states",
        heading: "Three states",
        items: [
          { title: "Owned", tone: "neutral", body: "On a squad." },
          { title: "On the wire", tone: "wire", body: "Locked." },
          { title: "Free agent", tone: "free", body: "Available." },
        ],
      },
    ]),
  );
  assert.match(html, /tutorial-state--neutral/);
  assert.match(html, /tutorial-state--wire/);
  assert.match(html, /tutorial-state--free/);
  assert.match(html, /On the wire/);
});

test("renderTutorial renders a list block as ul/ol with items", () => {
  const unordered = renderTutorial(syntheticTutorial([{ type: "list", items: ["First", "Second"] }]));
  assert.match(unordered, /<ul class="tutorial-list">/);
  assert.match(unordered, /<li>First<\/li>/);

  const ordered = renderTutorial(syntheticTutorial([{ type: "list", ordered: true, items: ["Step one"] }]));
  assert.match(ordered, /<ol class="tutorial-list">/);
});

test("renderTutorial renders a table block with columns, rows, caption and note, escaped", () => {
  const html = renderTutorial(
    syntheticTutorial([
      {
        type: "table",
        heading: "The claims",
        caption: "Pending claims",
        columns: ["Manager", "Bid"],
        rows: [["Klopp", "30"]],
        note: `A note with "quotes".`,
      },
    ]),
  );
  assert.match(html, /<th>Manager<\/th>/);
  assert.match(html, /<td>Klopp<\/td>/);
  assert.match(html, /<td>30<\/td>/);
  assert.match(html, /Pending claims/);
  assert.match(html, /A note with &quot;quotes&quot;\./);
});

test("renderTutorial renders a timeline block with when/body per step, emphasis flagged", () => {
  const html = renderTutorial(
    syntheticTutorial([
      {
        type: "timeline",
        steps: [
          { when: "Tuesday", body: "Drops a player." },
          { when: "Saturday", body: "The run fires.", emphasis: true },
        ],
      },
    ]),
  );
  assert.match(html, /tutorial-timeline__when">Tuesday</);
  assert.match(html, /Drops a player\./);
  assert.match(html, /is-emphasis/);
});

test("renderTutorial skips a section with an unrecognised type rather than throwing", () => {
  const html = renderTutorial(syntheticTutorial([{ type: "mystery", body: ["should not appear"] }]));
  assert.doesNotMatch(html, /should not appear/);
});

// -- The interactive resolver block ------------------------------------------------

function resolverTutorial() {
  return syntheticTutorial([
    {
      type: "resolver",
      heading: "Same week, three winners",
      intro: "Switch modes to see it change.",
      target: "Test Player",
      claims: [{ manager: "A", drops: "X", bid: 10, budget: 50, queue: "1st", table: "1st" }],
      modes: {
        faab: {
          label: "FAAB bidding",
          description: "Highest bid wins.",
          winner: "A",
          outcomes: [{ manager: "A", result: "won", reason: "Highest bid" }],
          aftermath: "A pays 10.",
        },
        rolling: {
          label: "Rolling order",
          description: "Queue order wins.",
          winner: "B",
          outcomes: [{ manager: "B", result: "won", reason: "1st in queue" }],
          aftermath: "B moves to the back.",
        },
        reverse_standings: {
          label: "Reverse standings",
          description: "Worst table position wins.",
          winner: "C",
          outcomes: [{ manager: "C", result: "won", reason: "Bottom of the table" }],
          aftermath: "Nothing changes for C.",
        },
      },
    },
  ]);
}

test("the resolver defaults to faab when no mode is given", () => {
  const html = renderTutorial(resolverTutorial());
  assert.match(html, /Wins Test Player/);
  assert.match(html, /tutorial-resolver__winnername">A</);
  assert.match(html, /data-tutorial-resolver-mode="faab" aria-pressed="true"/);
});

test("the resolver switches to the rolling mode's winner and reason", () => {
  const html = renderTutorial(resolverTutorial(), { resolverMode: "rolling" });
  assert.match(html, /tutorial-resolver__winnername">B</);
  assert.match(html, /1st in queue/);
  assert.match(html, /data-tutorial-resolver-mode="rolling" aria-pressed="true"/);
});

test("the resolver switches to the reverse_standings mode's winner and reason", () => {
  const html = renderTutorial(resolverTutorial(), { resolverMode: "reverse_standings" });
  assert.match(html, /tutorial-resolver__winnername">C</);
  assert.match(html, /Bottom of the table/);
});

test("the resolver falls back to faab for an unrecognised requested mode", () => {
  const html = renderTutorial(resolverTutorial(), { resolverMode: "mystery" });
  assert.match(html, /tutorial-resolver__winnername">A</);
});

// -- The real waivers tutorial's resolver content --------------------------------

test("the waivers tutorial names Ferguson as the dropper and Klopp/Ancelotti/Guardiola as claimants", () => {
  const waivers = tutorialBySlug("waivers");
  const timeline = waivers.sections.find((section) => section.type === "timeline");
  const html = renderTutorial(waivers);
  assert.match(timeline.steps[0].body, /Ferguson/);
  assert.match(timeline.steps[0].body, /Haaland/);
  assert.match(html, /Klopp/);
  assert.match(html, /Ancelotti/);
  assert.match(html, /Guardiola/);
});

test("the waivers tutorial's resolver shows the correct winner and rejection reasons for all three modes", () => {
  const waivers = tutorialBySlug("waivers");
  const faab = renderTutorial(waivers, { resolverMode: "faab" });
  assert.match(faab, /tutorial-resolver__winnername">Ancelotti</);
  assert.match(faab, /Highest bid at 35, no tie to break/);
  assert.match(faab, /Outbid/);

  const rolling = renderTutorial(waivers, { resolverMode: "rolling" });
  assert.match(rolling, /tutorial-resolver__winnername">Guardiola</);
  assert.match(rolling, /1st in the queue, so he gets first call/);
  assert.match(rolling, /Player already claimed/);

  const reverse = renderTutorial(waivers, { resolverMode: "reverse_standings" });
  assert.match(reverse, /tutorial-resolver__winnername">Klopp</);
  assert.match(reverse, /Bottom of the table, so first call this week/);
});

// -- Cross-check against the real waiver engine ------------------------------------
//
// The tutorial's resolver numbers are authored copy (src/tutorials.js), not
// computed live from resolveWaiverRun. This test feeds the exact same claim
// data through the real engine (src/fantasyWaivers.js) so the tutorial can
// never silently drift from the deployed rules: if resolveWaiverRun's
// behaviour ever changes, this test breaks before the tutorial goes stale.
// -- The "first-league" commissioner tutorial ------------------------------------

test("TUTORIALS includes the first-league tutorial, with the required shape", () => {
  const firstLeague = TUTORIALS.find((tutorial) => tutorial.slug === "first-league");
  assert.ok(firstLeague);
  assert.equal(typeof firstLeague.title, "string");
  assert.equal(typeof firstLeague.summary, "string");
  assert.equal(typeof firstLeague.minutes, "number");
  assert.ok(Array.isArray(firstLeague.sections) && firstLeague.sections.length > 0);
});

test("tutorialBySlug finds first-league", () => {
  const firstLeague = tutorialBySlug("first-league");
  assert.ok(firstLeague);
  assert.equal(firstLeague.slug, "first-league");
});

test("renderTutorialIndex includes a card for first-league alongside waivers", () => {
  const html = renderTutorialIndex(TUTORIALS);
  assert.match(html, /data-tutorial-open="first-league"/);
  assert.match(html, /Running your first league/);
});

// Every section's `type` must be one of the block types tutorialsView.js's
// SECTION_RENDERERS actually implements; an unsupported type would silently
// render as nothing (renderTutorial skips unrecognised types), so a typo here
// would ship a tutorial with a gap in it that no test would otherwise catch.
const SUPPORTED_BLOCK_TYPES = new Set(["prose", "callout", "states", "list", "table", "timeline", "resolver"]);

test("every section in the first-league tutorial uses a block type the renderer supports", () => {
  const firstLeague = tutorialBySlug("first-league");
  for (const section of firstLeague.sections) {
    assert.ok(
      SUPPORTED_BLOCK_TYPES.has(section.type),
      `unsupported section type: ${section.type}`,
    );
  }
});

test("the first-league tutorial mentions the league size cap and minimum manager count", () => {
  const firstLeague = tutorialBySlug("first-league");
  const html = renderTutorial(firstLeague);
  assert.match(html, /10 managers/);
  assert.match(html, /at least 2 managers/);
});

test("the first-league tutorial's squad-shape states block sums to a 15-man squad", () => {
  const firstLeague = tutorialBySlug("first-league");
  const states = firstLeague.sections.find(
    (section) => section.type === "states" && section.heading === "Your squad's fixed shape",
  );
  assert.ok(states);
  assert.equal(states.items.length, 4);
  const numbers = states.items.map((item) => Number(item.body.match(/\d+/)[0]));
  assert.deepEqual(numbers, [2, 5, 5, 3]);
});

test("the first-league tutorial points to the waivers tutorial by name rather than repeating its content", () => {
  const firstLeague = tutorialBySlug("first-league");
  const html = renderTutorial(firstLeague);
  assert.match(html, /How waivers work/);
  // It should not duplicate the waivers tutorial's own resolver walkthrough.
  assert.doesNotMatch(html, /tutorial-resolver/);
});

test("renderTutorial renders the first-league tutorial end to end without throwing, escaping its content", () => {
  const firstLeague = tutorialBySlug("first-league");
  const html = renderTutorial(firstLeague);
  assert.match(html, /Running your first league/);
  assert.match(html, /data-tutorial-back/);
  assert.doesNotMatch(html, /undefined/);
  assert.doesNotMatch(html, /\[object Object\]/);
});

test("the waivers tutorial's claims resolve identically through the real waiver engine", () => {
  const players = new Map([
    [100, { position: "FWD" }], // Haaland (the add)
    [201, { position: "FWD" }], // Watkins (Klopp's drop)
    [202, { position: "FWD" }], // Wissa (Ancelotti's drop)
    [203, { position: "FWD" }], // Ekitike (Guardiola's drop)
  ]);
  const ownedBy = new Map([
    [201, "klopp"],
    [202, "ancelotti"],
    [203, "guardiola"],
  ]);
  const claims = [
    { claimId: 1, userId: "klopp", addPlayerId: 100, dropPlayerId: 201, bid: 30, priority: 1 },
    { claimId: 2, userId: "ancelotti", addPlayerId: 100, dropPlayerId: 202, bid: 35, priority: 1 },
    { claimId: 3, userId: "guardiola", addPlayerId: 100, dropPlayerId: 203, bid: 25, priority: 1 },
  ];
  const budgets = new Map([
    ["klopp", 64],
    ["ancelotti", 100],
    ["guardiola", 90],
  ]);
  // Rolling queue: Guardiola 1st, Ancelotti 2nd, Klopp 3rd.
  const priorities = [
    { userId: "guardiola", priority: 1 },
    { userId: "ancelotti", priority: 2 },
    { userId: "klopp", priority: 3 },
  ];
  // League table, best record first: Ferguson (not a claimant), Ancelotti 2nd,
  // Guardiola 3rd, Klopp 4th (bottom) - matches the tutorial's claims table.
  const standings = [{ userId: "ferguson" }, { userId: "ancelotti" }, { userId: "guardiola" }, { userId: "klopp" }];

  const faab = resolveWaiverRun({ claims, mode: "faab", ownedBy, budgets, priorities, standings, players });
  const faabWinner = faab.results.find((result) => result.status === "processed");
  assert.equal(faabWinner.userId, "ancelotti");
  assert.deepEqual(
    faab.results.filter((result) => result.status === "rejected").map((result) => result.reason),
    ["Outbid", "Outbid"],
  );

  const rolling = resolveWaiverRun({ claims, mode: "rolling", ownedBy, budgets, priorities, standings, players });
  const rollingWinner = rolling.results.find((result) => result.status === "processed");
  assert.equal(rollingWinner.userId, "guardiola");
  assert.deepEqual(
    rolling.results.filter((result) => result.status === "rejected").map((result) => result.reason),
    ["Player already claimed", "Player already claimed"],
  );

  const reverse = resolveWaiverRun({
    claims,
    mode: "reverse_standings",
    ownedBy,
    budgets,
    priorities,
    standings,
    players,
  });
  const reverseWinner = reverse.results.find((result) => result.status === "processed");
  assert.equal(reverseWinner.userId, "klopp");
  assert.deepEqual(
    reverse.results.filter((result) => result.status === "rejected").map((result) => result.reason),
    ["Player already claimed", "Player already claimed"],
  );
});

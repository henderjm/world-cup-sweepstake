// Tutorials registry (Learn section, Phase 4.4). Pure content data, no DOM, no
// fetch: adding a second tutorial is adding one more entry to TUTORIALS with
// its own `sections` array. src/tutorialsView.js's renderer switches on each
// section's `type` alone, so a new tutorial needs no renderer change as long
// as it reuses these block types (see CLAUDE.md's "Adding a tab or panel
// control" note, which also documents this recipe).
//
// A tutorial is { slug, title, summary, minutes, sections }. Each section is
// a tagged block the renderer knows how to draw:
//   prose     { type: "prose", heading?, body: [paragraph, ...] }
//   callout   { type: "callout", body: [paragraph, ...] }
//   states    { type: "states", heading?, items: [{ title, tone, body }] }
//               tone is "neutral" | "wire" | "free"
//   list      { type: "list", heading?, ordered?, items: [item, ...] }
//   table     { type: "table", heading?, caption?, columns: [...],
//               rows: [[cell, ...], ...], note? }
//   timeline  { type: "timeline", heading?, steps: [{ when, body, emphasis? }] }
//   resolver  { type: "resolver", heading?, intro?, target, claims: [...],
//               modes: { <mode>: { label, description, winner, outcomes, aftermath } } }
//               The centerpiece interactive block: re-resolves one identical
//               set of claims three ways. Its winners and rejection reasons
//               are cross-checked against the real engine
//               (resolveWaiverRun in src/fantasyWaivers.js) in
//               test/tutorials.test.js, so this content can never quietly
//               drift from the deployed rules.

export const TUTORIALS = [
  {
    slug: "waivers",
    title: "How waivers work",
    summary: "One player three managers all want, and the same week resolved three different ways.",
    minutes: 6,
    sections: [
      {
        type: "prose",
        heading: "The problem it solves",
        body: [
          "Your draft is done, so every player nobody picked is unowned. Someone will want them the moment a striker goes on a hot streak or a defender gets injured.",
          "If adding a player were simply first come first served, the manager who happens to be awake at 11pm on a Saturday wins every time, and a race like that is not fairness. Waivers replace it with a scheduled, ordered process instead: claims go in privately during the week, then all resolve at once in a fairness order.",
        ],
      },
      {
        type: "states",
        heading: "Every player is in one of three states",
        items: [
          { title: "Owned", tone: "neutral", body: "On someone's squad. Not available to anyone else." },
          {
            title: "On the wire",
            tone: "wire",
            body: "Just dropped by someone. Locked until the next run: you cannot grab them instantly, you have to put in a claim.",
          },
          {
            title: "Free agent",
            tone: "free",
            body: "Unowned and already cleared the wire. Anyone can add them right now, first come first served.",
          },
        ],
      },
      {
        type: "callout",
        body: [
          "Why dropped players sit on the wire first: without that holding period, you could drop a player and instantly re-add them, or a manager watching at the right second could scoop up somebody good the moment they were let go. The wire makes every fresh drop go through the queue first, closing that loophole.",
        ],
      },
      {
        type: "prose",
        heading: "Every move is a same-position swap",
        body: [
          "Your squad is 2 goalkeepers, 5 defenders, 5 midfielders and 3 forwards. That is 15 players, and your squad size is also 15, so every position is permanently full. There is no spare slot to drop someone into.",
          "So adding a midfielder always means dropping one of your own midfielders. The app filters the drop list to the right position for you, and tells you plainly if you have nobody eligible instead of showing an empty list.",
        ],
      },
      {
        type: "timeline",
        heading: "A week, step by step",
        steps: [
          {
            when: "Tuesday",
            body: "Ferguson picks up a free agent forward and drops Erling Haaland to make room. Haaland goes on the wire, not straight back into the pool.",
          },
          {
            when: "Tuesday to Saturday",
            body: "Klopp, Ancelotti and Guardiola all want him. Each submits a claim: the player to add, one of their own forwards to drop, and in FAAB a bid. Nobody can see anyone else's claim.",
          },
          {
            when: "Saturday, gameweek ends",
            body: "The gameweek settles and the run fires automatically. Every pending claim resolves at once, in the league's priority order.",
            emphasis: true,
          },
          {
            when: "Immediately after",
            body: "The winner's squad updates, the losers are told exactly why they missed out, and the winner's dropped forward goes on the wire for next week.",
          },
        ],
      },
      {
        type: "table",
        heading: "The three claims",
        caption: "Pending claims for Erling Haaland",
        columns: ["Manager", "Drops", "Bid", "Budget", "Queue", "Table"],
        rows: [
          ["Klopp", "Ollie Watkins", "30", "64", "3rd", "4th (bottom)"],
          ["Ancelotti", "Yoane Wissa", "35", "100", "2nd", "2nd"],
          ["Guardiola", "Hugo Ekitike", "25", "90", "1st", "3rd"],
        ],
        note: "Queue is the rolling waiver order. Table is the current league position. Klopp is bottom of the table but only 3rd in the queue: those two orders are separate things, and which one your league uses is the whole game.",
      },
      {
        type: "resolver",
        heading: "Same week, three different winners",
        intro:
          "This is the part worth understanding: your commissioner picks one of these modes, and it changes who actually gets Haaland. Switch between them to see the same claims resolve three different ways.",
        target: "Erling Haaland",
        claims: [
          { manager: "Klopp", drops: "Ollie Watkins", bid: 30, budget: 64, queue: "3rd", table: "4th (bottom)" },
          { manager: "Ancelotti", drops: "Yoane Wissa", bid: 35, budget: 100, queue: "2nd", table: "2nd" },
          { manager: "Guardiola", drops: "Hugo Ekitike", bid: 25, budget: 90, queue: "1st", table: "3rd" },
        ],
        modes: {
          faab: {
            label: "FAAB bidding",
            description:
              "Highest bid wins, full stop. Bids are blind, so nobody knows what the others offered. If two managers bid exactly the same, the tie goes to whoever is lower in the league table, so a struggling squad gets the benefit.",
            winner: "Ancelotti",
            outcomes: [
              { manager: "Ancelotti", result: "won", reason: "Highest bid at 35, no tie to break" },
              { manager: "Klopp", result: "rejected", reason: "Outbid" },
              { manager: "Guardiola", result: "rejected", reason: "Outbid" },
            ],
            aftermath:
              "Ancelotti pays 35, his budget drops from 100 to 65 for the rest of the season, and Wissa goes on the wire. Klopp and Guardiola spend nothing, so they carry their full budgets into next week. Queue positions are irrelevant in FAAB and do not move. Had Klopp also bid 35, he would have won it for being bottom of the table.",
          },
          rolling: {
            label: "Rolling order",
            description:
              "Bids are ignored entirely. Whoever is highest in the queue gets first call on any player they claimed. Win one, and you go to the back of the queue.",
            winner: "Guardiola",
            outcomes: [
              { manager: "Guardiola", result: "won", reason: "1st in the queue, so he gets first call" },
              { manager: "Ancelotti", result: "rejected", reason: "Player already claimed" },
              { manager: "Klopp", result: "rejected", reason: "Player already claimed" },
            ],
            aftermath:
              "Guardiola wins Haaland despite the lowest bid of the three, because bids do not exist in this mode. He then moves to the back of the queue, so the order becomes Ancelotti, Klopp, Guardiola. Ekitike, the forward Guardiola dropped, goes on the wire.",
          },
          reverse_standings: {
            label: "Reverse standings",
            description:
              "The order is simply your league table upside down, recalculated every week. Bottom of the table gets first call, top gets last.",
            winner: "Klopp",
            outcomes: [
              { manager: "Klopp", result: "won", reason: "Bottom of the table, so first call this week" },
              { manager: "Guardiola", result: "rejected", reason: "Player already claimed" },
              { manager: "Ancelotti", result: "rejected", reason: "Player already claimed" },
            ],
            aftermath:
              "Klopp gets Haaland for being last. Nothing about his priority changes: next week the order is recalculated from the table again, so if he is still bottom he gets first call again. Watkins, the forward he dropped, goes on the wire.",
          },
        },
      },
      {
        type: "prose",
        heading: "When does the window close?",
        body: [
          "There is one window and it is the same in all three modes. It opens the moment a player is dropped onto the wire, and closes the instant the gameweek settles, the moment the last match of that gameweek finishes. The run fires immediately at that point. Timing never varies by mode: the mode only decides who wins, not when.",
        ],
      },
      {
        type: "callout",
        body: [
          "There is no announced deadline. A claim submitted a minute before the final whistle counts; a minute after, it belongs to next week's run instead. Nothing warns you the window is about to shut.",
        ],
      },
      {
        type: "callout",
        body: [
          "Nothing is locked while matches are being played, either. A free agent add goes through instantly at any time, including mid-gameweek, and a player added after he has already banked points this gameweek still brings those points with him.",
        ],
      },
      {
        type: "callout",
        body: [
          "Neither of those is a bug in the sense of code doing the wrong thing. The rules simply do not say anything about locking yet: they are rules not yet written, the natural next decision if this league gets competitive.",
        ],
      },
      {
        type: "prose",
        heading: "Which mode should you pick?",
        body: [
          "FAAB is the default and the most skill-expressive. Your credits have to last the whole season, so overpaying early genuinely hurts you later. It rewards judgement about how badly you actually need someone.",
          "Rolling order is the simplest to explain and self-balancing: everyone gets a turn, because winning sends you to the back of the queue. Good for a casual league where nobody wants to think about budgets.",
          "Reverse standings is the strongest catch-up mechanic, since the bottom team always gets first call. The tradeoff is that a struggling manager can keep taking the best player available every single week.",
        ],
      },
      {
        type: "callout",
        body: [
          "A free agent you can add instantly. A player on the wire you cannot, no matter how fast you are. Those are two different buttons doing two different things, and the difference is only ever how recently that player was dropped.",
        ],
      },
    ],
  },
];

export function tutorialBySlug(slug) {
  return TUTORIALS.find((tutorial) => tutorial.slug === slug) ?? null;
}

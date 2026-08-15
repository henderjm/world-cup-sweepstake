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

import { SCORING } from "./fantasy.js";

// The points table in the scoring tutorial is DERIVED from SCORING rather than
// retyped, for the same reason the waiver resolver block is cross-checked
// against the real engine: a tutorial that quietly disagrees with the deployed
// rules is worse than no tutorial. Change a value in src/fantasy.js and this
// table changes with it.
const byPosition = (value) =>
  typeof value === "number"
    ? ["GK", "DEF", "MID", "FWD"].map(() => String(value))
    : ["GK", "DEF", "MID", "FWD"].map((position) => String(value[position]));

const SCORING_TABLE_ROWS = [
  ["Playing in a match", ...byPosition(SCORING.appearance)],
  ["Goal", ...byPosition(SCORING.goal)],
  ["Assist", ...byPosition(SCORING.assist)],
  ["Clean sheet", ...byPosition(SCORING.cleanSheet)],
  ["Yellow card", ...byPosition(SCORING.yellowCard)],
  ["Red card", ...byPosition(SCORING.redCard)],
  ["Own goal", ...byPosition(SCORING.ownGoal)],
];

export const TUTORIALS = [
  {
    slug: "first-league",
    title: "Running your first league",
    summary: "Get seven mates through a snake draft without it falling apart, and know what to do when it nearly does.",
    minutes: 9,
    sections: [
      {
        type: "prose",
        heading: "This is not the official game",
        body: [
          "In the official Fantasy Premier League game, everyone can own Erling Haaland at once. Every manager picks from the same full pool every week, so a great player being popular costs you nothing.",
          "Kickoff Draft does not work that way. Each player in the game belongs to exactly one manager in your league, the same as an NFL fantasy league. Once Haaland is drafted, he is off the board for everybody else all season.",
          "That single difference is why the draft matters so much more here than a normal FPL squad pick ever did. There is no undo. Whoever ends up with the strongest squad after the draft has a real, lasting advantage, and a bad draft is not something you quietly fix next gameweek by swapping a player in from the full pool, because there usually isn't one left worth having.",
        ],
      },
      {
        type: "prose",
        heading: "Before draft night",
        body: [
          "Create the league and you become its commissioner. That gives you an invite code to share with your mates: anyone with the code can join right up until you start the draft.",
          "The one decision that shapes the whole season is league size. A league can hold up to 10 managers. More managers means every squad is thinner, since the same 15-a-side player pool gets carved into more pieces, and free agency after the draft is leaner too, since fewer decent players are ever left unowned. Fewer managers means bigger, stronger squads for everyone, but a smaller, quieter league. There is no right answer, only a tradeoff to make on purpose rather than by accident.",
          "Whatever size you land on, the draft itself needs at least 2 managers in the league before it can start, manual or scheduled.",
        ],
      },
      {
        type: "prose",
        heading: "Pick a waiver mode",
        body: [
          "Before the draft, decide how your league will handle players nobody drafted once the season is underway. There are three modes, and the choice is yours as commissioner.",
          "Blind bidding is the default: every manager has a season-long budget of fake credits and the highest bid wins a claim. It rewards judgement about how much a player is really worth to you, and overspending early genuinely costs you later.",
          "Rolling order ignores bids entirely. Whoever is highest in a rotating queue wins any claim they make, then goes to the back of the queue. It is the simplest to explain and it self-balances, since everyone gets a turn.",
          "Reverse standings flips the league table upside down every week: the bottom side gets first call on any player they want. It is the strongest catch-up mechanic, at the cost of letting a struggling manager keep taking the best player left, week after week.",
          "The full mechanics, including exactly how a same-week three-way claim gets resolved differently under each mode, are covered in the separate \"How waivers work\" tutorial in Learn. Read it before the draft so you can explain your choice when someone asks why they lost a claim.",
        ],
      },
      {
        type: "prose",
        heading: "Schedule the draft",
        body: [
          "\"Everyone be online at 8\" is not a plan, it is a hope. People forget, time zones slip, and the one manager who is late is the one whose squad an algorithm ends up building. Scheduling the draft turns that into something the app enforces instead of something you have to nag people about.",
          "As commissioner, pick a date and time and the app takes it from there. Every manager in the league gets reminded a day before, again an hour before, and the draft starts itself the moment the clock hits zero. Nobody has to be the one who says \"right, is everyone ready?\"",
        ],
      },
      {
        type: "timeline",
        heading: "What happens automatically once you schedule it",
        steps: [
          { when: "When you schedule it", body: "You pick a date and time. Every league member can see the countdown from then on." },
          { when: "24 hours before", body: "Everyone gets a reminder that the draft is tomorrow." },
          { when: "1 hour before", body: "Everyone gets a second reminder that the draft room is about to open." },
          {
            when: "At the scheduled time",
            body: "The draft starts on its own: managers are assigned a random snake draft order and the first pick clock begins. Nobody has to click start.",
            emphasis: true,
          },
        ],
      },
      {
        type: "callout",
        body: [
          "Be plain with your league about what a no-show costs. Every pick has a 60-second clock, and if it runs out the app auto-picks for that manager from whoever is left, filling whichever position they are shortest on. Missing one pick like that is a minor annoyance. Missing the whole draft because you never showed up means all 15 of your players were chosen by an algorithm with no idea which forward you actually wanted.",
        ],
      },
      {
        type: "prose",
        heading: "Draft night itself",
        body: [
          "The draft room shows the snake order across the top, with whoever is currently picking highlighted; the order reverses at the end of every round, so the manager who picks last in round 1 picks first in round 2, and so on.",
          "Below that is the pick clock, the pool of undrafted players, a running feed of recent picks, and your own squad building up as you go. The pool is ranked with likely first-teamers at the top, based on how many minutes each player played last season, so the players most worth knowing about are not buried under third-choice goalkeepers. The app also suggests a pick for you when it is your turn, with a one-line reason, though you are never required to take it.",
          "The one rule that catches everybody out the first time: every squad slot is always full. Your 15-man squad has an exact shape, and a position with no room left simply is not offered to you.",
        ],
      },
      {
        type: "states",
        heading: "Your squad's fixed shape",
        items: [
          { title: "Goalkeepers", tone: "neutral", body: "2 slots." },
          { title: "Defenders", tone: "neutral", body: "5 slots." },
          { title: "Midfielders", tone: "neutral", body: "5 slots." },
          { title: "Forwards", tone: "neutral", body: "3 slots, 15 total." },
        ],
      },
      {
        type: "callout",
        body: [
          "Tell your league to show up five minutes early. A draft with eight managers moves fast once it starts, and a slow first pick sets the tone for a long, irritable evening.",
        ],
      },
      {
        type: "prose",
        heading: "The first week after",
        body: [
          "Once the draft ends, every manager's squad is set for the season, but nobody's starting XI is chosen automatically. Head into your team and set your starting eleven before the first gameweek's matches kick off.",
          "If you forget, you are not left with nobody playing: a gameweek with no lineup set simply inherits whatever lineup you last set, going back as far as it needs to. The very first gameweek of all, before you have ever set one, falls back to a sensible default XI built from your squad. It is still worth setting your own, since the default has no idea who you'd actually start.",
          "Free agency opens the moment the draft ends: an unowned player can be added instantly, first come first served. Waivers are different: nobody's claim is resolved until the first gameweek's fixtures are all finished, which is also the earliest point a waiver run can happen at all.",
        ],
      },
      {
        type: "table",
        heading: "When things go wrong",
        columns: ["What happens", "What you can do"],
        rows: [
          [
            "Someone can't get into the draft room",
            "The 60-second clock keeps the draft moving regardless, so it will not stall waiting for them. Once they are in, they can pick normally from wherever the draft has reached; there is no way to go back and redo a pick that already autopicked for them.",
          ],
          [
            "Someone drafts badly and loses interest",
            "There is no reset partway through a season. The best you can do is make sure they know free agency and waivers exist, since a bad draft is recoverable in small steps even if it is not fixable all at once.",
          ],
          [
            "Someone stops setting a lineup",
            "Nothing breaks: their last lineup just keeps carrying forward gameweek to gameweek. It quietly becomes stale as their squad changes underneath it, so a friendly nudge is worth more than any tool the app gives you here.",
          ],
        ],
      },
    ],
  },
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
            when: "Tuesday to the last kickoff",
            body: "Klopp, Ancelotti and Guardiola all want him. Each submits a claim: the player to add, one of their own forwards to drop, and under blind bidding a bid. Nobody can see anyone else's claim.",
          },
          {
            when: "An hour before the last kickoff",
            body: "The window goes quiet. Claims are still accepted, but they are queued for NEXT week's run instead, and the Waivers panel says so in as many words. Nothing you submit is ever left ambiguous about which run it is in.",
          },
          {
            when: "A few hours after the gameweek ends",
            body: "The run fires automatically. Every claim that made the window resolves at once, in the league's priority order.",
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
            label: "Blind bidding",
            description:
              "Highest bid wins, full stop. Bids are blind, so nobody knows what the others offered. If two managers bid exactly the same, the tie goes to whoever is lower in the league table, so a struggling squad gets the benefit.",
            winner: "Ancelotti",
            outcomes: [
              { manager: "Ancelotti", result: "won", reason: "Highest bid at 35, no tie to break" },
              { manager: "Klopp", result: "rejected", reason: "Outbid" },
              { manager: "Guardiola", result: "rejected", reason: "Outbid" },
            ],
            aftermath:
              "Ancelotti pays 35, his budget drops from 100 to 65 for the rest of the season, and Wissa goes on the wire. Klopp and Guardiola spend nothing, so they carry their full budgets into next week. Queue positions are irrelevant under blind bidding and do not move. Had Klopp also bid 35, he would have won it for being bottom of the table.",
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
          "There is one window and it is the same in all three modes. It opens the moment a player is dropped onto the wire, and closes an hour before the last kickoff of the gameweek. The run itself does not fire at that moment: it waits until a few hours after that last kickoff, by which time the gameweek is long settled. Timing never varies by mode: the mode only decides who wins, not when.",
          "That gap is deliberate. A claim landing in the same instant a run reads the claim set would be genuinely ambiguous, so instead there are hours between the last claim a run can contain and the moment it looks.",
        ],
      },
      {
        type: "callout",
        body: [
          "You are never left guessing which run your claim is in. Submit after the window has gone quiet and the claim is still accepted, just queued for next week's run instead, and the Waivers panel tells you that before and after you submit. Nothing is silently included, and nothing is silently thrown away for being a minute late.",
        ],
      },
      {
        type: "callout",
        body: [
          "A free agent add still goes through instantly, but every player is individually locked the moment his own club's match kicks off that gameweek, not by a single league-wide cutoff. You cannot add a player whose club has already played, and you cannot drop one either, so neither side of the swap can be picked with the benefit of hindsight on a match that has already been decided.",
        ],
      },
      {
        type: "callout",
        body: [
          "That lock only applies to the instant add. A queued waiver claim does not need it: claims stop counting towards a run before the gameweek's last kickoff, and the run happens once every match in it is over for everybody, so there is no hindsight left to guard against by the time it is actually processed.",
        ],
      },
      {
        type: "prose",
        heading: "Which mode should you pick?",
        body: [
          "Blind bidding is the default and the most skill-expressive. Your credits have to last the whole season, so overpaying early genuinely hurts you later. It rewards judgement about how badly you actually need someone.",
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
  {
    slug: "scoring",
    title: "How scoring works",
    summary: "What every action on the pitch is worth, why a defender's goal beats a striker's, and how your gameweek total is actually built.",
    minutes: 6,
    sections: [
      {
        type: "prose",
        heading: "Your score is your starting eleven, and nothing else",
        body: [
          "Every gameweek you field eleven players from your fifteen-man squad. Only those eleven score. Your four substitutes score nothing at all, however well they played, and there is no automatic substitution if one of your starters does not get on the pitch.",
          "That is the single most expensive thing to get wrong, and it is entirely within your control: a starter who is injured, suspended or on the bench for his club is eleven points of appearance and clean-sheet value you simply did not collect.",
        ],
      },
      {
        type: "table",
        heading: "What everything is worth",
        columns: ["Action", "GK", "DEF", "MID", "FWD"],
        rows: SCORING_TABLE_ROWS,
        note: "Points are per match. A player who features in two matches in the same gameweek scores in both, and the two are added together.",
      },
      {
        type: "prose",
        heading: "Why a defender's goal is worth more than a striker's",
        body: [
          "A forward is picked to score and will get chances every week. A centre-half might manage three goals all season. Paying both the same would mean the goal that actually swings your gameweek is the one you could most easily have predicted.",
          "The same logic runs through clean sheets in reverse. A goalkeeper or defender keeping a clean sheet is doing the job you drafted them for, so it is worth four. A midfielder gets one, because it is a genuine but incidental contribution. A forward gets nothing, because nobody drafts a striker hoping for a 0-0.",
        ],
      },
      {
        type: "prose",
        heading: "Appearance points are the floor",
        body: [
          "Every player who takes the pitch earns two points for doing so. It sounds trivial and it is the most reliable thing in the game: eleven starters who all play is twenty-two points before anybody touches the ball.",
          "This is why minutes matter as much as talent when you draft. A brilliant player who starts half the time is worth less over a season than a dependable one who starts every week, and it is why the draft board shows you appearances alongside expected points.",
        ],
      },
      {
        type: "states",
        heading: "Cards, and the one rule people get wrong",
        items: [
          { title: "Yellow card", tone: "warn", body: "Minus one. Only ever counted once in a match, however many bookings are shown." },
          { title: "Red card", tone: "bad", body: "Minus three, and it replaces the yellow rather than adding to it. A second-bookable offence costs you three, not four." },
          { title: "Own goal", tone: "bad", body: "Minus two, for any position." },
        ],
      },
      {
        type: "prose",
        heading: "The captain",
        body: [
          "One of your eleven wears the armband and scores double. Everything doubles, including the bad: a captain sent off in the first half costs you six rather than three.",
          "The safest captain is usually the one most certain to play ninety minutes, not the one with the highest ceiling. Doubling two appearance points is guaranteed; doubling a blank is nothing.",
        ],
      },
      {
        type: "prose",
        heading: "Double and blank gameweeks",
        body: [
          "A gameweek is a window of time, not a fixed round of fixtures. When a match is rescheduled it lands in whichever window actually contains its new kickoff, which means some clubs occasionally play twice in one gameweek and some play not at all.",
          "A player in a double gameweek scores in both matches and you get the sum. A player in a blank gameweek scores nothing, and no substitute comes on for him. The My team screen tells you which of your players are in each situation before the deadline, so it is worth a look rather than a surprise.",
        ],
      },
      {
        type: "callout",
        body: [
          "You win a gameweek by outscoring one other manager, not by hitting a number. A 38-point week that beats their 35 is worth exactly as much as a 90-point demolition: three league points either way.",
        ],
      },
    ],
  },
];

export function tutorialBySlug(slug) {
  return TUTORIALS.find((tutorial) => tutorial.slug === slug) ?? null;
}

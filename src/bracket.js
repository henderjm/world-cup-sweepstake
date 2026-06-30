// The real, fixed 2026 World Cup knockout structure.
//
// The data feed carries the knockout fixtures (dates and ids) but every slot is
// "Unknown" with no linkage, so the bracket pathways are not in the feed. They are,
// however, published and fixed: FIFA's 2026 match schedule defines exactly which group
// position feeds each Round-of-32 slot (matches 73-88) and how winners flow up to the
// final (matches 89-104). That structure is encoded here so the forecast can seed the
// *real* bracket instead of a generic strength-seeded one.
//
// Source: FIFA 2026 match schedule / Wikipedia "2026 FIFA World Cup knockout stage".

// Round of 32. Slot `a` is always a group winner (W) or runner-up (RU); slot `b` is the
// other side. A "3" slot takes the best third-placed team from one of the listed groups
// (the eight thirds are matched to their eight slots per the rules; see matchThirds).
export const R32 = [
  { no: 73, a: { t: "RU", g: "A" }, b: { t: "RU", g: "B" } },
  { no: 74, a: { t: "W", g: "E" }, b: { t: "3", from: ["A", "B", "C", "D", "F"] } },
  { no: 75, a: { t: "W", g: "F" }, b: { t: "RU", g: "C" } },
  { no: 76, a: { t: "W", g: "C" }, b: { t: "RU", g: "F" } },
  { no: 77, a: { t: "W", g: "I" }, b: { t: "3", from: ["C", "D", "F", "G", "H"] } },
  { no: 78, a: { t: "RU", g: "E" }, b: { t: "RU", g: "I" } },
  { no: 79, a: { t: "W", g: "A" }, b: { t: "3", from: ["C", "E", "F", "H", "I"] } },
  { no: 80, a: { t: "W", g: "L" }, b: { t: "3", from: ["E", "H", "I", "J", "K"] } },
  { no: 81, a: { t: "W", g: "D" }, b: { t: "3", from: ["B", "E", "F", "I", "J"] } },
  { no: 82, a: { t: "W", g: "G" }, b: { t: "3", from: ["A", "E", "H", "I", "J"] } },
  { no: 83, a: { t: "RU", g: "K" }, b: { t: "RU", g: "L" } },
  { no: 84, a: { t: "W", g: "H" }, b: { t: "RU", g: "J" } },
  { no: 85, a: { t: "W", g: "B" }, b: { t: "3", from: ["E", "F", "G", "I", "J"] } },
  { no: 86, a: { t: "W", g: "J" }, b: { t: "RU", g: "H" } },
  { no: 87, a: { t: "W", g: "K" }, b: { t: "3", from: ["D", "E", "I", "J", "L"] } },
  { no: 88, a: { t: "RU", g: "D" }, b: { t: "RU", g: "G" } },
];

// Later rounds reference the two feeding match numbers. THIRD takes the two losers.
export const R16 = [
  { no: 89, from: [74, 77] }, { no: 90, from: [73, 75] },
  { no: 91, from: [76, 78] }, { no: 92, from: [79, 80] },
  { no: 93, from: [83, 84] }, { no: 94, from: [81, 82] },
  { no: 95, from: [86, 88] }, { no: 96, from: [85, 87] },
];
export const QF = [
  { no: 97, from: [89, 90] }, { no: 98, from: [93, 94] },
  { no: 99, from: [91, 92] }, { no: 100, from: [95, 96] },
];
export const SF = [
  { no: 101, from: [97, 98] }, { no: 102, from: [99, 100] },
];
export const THIRD = { no: 103, from: [101, 102] };
export const FINAL = { no: 104, from: [101, 102] };

// Current official Round-of-32 pairings. The football-data.org fixture feed can keep
// knockout slots as "Unknown" even after FIFA publishes the bracket, so the Knockout
// tab uses this as a display fallback and still layers live fixture status/scores over
// it when the feed updates.
export const OFFICIAL_R32_TEAMS = new Map([
  [73, { home: "South Africa", away: "Canada" }],
  [74, { home: "Germany", away: "Paraguay" }],
  [75, { home: "Netherlands", away: "Morocco" }],
  [76, { home: "Brazil", away: "Japan" }],
  [77, { home: "France", away: "Sweden" }],
  [78, { home: "Ivory Coast", away: "Norway" }],
  [79, { home: "Mexico", away: "Ecuador" }],
  [80, { home: "England", away: "DRC" }],
  [81, { home: "USA", away: "Bosnia" }],
  [82, { home: "Belgium", away: "Senegal" }],
  [83, { home: "Portugal", away: "Croatia" }],
  [84, { home: "Spain", away: "Austria" }],
  [85, { home: "Switzerland", away: "Algeria" }],
  [86, { home: "Argentina", away: "Cape Verde" }],
  [87, { home: "Colombia", away: "Ghana" }],
  [88, { home: "Australia", away: "Egypt" }],
]);

// The feed does not expose FIFA match numbers, but its knockout fixtures are listed in
// schedule order. Map each stage's chronological fixtures back to the official numbers
// so the UI can open match details while rendering the fixed bracket route.
export const KNOCKOUT_SCHEDULE_ORDER = {
  LAST_32: [73, 76, 74, 75, 78, 77, 79, 80, 82, 81, 84, 83, 85, 88, 86, 87],
  LAST_16: [90, 89, 91, 92, 93, 94, 95, 96],
  QUARTER_FINALS: [97, 98, 99, 100],
  SEMI_FINALS: [101, 102],
  THIRD_PLACE: [103],
  FINAL: [104],
};

// The eight Round-of-32 slots that take a third-placed team, with the groups each can
// accept (the `b.from` set of those matches), keyed by match number.
const THIRD_SLOTS = R32.filter((m) => m.b.t === "3").map((m) => ({ no: m.no, from: m.b.from }));

// Pull the trailing group letter out of "Group A" / "GROUP_A" / "A".
export function groupLetter(name) {
  const match = String(name ?? "").trim().toUpperCase().match(/([A-L])\s*$/);
  return match ? match[1] : null;
}

// Match the qualifying thirds to their slots. Each slot only accepts thirds from its
// listed groups; the published table is just a bipartite matching over those rules, so
// we solve the matching (Kuhn's augmenting paths) for the actual set of qualifying
// groups. A perfect matching always exists by design. Thirds are offered best-ranked
// first so the stronger thirds settle their slots first when a choice exists.
// `thirdGroups` is the ordered list of group letters whose third-placed team qualified.
// Returns Map<matchNo, groupLetter>.
export function matchThirds(thirdGroups) {
  const slotByGroup = new Map(); // groupLetter -> matchNo (the current matching)
  const groupBySlot = new Map(); // matchNo -> groupLetter

  const tryAssign = (group, visited) => {
    for (const slot of THIRD_SLOTS) {
      if (!slot.from.includes(group) || visited.has(slot.no)) continue;
      visited.add(slot.no);
      const occupant = groupBySlot.get(slot.no);
      if (occupant == null || tryAssign(occupant, visited)) {
        groupBySlot.set(slot.no, group);
        slotByGroup.set(group, slot.no);
        return true;
      }
    }
    return false;
  };

  thirdGroups.forEach((group) => tryAssign(group, new Set()));
  return groupBySlot;
}

// Build the 16 Round-of-32 matchups from final group tables.
// `finalTables` is Map<groupLetter, [first, second, third, fourth]> of team names.
// `thirdGroupsRanked` is the ordered list of group letters of the eight best thirds.
export function seedR32(finalTables, thirdGroupsRanked) {
  const thirdByMatch = matchThirds(thirdGroupsRanked);
  const slotTeam = (slot, matchNo) => {
    const table = (letter) => finalTables.get(letter) ?? [];
    if (slot.t === "W") return table(slot.g)[0] ?? "Unknown";
    if (slot.t === "RU") return table(slot.g)[1] ?? "Unknown";
    const letter = thirdByMatch.get(matchNo);
    return letter ? table(letter)[2] ?? "Unknown" : "Unknown";
  };
  return R32.map((def) => ({
    no: def.no,
    home: slotTeam(def.a, def.no),
    away: slotTeam(def.b, def.no),
  }));
}

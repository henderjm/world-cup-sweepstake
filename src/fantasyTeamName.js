// Team names: a manager's own name for their squad in one league (issue #48).
//
// Pure: string in, result out. No DOM, no fetch, no D1 - the Worker route and
// the browser's own optimistic check import the same function, so the client
// can never accept something the server will reject, and vice versa.
//
// The name is USER-SUPPLIED TEXT that will be rendered on other people's
// screens, denormalised into the permanent league feed on write, and handed to
// a model in the weekly recap prompt. That is three separate reasons to be
// strict here rather than at each of those places:
//
//   - Rendering is already safe (every view escapes), but a name full of
//     control characters or right-to-left overrides can still wreck a
//     standings table's layout for everyone else in the league.
//   - The feed copies names in at write time, so a bad one is permanent.
//   - fantasyRecapPrompt.js sanitises what it is given, but the cheapest place
//     to stop a prompt-shaped name is before it is ever stored.
//
// Clearing is explicit and supported: an empty string means "no team name",
// and the manager falls back to their account name (memberDisplayName).

export const TEAM_NAME_MAX = 30;

// Deliberately not a blocklist of "bad" names. This strips the characters that
// break OTHER people's screens (control characters, bidirectional overrides,
// zero-width joiners used to build unrenderable stacks) and collapses runs of
// whitespace. What someone calls their fantasy team beyond that is between
// them and their mates, and a filter would be both futile and unwelcome.
const STRIP = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

export function cleanTeamName(value) {
  return String(value ?? "")
    .replace(STRIP, "")
    .replace(/\s+/g, " ")
    .trim();
}

// `{ valid, name, error }`. `name` is null for a cleared name, which callers
// store as NULL rather than as an empty string so "unnamed" is one value in the
// database rather than two.
export function validateTeamName(value) {
  const name = cleanTeamName(value);
  if (!name) return { valid: true, name: null, error: null };
  if ([...name].length > TEAM_NAME_MAX) {
    return { valid: false, name: null, error: `Team name must be ${TEAM_NAME_MAX} characters or fewer.` };
  }
  return { valid: true, name, error: null };
}

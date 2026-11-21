// The Wire's per-match news brief: the real-world context (manager under
// pressure, a returning striker, a derby's back story, whatever the papers are
// saying today) that lets a Wire line sound like someone who reads the
// football pages, not just the scoreboard.
//
// One web-search call per match, made once, near kickoff, and cached in KV.
// Every Wire line for that match then reads the cached brief as part of its
// payload, so the per-line model call stays a cheap, search-free Haiku call
// and the `wireLineAcceptable` digit rule keeps working: a figure in a line is
// accepted only if it appears in the payload, and the brief is now part of
// the payload, so a number the search actually found may be used while a
// number the line model invents still may not.
//
// Cost, bounded on purpose: at most WIRE_BRIEF_PER_TICK new briefs a tick,
// one per match ever (a failure is cached too, for a shorter window, so an
// outage cannot turn into a search per match per minute).

export const WIRE_BRIEF_DEFAULT_MODEL = "claude-sonnet-5-5";
export const WIRE_BRIEF_PER_TICK = 2;
export const WIRE_BRIEF_MAX = 900;
// A brief is written at most this long before kickoff, so "today's news" is
// today's, and is still worth writing for a match already under way.
export const WIRE_BRIEF_LEAD_MS = 90 * 60 * 1000;
const BRIEF_TTL_S = 12 * 60 * 60;
const FAILED_TTL_S = 30 * 60;

const briefKey = (matchId) => `wire:brief:${matchId}`;

export const WIRE_BRIEF_SYSTEM_PROMPT = `You prepare a short pre-match news brief for a live football commentary writer.

Search the web for the latest news around the given fixture. Then write up to six short bullet lines, each one fact, plain text, each starting with "- ".

What is worth a line: a manager under pressure or newly appointed, a notable injury or return, a player's recent run of form or a milestone in reach, a recent transfer saga, the off-pitch story around either club this week, a rivalry's back story, a notable result either side had last time out, relevant real-world news touching the clubs or their city.

Rules:
- Only facts your search results support. If you are not sure, leave it out.
- Nothing about anyone's private life, health beyond football injuries, appearance, nationality, religion or money troubles.
- No betting odds, no predictions.
- Never use em dashes. No markdown beyond the "- " bullets.
- If you find nothing useful, reply with exactly: none`;

// { text, targets } for a match, or null. `targets` are the fans this match's
// lines may name, chosen once when the brief is built so the same few people
// carry through the whole match (a follow-up needs someone to follow up on).
// They carry user ids, which is why this lives in KV and never in /wire.
export async function readWireBrief(store, matchId) {
  if (!store) return null;
  try {
    const stored = await store.get(briefKey(matchId), "json");
    if (!stored || stored.status !== "done") return null;
    return { text: stored.text ?? null, targets: Array.isArray(stored.targets) ? stored.targets : [] };
  } catch {
    return null;
  }
}

// Plain-text cleanup for what the brief model returns: control characters
// flattened, em/en dashes swapped for commas, length capped on a line boundary.
export function cleanBrief(text) {
  const lines = String(text ?? "")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f​-‏‪-‮⁦-⁩]/g, " ")
    .replace(/[–—]/g, ",")
    .split("\n")
    .map(line => line.replace(/\s+/g, " ").trim())
    .filter(line => line.startsWith("- ") && line.length > 3);
  const kept = [];
  let length = 0;
  for (const line of lines.slice(0, 6)) {
    if (length + line.length + 1 > WIRE_BRIEF_MAX) break;
    kept.push(line);
    length += line.length + 1;
  }
  return kept.length ? kept.join("\n") : null;
}

export function briefDue(match, now) {
  const kickoff = Date.parse(match?.utcDate ?? "");
  return Number.isFinite(kickoff) && now >= kickoff - WIRE_BRIEF_LEAD_MS;
}

// Writes briefs for watched matches that have none yet. `store` is a KV
// namespace (get/put); `matches` are { match, competitionName } pairs;
// `pickTargets(match)` returns the match's target fans (opted-in followers).
export async function ensureWireBriefs({ store, matches, createClient, pickTargets = async () => [], model = WIRE_BRIEF_DEFAULT_MODEL, now = Date.now(), log = console }) {
  if (!store || !createClient) return 0;
  let written = 0;
  let attempts = 0;
  for (const { match, code, competitionName } of matches) {
    if (attempts >= WIRE_BRIEF_PER_TICK) break;
    if (!briefDue(match, now)) continue;
    let existing = null;
    try {
      existing = await store.get(briefKey(match.id), "json");
    } catch {
      continue;
    }
    if (existing) continue;
    attempts += 1;
    // Claim first: a slow search must not be started twice by overlapping ticks.
    await store.put(briefKey(match.id), JSON.stringify({ status: "pending", text: null }), { expirationTtl: FAILED_TTL_S });
    let text = null;
    try {
      const day = new Date(Date.parse(match.utcDate) || now).toISOString().slice(0, 10);
      const response = await createClient().messages.create({
        model,
        max_tokens: 1500,
        system: WIRE_BRIEF_SYSTEM_PROMPT,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
        messages: [{
          role: "user",
          content: `${competitionName}: ${match.homeTeam} v ${match.awayTeam}, ${day}. Today is ${new Date(now).toISOString().slice(0, 10)}.`,
        }],
      });
      const raw = response.content.filter(block => block.type === "text").map(block => block.text).join("\n");
      text = cleanBrief(raw);
      log.log?.(`wire: brief ${text ? "written" : "empty"} for ${match.id} (in ${response.usage?.input_tokens ?? "?"}, out ${response.usage?.output_tokens ?? "?"}, searches ${response.usage?.server_tool_use?.web_search_requests ?? "?"})`);
    } catch (error) {
      log.error?.(`wire: brief failed for ${match.id}: ${error?.message ?? error}`);
      continue; // the pending claim expires on the short TTL and is retried then
    }
    let targets = [];
    try {
      targets = await pickTargets(match, code);
    } catch (error) {
      log.error?.(`wire: targets failed for ${match.id}: ${error?.message ?? error}`);
    }
    await store.put(briefKey(match.id), JSON.stringify({ status: "done", text, targets }), { expirationTtl: BRIEF_TTL_S });
    if (text) written += 1;
  }
  return written;
}

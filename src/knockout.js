import { isLive } from "./format.js";

const STAGES = ["FIRST_QUALIFYING_ROUND", "SECOND_QUALIFYING_ROUND", "THIRD_QUALIFYING_ROUND", "QUALIFYING", "PLAYOFFS", "PLAYOFF_ROUND", "ROUND_OF_32", "ROUND_OF_16", "QUARTER_FINALS", "SEMI_FINALS", "THIRD_PLACE", "FINAL"];
const QUALIFYING = new Set(STAGES.slice(0, 5));
const TWO_LEGS = new Set(STAGES.filter(stage => !["QUALIFYING", "THIRD_PLACE", "FINAL"].includes(stage)));
const LEAGUE_STAGES = new Set(["REGULAR_SEASON", "LEAGUE_STAGE", "GROUP_STAGE"]);
const canonicalStage = stage => ({ LAST_16: "ROUND_OF_16", LAST_32: "ROUND_OF_32" })[stage] ?? stage;
const hasScore = score => Number.isInteger(score?.home) && Number.isInteger(score?.away) && score.home >= 0 && score.away >= 0;
const finished = match => match.status === "FINISHED";
const played = match => isLive(match.status) || finished(match);

export function knockoutMatches(model) {
  return (model.matches ?? []).filter(match => match.stage && !LEAGUE_STAGES.has(match.stage));
}

export function knockoutRounds(model) {
  const rounds = new Map();
  for (const match of knockoutMatches(model)) {
    const stage = canonicalStage(match.stage);
    if (!rounds.has(stage)) rounds.set(stage, []);
    rounds.get(stage).push(match);
  }
  return [...rounds].map(([stage, matches]) => {
    const pairs = new Map();
    for (const match of matches) {
      const pair = JSON.stringify([match.homeTeam, match.awayTeam].sort());
      if (!pairs.has(pair)) pairs.set(pair, []);
      pairs.get(pair).push(match);
    }
    return {
      stage, phase: QUALIFYING.has(stage) ? "qualifying" : "main", matches,
      ties: [...pairs.values()].map(legs => summarizeTie(legs, stage, model.competition?.code)),
    };
  }).sort((a, b) => (STAGES.indexOf(a.stage) < 0 ? 99 : STAGES.indexOf(a.stage)) - (STAGES.indexOf(b.stage) < 0 ? 99 : STAGES.indexOf(b.stage)));
}

export function selectedKnockoutRound(rounds, { phase = null, round = null } = {}) {
  const selectedPhase = phase === "qualifying" || phase === "main" ? phase
    : rounds.some(item => item.phase === "qualifying" && item.matches.some(match => isLive(match.status))) ? "qualifying" : "main";
  const available = rounds.filter(item => item.phase === selectedPhase);
  const selected = available.find(item => item.stage === round)
    ?? available.find(item => item.matches.some(match => isLive(match.status)))
    ?? available.find(item => item.matches.some(match => ["TIMED", "SCHEDULED"].includes(match.status)))
    ?? available.at(-1);
  return { phase: selectedPhase, available, selected };
}

export function summarizeTie(fixtures, stage, competition) {
  const legs = [...fixtures].sort((a, b) => Date.parse(a.utcDate) - Date.parse(b.utcDate));
  const first = legs[0];
  const teams = [first.homeTeam, first.awayTeam];
  const result = { teams, legs, aggregate: null, penalties: null, winner: null, state: "unconfirmed", twoLegged: false };
  const single = competition === "CL" && stage === "FINAL" && legs.length === 1;
  // The feed has no tie/leg IDs. Only a distinct reversed pair in a known
  // two-leg round supports an aggregate; replays and incomplete pairs do not.
  const pair = competition === "CL" && TWO_LEGS.has(stage) && legs.length === 2
    && first.id != null && legs[1].id != null && first.id !== legs[1].id
    && first.homeTeam !== first.awayTeam && first.homeTeam === legs[1].awayTeam && first.awayTeam === legs[1].homeTeam
    && Number.isFinite(Date.parse(first.utcDate)) && Date.parse(legs[1].utcDate) > Date.parse(first.utcDate);
  result.twoLegged = pair;
  if (!single && !pair) return result;
  if (pair && played(legs[1]) && !finished(first)) return result;
  if (legs.some(match => !played(match) && !["TIMED", "SCHEDULED"].includes(match.status))) return result;
  const started = legs.filter(played);
  if (!started.length) return { ...result, state: "scheduled" };
  if (started.some(match => !hasScore(match.score))) return result;
  const oriented = (match, score) => match.homeTeam === teams[0] ? [score.home, score.away] : [score.away, score.home];
  result.aggregate = started.map(match => oriented(match, match.score)).reduce((sum, score) => [sum[0] + score[0], sum[1] + score[1]], [0, 0]);
  const last = legs.at(-1);
  if (played(last) && hasScore(last.penalties)) result.penalties = oriented(last, last.penalties);
  if (!legs.every(finished)) {
    result.state = legs.some(match => isLive(match.status)) ? "live" : "first-leg";
    return result;
  }
  const [home, away] = result.aggregate;
  if (result.penalties) {
    if (home !== away || result.penalties[0] === result.penalties[1]) return { ...result, state: "unconfirmed" };
    result.winner = teams[result.penalties[0] > result.penalties[1] ? 0 : 1];
  } else if (home !== away) {
    result.winner = teams[home > away ? 0 : 1];
  }
  result.state = result.winner ? "complete" : "unconfirmed";
  return result;
}

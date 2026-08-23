// Pure substance and section-merge logic for MAPPED match-detail payloads
// (the shape mapApiFootballMatchDetail produces), shared by the Worker and the
// browser so the two can never disagree about what "has data" means.
//
// Why this exists: upstream returns 200-with-empty under load for fixtures
// that HAVE data, and it does so PER ENDPOINT, so a read can come back with
// player stats but no lineups and no events while flagging nothing on
// `degraded`. Two consumers need the same judgement about that shape:
//
// - The Worker's KV safety copy (storeLastGoodDetail) must never let a
//   partial-but-clean read overwrite a fuller snapshot. On the 2026-27 opening
//   weekend a players-only read stored itself over the feeder's complete copy,
//   which is exactly the copy the next degraded read then swapped in.
// - The browser (src/matchDetail.js) must not let a Worker 200 with empty
//   sections suppress the static bake, which runs on GitHub's egress that
//   upstream trusts and so is often the more complete source for a match that
//   has kicked off. The same weekend, a total Worker failure (502) rendered
//   FINE because the client fell through to the bake, while a partial 200
//   rendered broken.
//
// A detail has three supplementary SECTIONS: lineups (either side's XI),
// events (goals + cards + subs, one timeline), and player stats. The score is
// how many are non-empty; sections are only ever moved WHOLE, never mixed
// within, because half a timeline from each of two reads is not a timeline.

export function detailSubstanceScore(detail) {
  if (!detail) return 0;
  let score = 0;
  if (detail.home?.lineup?.length || detail.away?.lineup?.length) score += 1;
  if (detail.goals?.length || detail.cards?.length || detail.subs?.length) score += 1;
  if (detail.playerStats?.length) score += 1;
  return score;
}

export const DETAIL_SECTION_COUNT = 3;

export function detailHasSubstance(detail) {
  return detailSubstanceScore(detail) > 0;
}

// One side's lineup block, taken whole from the fallback: the XI, the bench,
// the formation and the coach travel together or not at all.
function fillSide(primarySide, fallbackSide) {
  if (!fallbackSide) return primarySide;
  return {
    ...primarySide,
    formation: fallbackSide.formation ?? null,
    coach: fallbackSide.coach ?? null,
    lineup: fallbackSide.lineup ?? [],
    bench: fallbackSide.bench ?? [],
  };
}

// Returns `primary` with each EMPTY section filled wholesale from `fallback`,
// never mutating either. Non-empty primary sections always win, even when the
// fallback's are longer, because the primary is the fresher read and a
// fresher-but-shorter live timeline beats a mixed one. Scalars the primary is
// missing (referee, attendance, half-time score) are filled too: they are
// immutable once known, so an older source stating them is never wrong.
export function fillDetailSections(primary, fallback) {
  if (!primary) return fallback ?? null;
  if (!fallback) return primary;
  const merged = { ...primary };
  const primaryHasLineups = Boolean(primary.home?.lineup?.length || primary.away?.lineup?.length);
  const fallbackHasLineups = Boolean(fallback.home?.lineup?.length || fallback.away?.lineup?.length);
  if (!primaryHasLineups && fallbackHasLineups) {
    merged.home = fillSide(primary.home, fallback.home);
    merged.away = fillSide(primary.away, fallback.away);
  }
  const primaryHasEvents = Boolean(primary.goals?.length || primary.cards?.length || primary.subs?.length);
  const fallbackHasEvents = Boolean(fallback.goals?.length || fallback.cards?.length || fallback.subs?.length);
  if (!primaryHasEvents && fallbackHasEvents) {
    merged.goals = fallback.goals ?? [];
    merged.cards = fallback.cards ?? [];
    merged.subs = fallback.subs ?? [];
  }
  if (!primary.playerStats?.length && fallback.playerStats?.length) {
    merged.playerStats = fallback.playerStats;
  }
  if (merged.referee == null && fallback.referee != null) merged.referee = fallback.referee;
  if (merged.attendance == null && fallback.attendance != null) merged.attendance = fallback.attendance;
  if (merged.score && fallback.score) {
    if (merged.score.htHome == null && fallback.score.htHome != null) {
      merged.score = { ...merged.score, htHome: fallback.score.htHome, htAway: fallback.score.htAway };
    }
  }
  return merged;
}

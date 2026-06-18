// Map a football-data.org match-detail payload to the compact shape the match drawer
// consumes. Shared by the Cloudflare Worker (live) and the fetch script (fallback) so
// both produce identical detail JSON.

export function mapMatchDetail(match) {
  return {
    id: match.id,
    status: match.status,
    utcDate: match.utcDate,
    stage: match.stage ?? null,
    group: match.group ?? null,
    venue: match.venue ?? null,
    attendance: match.attendance ?? null,
    minute: match.minute ?? null,
    score: {
      home: match.score?.fullTime?.home ?? null,
      away: match.score?.fullTime?.away ?? null,
      htHome: match.score?.halfTime?.home ?? null,
      htAway: match.score?.halfTime?.away ?? null,
    },
    home: mapTeam(match.homeTeam),
    away: mapTeam(match.awayTeam),
    goals: (match.goals ?? []).map((goal) => ({
      minute: goal.minute,
      injuryTime: goal.injuryTime ?? null,
      type: goal.type ?? "REGULAR",
      team: goal.team?.name ?? "",
      scorer: goal.scorer?.name ?? "",
      assist: goal.assist?.name ?? null,
      home: goal.score?.home ?? null,
      away: goal.score?.away ?? null,
    })),
    cards: (match.bookings ?? []).map((booking) => ({
      minute: booking.minute,
      team: booking.team?.name ?? "",
      player: booking.player?.name ?? "",
      card: booking.card ?? "",
    })),
    subs: (match.substitutions ?? []).map((sub) => ({
      minute: sub.minute,
      team: sub.team?.name ?? "",
      in: sub.playerIn?.name ?? "",
      out: sub.playerOut?.name ?? "",
    })),
    referee:
      (match.referees ?? []).find((ref) => ref.type === "REFEREE")?.name ??
      (match.referees ?? [])[0]?.name ??
      null,
  };
}

function mapTeam(team) {
  return {
    name: team?.name ?? "",
    formation: team?.formation ?? null,
    coach: team?.coach?.name ?? null,
    lineup: (team?.lineup ?? []).map(mapPlayer),
    bench: (team?.bench ?? []).map(mapPlayer),
  };
}

function mapPlayer(player) {
  return { name: player?.name ?? "", pos: player?.position ?? null, num: player?.shirtNumber ?? null };
}

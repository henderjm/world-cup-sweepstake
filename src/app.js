import {
  buildLeaderboard,
  buildTeamPerformance,
  calculatePayouts,
  formatStage,
  mapFootballDataMatches,
  mapFootballDataStandings,
  mergeStandingsIntoPerformance,
} from "./domain.js";

const ENTRANTS = [
  { name: "Ois", teams: ["Tunisia", "Sweden", "Colombia"] },
  { name: "Mark", teams: ["Bosnia", "Ecuador", "Spain"] },
  { name: "Sinead", teams: ["New Zealand", "Algeria", "Belgium"] },
  { name: "Chris", teams: ["South Africa", "Switzerland", "Portugal"] },
  { name: "Dockrell", teams: ["Haiti", "Australia", "Croatia"] },
  { name: "Les", teams: ["Cape Verde", "South Korea", "Mexico"] },
  { name: "Eoin", teams: ["Curacao", "Paraguay", "Senegal"] },
  { name: "Cal", teams: ["Ghana", "Canada", "Brazil"] },
  { name: "Sarah", teams: ["Scotland", "Ivory Coast", "Uruguay"] },
  { name: "Carys", teams: ["DRC", "Japan", "Netherlands"] },
  { name: "Al", teams: ["Uzbekistan", "Panama", "England"] },
  { name: "Rachel", teams: ["Qatar", "Egypt", "Germany"] },
  { name: "April", teams: ["Czech", "Iran", "Morocco"] },
  { name: "Jean", teams: ["Jordan", "Norway", "Argentina"] },
  { name: "Joe", teams: ["Saudi Arabia", "Austria", "France"] },
  { name: "Dymps", teams: ["Iraq", "Turkey", "USA"] },
];

const PAYOUTS = {
  entrantCount: 16,
  stake: 10,
  splits: { second: 30, woodenSpoon: 30 },
};

const EMPTY_LIVE_DATA = {
  source: "Live data pending",
  lastUpdated: "",
  matches: [],
  standings: [],
  error: "No live data has been published yet.",
};

const elements = {
  payoutPanel: document.querySelector("#payoutPanel"),
  leaderboard: document.querySelector("#leaderboard"),
  statusMessage: document.querySelector("#statusMessage"),
  dangerList: document.querySelector("#dangerList"),
  matchList: document.querySelector("#matchList"),
};

start();

async function start() {
  const liveData = await loadLiveData();
  render(liveData);
}

async function loadLiveData() {
  try {
    const response = await fetch(`./data/live.json?cache=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const data = await response.json();
    return normalizeLiveData(data);
  } catch (error) {
    return {
      ...EMPTY_LIVE_DATA,
      error: `Live data is not available yet: ${error.message}`,
    };
  }
}

function normalizeLiveData(data) {
  return {
    source: data.source ?? "football-data.org",
    lastUpdated: data.lastUpdated ?? "",
    matches: Array.isArray(data.matches) ? data.matches : mapFootballDataMatches(data.matchesPayload ?? {}),
    standings:
      data.standings instanceof Map
        ? data.standings
        : Array.isArray(data.standings)
          ? data.standings
          : mapFootballDataStandings(data.standingsPayload ?? {}),
  };
}

function render(data) {
  const standings = data.standings instanceof Map ? data.standings : mapFootballDataStandings({ standings: data.standings });

  if (!hasLiveData(data, standings)) {
    renderPendingState(data);
    return;
  }

  const performance = mergeStandingsIntoPerformance(buildTeamPerformance(data.matches), standings);
  const leaderboard = buildLeaderboard(ENTRANTS, performance);
  const payouts = calculatePayouts(PAYOUTS);

  renderPayouts(leaderboard, payouts);
  renderLeaderboard(leaderboard);
  renderDangerList(leaderboard);
  renderMatches(data.matches);
  renderStatus(data);
}

function hasLiveData(data, standings) {
  return data.matches.length > 0 || standings.size > 0;
}

function renderPendingState(data) {
  const payouts = calculatePayouts(PAYOUTS);
  elements.payoutPanel.innerHTML = `
    ${prizeTile("1st", "TBC", payouts.first, "gold")}
    ${prizeTile("2nd", "TBC", payouts.second, "silver")}
    ${prizeTile("Wooden spoon", "TBC", payouts.woodenSpoon, "spoon")}
    <div class="pot-tile">
      <span>Total pot</span>
      <strong>${money(payouts.pot)}</strong>
      <em>16 entries x ${money(PAYOUTS.stake)}</em>
    </div>
  `;
  elements.leaderboard.innerHTML = `<p class="empty-note">Waiting for real World Cup data before ranking entrants.</p>`;
  elements.dangerList.innerHTML = `<p class="empty-note">No group danger shown until live standings are published.</p>`;
  elements.matchList.innerHTML = `<p class="empty-note">No live matches loaded yet.</p>`;
  elements.statusMessage.textContent = `${data.source}. ${data.error}`;
}

function renderPayouts(leaderboard, payouts) {
  const first = leaderboard[0];
  const second = leaderboard[1];
  const spoon = leaderboard.at(-1);

  elements.payoutPanel.innerHTML = `
    ${prizeTile("1st", first?.name, payouts.first, "gold")}
    ${prizeTile("2nd", second?.name, payouts.second, "silver")}
    ${prizeTile("Wooden spoon", spoon?.name, payouts.woodenSpoon, "spoon", spoon?.teams)}
    <div class="pot-tile">
      <span>Total pot</span>
      <strong>${money(payouts.pot)}</strong>
      <em>16 entries x ${money(PAYOUTS.stake)}</em>
    </div>
  `;
}

function renderLeaderboard(leaderboard) {
  elements.leaderboard.innerHTML = leaderboard
    .map((entrant) => {
      const modifier = entrant.rank === 1 ? "is-first" : entrant.rank === 2 ? "is-second" : "";
      const spoon = entrant.isWoodenSpoon ? "is-spoon" : "";
      return `
        <article class="leader-row ${modifier} ${spoon}">
          <div class="rank">${entrant.rank}</div>
          <div class="leader-row__main">
            <div class="leader-row__topline">
              <h3>${entrant.name}</h3>
              <strong>${entrant.score}</strong>
            </div>
            <div class="team-strip">
              ${entrant.teams.map((team) => teamChip(team, entrant.isWoodenSpoon)).join("")}
            </div>
          </div>
          <dl class="leader-stats">
            <div><dt>Risk</dt><dd>${entrant.dangerCount}</dd></div>
            <div><dt>GD</dt><dd>${signed(entrant.goalDifference)}</dd></div>
            <div><dt>P</dt><dd>${entrant.played}</dd></div>
          </dl>
        </article>
      `;
    })
    .join("");
}

function renderDangerList(leaderboard) {
  const dangerTeams = leaderboard
    .flatMap((entrant) =>
      entrant.teams.map((team) => ({
        owner: entrant.name,
        isWoodenSpoonTeam: entrant.isWoodenSpoon,
        ...team,
      })),
    )
    .filter((team) => team.dangerLevel === "danger" || team.dangerLevel === "out")
    .sort((a, b) => dangerWeight(b) - dangerWeight(a) || a.owner.localeCompare(b.owner));

  elements.dangerList.innerHTML = dangerTeams.length
    ? dangerTeams
        .map(
          (team) => `
            <article class="danger-card danger-card--${team.dangerLevel} ${team.isWoodenSpoonTeam ? "is-wooden-spoon-team" : ""}">
              <div>
                <strong>${team.name}</strong>
                <span>${team.isWoodenSpoonTeam ? `${team.owner} - spoon` : team.owner}</span>
              </div>
              <p>${team.dangerLabel}</p>
              <small>${team.group || "Group"} - ${team.points} pts - GD ${signed(team.goalDifference)}</small>
            </article>
          `,
        )
        .join("")
    : `<p class="empty-note">No sweepstake teams are in the bottom half of their group yet.</p>`;
}

function renderMatches(matches) {
  const visibleMatches = [...matches].sort(compareMatchPriority).slice(0, 8);
  elements.matchList.innerHTML = visibleMatches
    .map(
      (matchItem) => `
        <article class="match-row ${isLive(matchItem.status) ? "is-live" : ""}">
          <div>
            <span class="match-status">${statusLabel(matchItem)}</span>
            <strong>${matchItem.homeTeam} ${scorePart(matchItem.score, "home")}</strong>
            <strong>${matchItem.awayTeam} ${scorePart(matchItem.score, "away")}</strong>
          </div>
          <div>
            <span>${formatStage(matchItem.stage)}</span>
            <time datetime="${matchItem.utcDate}">${dateLabel(matchItem.utcDate)}</time>
          </div>
        </article>
      `,
    )
    .join("");
}

function renderStatus(data) {
  const updated = data.lastUpdated ? ` Updated ${dateLabel(data.lastUpdated)}.` : "";
  elements.statusMessage.textContent = `${data.source}.${updated} Group positions mark teams outside the top two.`;
}

function teamChip(team, isWoodenSpoonTeam = false) {
  const classes = [
    "team-chip",
    team.dangerLevel ? `team-chip--${team.dangerLevel}` : "",
    isWoodenSpoonTeam ? "team-chip--wooden-spoon" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const meta = team.position ? `#${team.position}` : `${team.points} pts`;
  return `
    <span class="${classes}">
      ${team.name}
      <small>${meta}</small>
    </span>
  `;
}

function prizeTile(label, name, amount, variant, teams = []) {
  const teamList = teams.length
    ? `<div class="prize-teams">${teams.map((team) => teamChip(team, true)).join("")}</div>`
    : "";
  return `
    <article class="prize-tile prize-tile--${variant}">
      <span>${label}</span>
      <strong>${money(amount)}</strong>
      <em>${name ?? "TBC"}</em>
      ${teamList}
    </article>
  `;
}

function compareMatchPriority(a, b) {
  return statusWeight(a.status) - statusWeight(b.status) || new Date(a.utcDate) - new Date(b.utcDate);
}

function statusWeight(status) {
  if (isLive(status)) return 0;
  if (status === "TIMED" || status === "SCHEDULED") return 1;
  return 2;
}

function dangerWeight(team) {
  return team.dangerLevel === "out" ? 2 : 1;
}

function isLive(status) {
  return ["IN_PLAY", "PAUSED", "LIVE", "EXTRA_TIME", "PENALTY_SHOOTOUT", "BREAK"].includes(status);
}

function statusLabel(matchItem) {
  if (isLive(matchItem.status)) return matchItem.minute ? `${matchItem.minute}'` : "Live";
  if (matchItem.status === "FINISHED") return "FT";
  return "Next";
}

function scorePart(score, side) {
  return Number.isFinite(score?.[side]) ? score[side] : "";
}

function money(value) {
  return new Intl.NumberFormat("en-IE", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: Number.isInteger(value) ? 0 : 2,
  }).format(value);
}

function signed(value) {
  return value > 0 ? `+${value}` : String(value);
}

function dateLabel(value) {
  return new Intl.DateTimeFormat("en-IE", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

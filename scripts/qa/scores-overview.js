// Run with browser_run_code_unsafe and the local preview on port 8731.
async (browserPage) => {
  const context = await browserPage.context().browser().newContext({ viewport: browserPage.viewportSize() });
  const page = await context.newPage();
  const assert = (value, message) => { if (!value) throw Error(message); };
  let releasePL;
  let holdPL = true;
  const heldPL = new Promise(resolve => { releasePL = resolve; });
  let failPL = false;
  let hasPLMatch = false;
  let clScore = 1;
  let clRequests = 0;
  let updatedAt = "2026-09-10T19:19:45Z";
  const staticRequests = [];
  const errors = [];
  const fixture = (code) => ({ id: code === "CL" ? 900002 : 900001, homeTeam: `${code} Home`, awayTeam: `${code} Away`,
    utcDate: "2026-09-10T19:00:00Z", status: "IN_PLAY", stage: "LEAGUE_STAGE", matchday: 1,
    score: { home: code === "CL" ? clScore : 1, away: 0 } });
  const feed = code => ({ competition: code, source: "Browser regression", lastUpdated: updatedAt, standings: [],
    matches: code === "CL" || hasPLMatch ? [fixture(code)] : [{ ...fixture(code), status: "TIMED", utcDate: "2026-09-11T19:00Z", score: {} }] });
  try {
    page.on("pageerror", error => errors.push(error.message));
    await page.clock.install({ time: new Date("2026-09-10T19:20:00Z") });
    await page.addInitScript(() => localStorage.setItem("gs-competition", "PL"));
    await page.route("**/data/*/scorers.json*", route => route.fulfill({ json: { scorers: [] } }));
    await page.route("**/data/*/live.json*", route => route.fulfill({ status: 503, body: "Unavailable" }));
    await page.route("**/data/*/matches/*", route => {
      staticRequests.push(route.request().url());
      return route.fulfill({ json: { goals: [{ minute: 10, scorer: "CL scorer", team: "CL Home", home: 1, away: 0 }] } });
    });
    await page.route("https://goon-squad-data.gs-wc.workers.dev/**", async route => {
      const code = route.request().url().endsWith("/PL/live") ? "PL" : route.request().url().endsWith("/CL/live") ? "CL" : null;
      if (!code) return route.fulfill({ status: 404, body: "Unavailable in regression" });
      if (code === "CL") clRequests++;
      if (code === "PL" && holdPL) await heldPL;
      return code === "PL" && failPL ? route.fulfill({ status: 503, body: "Unavailable" }) : route.fulfill({ json: feed(code) });
    });
    await page.goto("http://127.0.0.1:8731/#live");
    await page.locator('[data-score-league="CL"] [data-match-id]').waitFor();
    await page.locator('[data-score-league="PL"]').getByText("Loading matches…").waitFor();
    assert(await page.locator('[data-all-scores]').getAttribute("class").then(value => value.includes("is-active")), "Stored PL preference hid the overview");
    clScore = 2;
    await page.clock.runFor(20000);
    await page.waitForFunction(() => document.querySelector('[data-match-id="900002"] .mline__score')?.textContent === "2 – 0");
    assert(clRequests >= 2, "A held league blocked the other league's next live poll");
    holdPL = false;
    releasePL();
    await page.locator('[data-score-league="PL"]').getByText("No kick-offs today.").waitFor();
    assert(await page.locator('[data-score-league]').first().getAttribute("data-score-league") === "CL", "Quiet PL appeared before CL matches");

    await page.locator('[data-match-id="900002"]').click();
    await page.getByText("CL scorer", { exact: false }).waitFor();
    assert(staticRequests.some(url => url.includes("/data/CL/matches/900002.json")), "CL detail used another league's fallback");
    await page.keyboard.press("Escape");

    failPL = true;
    clScore = 3;
    await page.locator('[data-score-action="next"]').focus();
    await page.clock.runFor(20000);
    await page.locator('[data-score-league="PL"]').getByText("Live updates delayed. Showing the last available scores.", { exact: false }).waitFor();
    await page.waitForFunction(() => document.querySelector('[data-match-id="900002"] .mline__score')?.textContent === "3 – 0");
    assert(await page.locator('[data-score-action="next"]').evaluate(e => e === document.activeElement), "Poll lost date-control focus");
    failPL = false;
    hasPLMatch = true;
    updatedAt = await page.evaluate(() => new Date().toISOString());
    await page.locator('[data-score-feed-retry="PL"]').click();
    await page.locator('[data-score-league="PL"] [data-match-id]').waitFor();
    assert(await page.locator('[data-score-league="CL"] [data-match-id]').count() === 1, "PL retry erased CL");

    await page.getByRole("button", { name: "Champions League table", exact: true }).click();
    await page.locator('[data-tab="tables"].is-active').waitFor();
    assert(page.url().includes("tables?") && page.url().includes("competition=CL"), "Table route lost its league");
    await page.reload();
    await page.locator('[data-tab="tables"].is-active').waitFor();
    assert(await page.locator('.hero__eyebrow').innerText() === "UEFA CHAMPIONS LEAGUE", "Table reload selected another league");
    await page.locator('[data-all-scores]').click();
    await page.locator('[data-score-league="PL"] [data-match-id]').waitFor();
    await page.locator('[data-competition="CL"]').click();
    await page.locator('[data-score-date]').waitFor();
    assert(page.url().includes("competition=CL"), "League filter is missing from URL");
    await page.goBack();
    await page.locator('[data-score-league="PL"] [data-match-id]').waitFor();
    await page.getByRole("button", { name: "Next day", exact: true }).click();
    assert(await page.locator('[data-score-league] [data-match-id]').count() === 0, "Date filter failed across competitions");
    await page.getByRole("button", { name: "Today", exact: true }).click();
    assert(await page.locator('[data-score-league] [data-match-id]').count() === 2, "Today did not restore both competitions");
    assert(!await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), "Overview overflows viewport");
    assert(!errors.length, `Browser errors: ${errors.join(", ")}`);
    return { passed: ["default All matches", "independent loading", "independent live cadence", "quiet league ordering", "CL detail fallback", "partial outage", "other league live refresh", "poll focus preservation", "per-league retry", "table route", "table reload", "league filter route", "Back to all leagues", "shared date filtering", "Today across leagues", "no horizontal overflow", "no browser errors"] };
  } finally {
    releasePL();
    await context.close();
  }
}

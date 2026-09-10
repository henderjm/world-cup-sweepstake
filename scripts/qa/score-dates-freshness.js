// Run using browser_run_code_unsafe with a local preview on port 8731.
async (browserPage) => {
  const context = await browserPage.context().browser().newContext({ viewport: browserPage.viewportSize() });
  const page = await context.newPage();
  const assert = (value, message) => { if (!value) throw new Error(message); };
  let unavailable = false;
  let older = false;
  let score = 1;
  let updatedAt = "2026-09-10T19:19:30Z";
  const fixture = (id, status, date) => ({ id, homeTeam: `Home ${id}`, awayTeam: `Away ${id}`, status,
    utcDate: date, stage: "LEAGUE_STAGE", matchday: 1, minute: 20, score: { home: score, away: 0 } });
  const feed = () => ({ competition: "CL", source: "Browser regression fixture", lastUpdated: updatedAt, standings: [], matches: [
    fixture(900001, "IN_PLAY", "2026-09-10T19:00Z"), fixture(900002, "FINISHED", "2026-09-10T16:00Z"), fixture(900003, "TIMED", "2026-09-11T19:00Z"),
  ] });
  try {
    await page.clock.install({ time: new Date("2026-09-10T19:20:00Z") });
    await page.addInitScript(() => localStorage.setItem("gs-competition", "CL"));
    await page.route("**/data/CL/scorers.json*", route => route.fulfill({ json: { scorers: [] } }));
    await page.route("**/data/CL/live.json*", route => route.fulfill({ json: { competition: "CL", matches: [], standings: [] } }));
    await page.route("https://goon-squad-data.gs-wc.workers.dev/**", route => {
      if (!route.request().url().endsWith("/CL/live")) return route.fulfill({ status: 404, body: "Unavailable in regression" });
      if (unavailable) return route.fulfill({ status: 503, body: "Unavailable" });
      const body = feed();
      if (older) { body.lastUpdated = "2026-09-10T18:00Z"; body.matches[0].score.home = 0; }
      return route.fulfill({ json: body });
    });
    await page.goto("http://127.0.0.1:8731/#live");
    await page.locator('.score-day [data-match-id="900001"]').waitFor();
    assert(await page.locator('.score-day [data-match-id]').count() === 2, "Today should contain two fixtures exactly once");
    await page.getByRole("button", { name: "Next day", exact: true }).click();
    assert(await page.locator('[data-score-date]').inputValue() === "2026-09-11", "Next day failed");
    assert(await page.locator('.score-day [data-match-id="900003"]').count() === 1, "Tomorrow's fixture is missing");
    await page.getByRole("button", { name: "Previous day", exact: true }).click();
    await page.locator('[data-score-date]').fill("2026-09-09");
    await page.locator('[data-score-date]').dispatchEvent("change");
    await page.getByText("No matches on this date.", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Today", exact: true }).click();
    await page.locator('[data-score-action="live"]').click();
    assert(await page.locator('.score-day [data-match-id]').count() === 1, "Live filter includes finished matches");
    const selectedRoute = page.url();
    await page.locator('.score-day [data-match-id]').click();
    await page.keyboard.press("Escape");
    assert(page.url() === selectedRoute, "Detail navigation lost the date route");
    await page.reload();
    await page.locator('.score-day [data-match-id]').waitFor();
    assert(await page.locator('[data-score-action="live"]').getAttribute("aria-pressed") === "true", "Reload lost the Live filter");
    await page.getByRole("button", { name: "Next day", exact: true }).click();
    await page.goBack();
    await page.waitForFunction(() => document.querySelector('[data-score-date]')?.value === "2026-09-10");

    unavailable = true;
    await page.clock.runFor(20000);
    await page.getByText("Live data is behind", { exact: true }).waitFor();
    const firstAge = await page.locator('#updated').innerText();
    assert(firstAge.includes("delayed") && !firstAge.includes("just now"), "Outage reset the age or hid the delay");
    await page.clock.runFor(20000);
    const secondAge = await page.locator('#updated').innerText();
    assert(firstAge !== secondAge, "Repeated failures froze the data age");
    assert(await page.locator('.score-day [data-match-id="900001"] .mline__score').innerText() === "1 – 0", "An empty fallback erased the score");
    unavailable = false;
    older = true;
    await page.clock.runFor(20000);
    assert(await page.locator('.score-day [data-match-id="900001"] .mline__score').innerText() === "1 – 0", "An older payload regressed the score");
    older = false;
    score = 2;
    updatedAt = await page.evaluate(() => new Date().toISOString());
    await page.clock.runFor(20000);
    await page.waitForFunction(() => document.querySelector('.score-day .mline__score')?.textContent === "2 – 0");
    await page.getByText("Live data is behind", { exact: true }).waitFor({ state: "hidden" });
    assert(await page.locator('#bmc-wbtn').count() === 0, "Floating support button still obscures scores");
    assert(await page.getByRole('link', { name: 'Support Kickoff Draft' }).count() === 1, "Support link was lost");
    const overflow = await page.locator('.score-controls').evaluate(e => e.getBoundingClientRect().right > innerWidth);
    assert(!overflow, "Date controls are clipped");
    return { passed: ["date arrows", "calendar", "empty date", "Today", "Live filter", "detail route preservation", "reload", "browser Back", "total outage", "age increases through failures", "older snapshot rejected", "recovery", "support remains accessible", "controls fit viewport"] };
  } finally {
    await context.close();
  }
}

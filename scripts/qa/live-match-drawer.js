// Run with the Playwright browser_run_code_unsafe tool's filename argument.
async (browserPage) => {
  const context = await browserPage.context().browser().newContext();
  const page = await context.newPage();
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  let goals = 1;
  let eventOnly = false;
  let unavailable = false;
  let holdNext = false;
  let releaseOld;
  let oldRequest;
  const held = new Promise(resolve => { releaseOld = resolve; });
  const feed = () => ({
    competition: "CL", source: "Browser regression fixture", lastUpdated: "2026-09-10T19:20:00Z", standings: [],
    matches: [{ id: 900001, homeTeam: "Home", awayTeam: "Away", utcDate: "2026-09-10T19:00:00Z",
      status: "IN_PLAY", minute: 20 + goals, stage: "LEAGUE_STAGE", matchday: 1, score: { home: goals, away: 0 } }],
  });
  const detail = () => ({
    id: 900001,
    goals: Array.from({ length: goals }, (_, i) => ({ minute: 5 + i * 5, scorer: `Scorer ${i + 1}`, team: "Home", home: i + 1, away: 0 })),
    cards: Array.from({ length: eventOnly ? 17 : 16 }, (_, i) => ({ minute: 20, player: `Carded player ${i + 1}`, team: i % 2 ? "Home" : "Away", card: "YELLOW" })),
    subs: [],
    home: { name: "Home", lineup: Array.from({ length: 11 }, (_, i) => ({ name: `Home player ${i + 1}`, num: i + 1, pos: i ? "DF" : "GK" })) },
    away: { name: "Away", lineup: Array.from({ length: 11 }, (_, i) => ({ name: `Away player ${i + 1}`, num: i + 1, pos: i ? "DF" : "GK" })) },
    playerStats: [{ playerId: 1 }],
  });
  try {
    await page.clock.install({ time: new Date("2026-09-10T19:20:00Z") });
    await page.addInitScript(() => localStorage.setItem("gs-competition", "CL"));
    await page.route("**/data/CL/scorers.json*", route => route.fulfill({ json: { scorers: [] } }));
    await page.route("**/data/CL/matches/*", route => route.fulfill({ status: 503, body: "Unavailable" }));
    await page.route("https://goon-squad-data.gs-wc.workers.dev/**", async route => {
      const pathname = route.request().url().replace("https://goon-squad-data.gs-wc.workers.dev", "").split("?")[0];
      if (pathname === "/CL/live") return route.fulfill({ json: feed() });
      if (pathname === "/match/900001") {
        if (holdNext) {
          holdNext = false;
          oldRequest = detail();
          await held;
          return route.fulfill({ json: oldRequest }).catch(() => {});
        }
        return unavailable ? route.fulfill({ status: 503, body: "Unavailable" }) : route.fulfill({ json: detail() });
      }
      return route.fulfill({ status: 404, body: "Not configured for this regression" });
    });
    await page.setViewportSize(browserPage.viewportSize() ?? { width: 390, height: 844 });
    await page.goto("http://127.0.0.1:8731/#live");
    await page.locator(".score-day [data-match-id]").click();
    await page.getByText("Scorer 1", { exact: false }).waitFor();
    assert(await page.locator(".shell").evaluate(e => e.inert), "Background should be inert");
    const close = page.getByRole("button", { name: "Close", exact: true });
    await close.focus();
    await page.keyboard.press("Shift+Tab");
    assert(await page.evaluate(() => document.querySelector(".dz__panel").contains(document.activeElement)), "Tab escaped the dialog");
    await close.focus();
    const scrollBefore = await page.locator(".dz__panel").evaluate(e => { e.scrollTop = 180; return e.scrollTop; });
    assert(scrollBefore > 0, "The fixture should produce a scrollable drawer");
    for (const score of [2, 3]) {
      goals = score;
      await page.clock.runFor(20000);
      await page.getByText(`Scorer ${score}`, { exact: false }).waitFor();
      assert(await page.locator(".dz__num").innerText() === `${score} – 0`, "Open score did not refresh");
      const scrollAfter = await page.locator(".dz__panel").evaluate(e => e.scrollTop);
      assert(scrollAfter === scrollBefore, `Refresh moved the scroll position from ${scrollBefore} to ${scrollAfter}`);
      assert(await close.evaluate(e => e === document.activeElement), "Refresh moved keyboard focus");
    }
    eventOnly = true;
    await page.clock.runFor(20000);
    await page.getByText("Carded player 17", { exact: false }).waitFor();
    unavailable = true;
    await page.clock.runFor(20000);
    await page.locator("#mdUpdate").waitFor({ state: "visible" });
    assert(await page.getByText("Scorer 3", { exact: false }).count() === 1, "Failed refresh erased prior details");
    unavailable = false;
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await page.locator("#mdUpdate").waitFor({ state: "hidden" });
    await page.keyboard.press("Escape");
    assert(!(await page.locator(".shell").evaluate(e => e.inert)), "Background stayed inert after close");
    assert(await page.locator(".score-day [data-match-id]").evaluate(e => e === document.activeElement), "Focus did not return to the match after a scoreboard repaint");

    holdNext = true;
    goals = 1;
    const started = page.waitForRequest(request => request.url().endsWith("/match/900001"));
    await page.locator(".score-day [data-match-id]").click();
    await started;
    await page.keyboard.press("Escape");
    goals = 3;
    await page.locator(".score-day [data-match-id]").click();
    await page.getByText("Scorer 3", { exact: false }).waitFor();
    releaseOld();
    await page.clock.runFor(1000);
    assert(await page.getByText("Scorer 3", { exact: false }).count() === 1, "A response from the previous opening overwrote current details");
    await page.keyboard.press("Escape");
    return { passed: ["two goal updates", "event-only refresh", "scroll preservation", "focus preservation", "focus trap", "focus restoration", "last-good detail on failure", "retry", "same-match reopen race"] };
  } finally {
    releaseOld();
    await context.close();
  }
}

// Score-feed availability must not gate other product areas at startup.
async (browserPage) => {
  const context = await browserPage.context().browser().newContext({ viewport: browserPage.viewportSize() });
  const page = await context.newPage();
  const errors = [];
  let offline = true;
  page.on("pageerror", error => errors.push(error.message));
  try {
    await page.route("**/data/*/scorers.json*", route => route.fulfill({ json: { scorers: [] } }));
    await page.route("**/data/*/live.json*", route => route.fulfill({ status: 503, body: "Offline" }));
    await page.route("https://goon-squad-data.gs-wc.workers.dev/**", route => {
      if (offline || !route.request().url().endsWith("/live")) return route.fulfill({ status: 503, body: "Offline" });
      const competition = route.request().url().includes("/CL/") ? "CL" : "PL";
      return route.fulfill({ json: { competition, matches: [], standings: [], source: "Browser regression", lastUpdated: new Date().toISOString() } });
    });
    for (const [section, text] of [
      ["fantasy", "Sign in for fantasy"], ["play", "Matchday Paper Run"],
      ["learn", "Tutorials"], ["demo", "Draft a squad in 5 minutes"], ["you", "Sign in to Kickoff Draft"],
    ]) {
      await page.goto(`http://127.0.0.1:8731/#${section}`);
      await page.locator("#layout").getByText(new RegExp(text, "i")).first().waitFor();
    }
    await page.goto("http://127.0.0.1:8731/#live");
    await page.waitForFunction(() => document.querySelectorAll('[data-score-feed-retry]').length === 2);
    offline = false;
    await page.locator('[data-score-feed-retry="PL"]').click();
    await page.locator('[data-score-league="PL"]').getByText("No fixtures published.", { exact: true }).waitFor();
    if (await page.locator('[data-score-feed-retry="CL"]').count() !== 1) throw Error("PL recovery changed the CL error state");
    if (errors.length) throw Error(errors.join("; "));
    return { passed: ["Fantasy offline startup", "Play offline startup", "Learn offline startup", "Demo offline startup", "Account offline startup", "both feeds unavailable", "retry to healthy empty feed", "failure isolation", "no browser errors"] };
  } finally {
    await context.close();
  }
}

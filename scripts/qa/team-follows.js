// Device and account follow journeys; every account request is intercepted.
async (browserPage) => {
  const context = await browserPage.context().browser().newContext({ viewport: browserPage.viewportSize() });
  const page = await context.newPage();
  const assert = (value, message) => { if (!value) throw Error(message); };
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const serverFollows = [{ competition: "PL", team: "PL Away" }];
  const writes = [];
  let loseCLResponse = true;
  let failVerification = false;
  const feed = code => ({ competition: code, source: "Browser regression", lastUpdated: "2026-09-10T19:19:45Z", standings: [], matches: [
    { id: code === "PL" ? 900001 : 900002, homeTeam: `${code} Home`, awayTeam: `${code} Away`, utcDate: "2026-09-10T19:00Z", status: "IN_PLAY", score: { home: 1, away: 0 } },
    ...(code === "PL" ? [{ id: 900003, homeTeam: "PL Home", awayTeam: "PL Tomorrow", utcDate: "2026-09-11T19:00Z", status: "TIMED", score: {} }] : []),
  ] });
  try {
    await page.clock.install({ time: new Date("2026-09-10T19:20:00Z") });
    await context.route("**/data/*/scorers.json*", route => route.fulfill({ json: { scorers: [] } }));
    await context.route("**/data/*/matches/*", route => route.fulfill({ status: 503, body: "Not in this fixture" }));
    await context.route("https://goon-squad-data.gs-wc.workers.dev/**", route => {
      const path = route.request().url().replace("https://goon-squad-data.gs-wc.workers.dev", "").split("?")[0];
      if (path === "/PL/live" || path === "/CL/live") return route.fulfill({ json: feed(path.slice(1, 3)) });
      if (path === "/me" && failVerification) { failVerification = false; return route.fulfill({ status: 503, body: "Temporary failure" }); }
      if (path === "/me") return route.fulfill({ json: { user: { email: "test@example.invalid", name: "Test", prefs: { goals: false } }, follows: serverFollows } });
      if (path === "/follows/toggle") {
        const body = route.request().postDataJSON();
        writes.push(body);
        const index = serverFollows.findIndex(follow => follow.competition === body.competition && follow.team === body.team);
        if (index < 0) serverFollows.push(body); else serverFollows.splice(index, 1);
        if (body.competition === "CL" && loseCLResponse) { loseCLResponse = false; return route.fulfill({ status: 503, body: "Response lost after save" }); }
        return route.fulfill({ json: { follows: serverFollows } });
      }
      if (path === "/auth/logout") return route.fulfill({ json: { ok: true } });
      return route.fulfill({ status: 404, body: "Not in this fixture" });
    });
    await page.goto("http://127.0.0.1:8731/#live");
    await page.locator('[data-score-league="PL"] [data-match-id]').first().waitFor();
    await page.getByRole("button", { name: "Choose teams", exact: true }).click();
    await page.getByRole("searchbox", { name: "Find a team" }).fill("PL Home");
    await page.getByRole("button", { name: "Follow PL Home in Premier League", exact: true }).click();
    await page.getByRole("button", { name: "Unfollow PL Home in Premier League", exact: true }).waitFor();
    assert(writes.length === 0, "Signed-out follow wrote to the account");
    await page.getByRole("button", { name: "Unfollow PL Home in Premier League", exact: true }).click();
    await page.getByRole("button", { name: "Follow PL Home in Premier League", exact: true }).waitFor();
    assert(await page.evaluate(() => JSON.parse(localStorage.getItem("gs-local-follows")).length) === 0, "Unfollow did not remove the saved team");
    await page.getByRole("button", { name: "Follow PL Home in Premier League", exact: true }).click();
    await page.getByRole("button", { name: "Unfollow PL Home in Premier League", exact: true }).waitFor();
    await page.getByRole("searchbox", { name: "Find a team" }).focus();
    await page.clock.runFor(20000);
    assert(await page.getByRole("searchbox", { name: "Find a team" }).evaluate(e => e === document.activeElement && e.value === "PL Home"), "Polling lost the team search");
    await page.getByRole("button", { name: "Close teams", exact: true }).click();
    await page.locator('[data-score-action="following"]').click();
    assert(await page.locator('.score-day [data-match-id]').count() === 1, "Following includes unfollowed teams");
    assert(page.url().includes("following=1"), "Following is missing from the route");
    await page.reload();
    await page.locator('.score-day [data-match-id="900001"]').waitFor();
    assert(await page.locator('[data-score-action="following"]').getAttribute("aria-pressed") === "true", "Reload lost Following");
    await page.getByRole("button", { name: "Next day", exact: true }).click();
    await page.locator('.score-day [data-match-id="900003"]').waitFor();
    await page.getByRole("button", { name: "Today", exact: true }).click();
    await page.locator('.score-day [data-match-id="900001"]').click();
    const awayFollow = page.getByRole("button", { name: "Follow PL Away in Premier League", exact: true });
    await awayFollow.focus();
    await page.keyboard.press("Space");
    const awayUnfollow = page.getByRole("button", { name: "Unfollow PL Away in Premier League", exact: true });
    await awayUnfollow.waitFor();
    assert(await awayUnfollow.evaluate(e => e === document.activeElement), "Following from the drawer lost keyboard focus");
    await page.keyboard.press("Escape");

    const other = await context.newPage();
    await other.route("**/*", route => route.fulfill({ contentType: "text/html", body: "<title>Storage regression</title>" }));
    await other.goto("http://127.0.0.1:8731/storage-regression");
    await other.evaluate(() => {
      const follows = JSON.parse(localStorage.getItem("gs-local-follows"));
      localStorage.setItem("gs-local-follows", JSON.stringify([...follows, { competition: "CL", team: "CL Home" }]));
    });
    await page.locator('.score-day [data-match-id="900002"]').waitFor();
    await other.close();
    assert(writes.length === 0, "Local choices or cross-tab updates wrote to the account");

    await page.evaluate(() => localStorage.setItem("gs-session", "intercepted-test-session"));
    await page.reload();
    await page.locator('#accountBtn.is-avatar').waitFor();
    assert(writes.length === 0, "Signing in automatically imported notification subscriptions");
    await page.getByRole("button", { name: "Choose teams", exact: true }).click();
    failVerification = true;
    await page.getByRole("button", { name: "Save to account", exact: true }).click();
    await page.getByText("Could not save your follows. Check your connection and try again.", { exact: true }).waitFor();
    assert(await page.locator('#accountBtn.is-avatar').count() === 1 && writes.length === 0, "A verification outage signed the user out or wrote follows");
    await page.getByRole("button", { name: "Save to account", exact: true }).click();
    await page.getByText("Could not save your follows. Check your connection and try again.", { exact: true }).waitFor();
    assert(writes.length === 2, "Existing account follow was toggled during import");
    await page.getByRole("button", { name: "Save to account", exact: true }).click();
    await page.getByText("Your followed teams are saved to your account.", { exact: true }).waitFor();
    assert(writes.length === 2, "Retry undid a successful save whose response was lost");
    assert(serverFollows.length === 3 && serverFollows.some(f => f.team === "PL Away"), "Import removed an existing account follow");
    assert(await page.evaluate(() => JSON.parse(localStorage.getItem("gs-local-follows")).length) === 0, "Successfully imported local choices were not reconciled");
    await page.evaluate(() => { location.hash = "you"; });
    await page.locator('[data-pref-key="goals"]').waitFor();
    assert(await page.locator('[data-pref-key="goals"]').getAttribute("aria-checked") === "false", "Following changed notification preferences");
    assert(!await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), "Following overflows the viewport");
    assert(errors.length === 0, errors.join("; "));
    return { passed: ["team search", "local follow without sign-in", "local unfollow", "search survives polling", "Following filter", "route and reload", "next-day matches", "drawer keyboard follow", "drawer focus", "cross-tab sync", "no automatic account writes", "explicit account import", "verification outage retains account", "existing follows preserved", "lost-response retry", "local reconciliation", "alert preferences preserved", "no overflow or browser errors"] };
  } finally {
    await context.close();
  }
}

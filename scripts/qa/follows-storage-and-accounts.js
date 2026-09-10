// Storage failures and late account responses use isolated, intercepted sessions.
async (browserPage) => {
  const results = [];
  for (const scenario of ["storage", "restore", "toggle"]) {
    const context = await browserPage.context().browser().newContext({ viewport: browserPage.viewportSize() });
    const page = await context.newPage();
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const user = email => ({ email, name: email === "a@example.invalid" ? "Account A" : "Account B", prefs: { goals: false } });
    try {
      await page.clock.install({ time: new Date("2026-09-10T19:20:00Z") });
      await page.addInitScript(scenario => {
        if (scenario === "storage") {
          const set = Storage.prototype.setItem;
          Storage.prototype.setItem = function(key, value) {
            if (key === "gs-local-follows") throw Error("Storage blocked in regression");
            return set.call(this, key, value);
          };
        } else {
          localStorage.setItem("gs-session", "account-a-test-token");
          let callback;
          window.google = { accounts: { id: {
            initialize(options) { callback = options.callback; },
            renderButton(container) {
              const button = document.createElement("button");
              button.textContent = "Sign in as test account B";
              button.onclick = () => callback({ credential: "intercepted-test-credential" });
              container.replaceChildren(button);
            },
          } } };
        }
      }, scenario);
      await page.route("**/data/*/scorers.json*", route => route.fulfill({ json: { scorers: [] } }));
      await page.route("https://goon-squad-data.gs-wc.workers.dev/**", async route => {
        const path = route.request().url().replace("https://goon-squad-data.gs-wc.workers.dev", "");
        if (path.endsWith("/live")) return route.fulfill({ json: { competition: path.includes("CL") ? "CL" : "PL", source: "Regression", lastUpdated: "2026-09-10T19:19:45Z", standings: [], matches: [
          { id: 900001, homeTeam: "Home", awayTeam: "Away", utcDate: "2026-09-10T19:00Z", status: "IN_PLAY", score: { home: 1, away: 0 } },
        ] } });
        if (path === "/me") {
          if (scenario === "restore") await held;
          return route.fulfill({ json: { user: user("a@example.invalid"), follows: [] } }).catch(() => {});
        }
        if (path === "/auth/google") return route.fulfill({ json: { token: "account-b-test-token", user: user("b@example.invalid"), follows: [] } });
        if (path === "/auth/logout") return route.fulfill({ json: { ok: true } });
        if (path === "/follows/toggle") {
          await held;
          return route.fulfill({ json: { follows: [{ competition: "CL", team: "Home" }] } }).catch(() => {});
        }
        return route.fulfill({ status: 404, body: "Not in this fixture" });
      });
      await page.goto(`http://127.0.0.1:8731/#${scenario === "restore" ? "you" : "live?competition=CL"}`);
      if (scenario === "storage") {
        await page.getByRole("button", { name: "Choose teams", exact: true }).click();
        await page.getByRole("button", { name: "Follow Home in Champions League", exact: true }).click();
        await page.getByText("Saved for this visit only. Device storage is unavailable.", { exact: true }).waitFor();
        await page.getByRole("button", { name: "Unfollow Home in Champions League", exact: true }).waitFor();
        await page.locator('[data-score-action="following"]').click();
        await page.reload();
        await page.getByText("Choose teams to see their matches here. No sign-in needed.", { exact: true }).waitFor();
        results.push("blocked storage disclosed; session choice works; reload is honest");
      } else {
        if (scenario === "toggle") {
          await page.locator('#accountBtn.is-avatar').waitFor();
          await page.getByRole("button", { name: "Choose teams", exact: true }).click();
          const started = page.waitForRequest(request => request.url().endsWith("/follows/toggle"));
          await page.getByRole("button", { name: "Follow Home in Champions League", exact: true }).click();
          await started;
          await page.evaluate(() => { location.hash = "you"; });
          await page.getByRole("button", { name: "Sign out", exact: true }).click();
        }
        await page.getByRole("button", { name: "Sign in as test account B", exact: true }).click();
        await page.getByText("Account B", { exact: true }).waitFor();
        release();
        await page.clock.runFor(1000);
        await page.getByText("Account B", { exact: true }).waitFor();
        await page.evaluate(() => { location.hash = "live?competition=CL&following=1"; });
        await page.getByText("Choose teams to see their matches here. No sign-in needed.", { exact: true }).waitFor();
        if (await page.locator('[data-score-action="following"]').innerText() !== "Following 0") throw Error("Old account follows leaked into the new account");
        results.push(`late ${scenario} response cannot overwrite another account`);
      }
      if (errors.length) throw Error(errors.join("; "));
    } finally {
      release();
      await context.close();
    }
  }
  return { passed: results };
}

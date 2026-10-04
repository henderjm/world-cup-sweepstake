async page => {
  const errors = [], passed = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.clock.install({ time: new Date("2026-10-13T19:30:00Z") });
  await page.route("**/data/*/scorers.json*", route => route.fulfill({ json: { scorers: [] } }));
  let bakeReads = 0;
  await page.route("**/data/*/matches/*", route => { bakeReads++; return route.fulfill({ status: 503 }); });
  let gate = Promise.resolve(), release;
  await page.route("https://goon-squad-data.gs-wc.workers.dev/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (!["/CL/live", "/match/900001"].includes(path)) return route.fulfill({ status: 404 });
    if (path.startsWith("/match/")) await gate;
    const response = await route.fetch({ url: "http://127.0.0.1:8743" + path });
    await route.fulfill({ response, headers: { ...response.headers(), "access-control-allow-origin": "*" } });
  });
  const control = async mode => {
    const response = await page.request.get("http://127.0.0.1:8743/control/" + mode);
    const state = await response.json(); await page.clock.setFixedTime(new Date(state.now)); return state;
  };
  await control("failure");
  await page.goto("http://127.0.0.1:8742/#live?competition=CL");
  const score = page.locator('.score-day [data-match-id="900001"]');
  await score.click();
  await page.locator("#mdUpdate").waitFor({ state: "visible" });
  passed.push("cold detail failure offers retry");
  const coldBakeReads = bakeReads;
  await control("empty");
  await page.locator("[data-md-retry]").click();
  await page.getByText("Some match details are missing from the feed. Available details are shown above.", { exact: true }).waitFor();
  if (bakeReads !== coldBakeReads) throw Error("Stored missing coverage consulted the legacy bake");
  passed.push("known match with missing sections remains openable and labelled");
  await page.keyboard.press("Escape");
  await control("initial");
  gate = new Promise(resolve => { release = resolve; });
  await score.click();
  await page.locator("[data-md-loading]").waitFor(); release();
  await page.getByText("Stored Scorer", { exact: false }).waitFor();
  await page.getByText("Player 42-0", { exact: false }).waitFor();
  passed.push("loading resolves to mapped stored timeline and lineups");
  await control("stale"); await page.clock.runFor(20000);
  await page.getByText("Some match details are missing from the feed. Available details are shown above.", { exact: true }).waitFor();
  await page.getByText("Stored Scorer", { exact: false }).waitFor();
  passed.push("stored read outage retains labelled last-good detail");
  await control("correction"); await page.clock.runFor(20000);
  await page.locator(".dz__num").getByText("0 – 0", { exact: true }).waitFor();
  await page.getByText("Stored Scorer", { exact: false }).waitFor({ state: "hidden" });
  if (bakeReads !== coldBakeReads) throw Error("Stored correction consulted the legacy bake");
  passed.push("downward score and timeline correction recover together without legacy bake reads");
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error("Overflow at " + width);
    await page.getByRole("button", { name: "Close", exact: true }).focus();
    await page.keyboard.press("Shift+Tab");
    if (!await page.locator(".dz__panel").evaluate(el => el.contains(document.activeElement))) throw Error("Focus escaped drawer");
  }
  await page.keyboard.press("Escape");
  if (!await score.evaluate(el => el === document.activeElement)) throw Error("Focus did not return to score");
  const state = await control("state");
  if (errors.length || state.forbiddenCalls) throw Error(JSON.stringify({ errors, ...state }));
  return { passed, errors, reads: state.reads, forbiddenCalls: state.forbiddenCalls, widths: [390, 1440] };
}

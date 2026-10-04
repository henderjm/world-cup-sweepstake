async page => {
  const errors = [], passed = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.clock.install({ time: new Date("2026-10-13T19:30:00Z") });
  await page.route("**/data/*/scorers.json*", route => route.fulfill({ json: { scorers: [] } }));
  await page.route("**/data/*/live.json*", route => route.fulfill({ status: 503 }));
  let gate = Promise.resolve(), release;
  await page.route("https://goon-squad-data.gs-wc.workers.dev/**", async route => {
    if (!route.request().url().endsWith("/CL/live")) return route.fulfill({ status: 404 });
    await gate;
    const response = await route.fetch({ url: "http://127.0.0.1:8743/CL/live" });
    // The preview is localhost; the Worker fixture otherwise emits production CORS.
    await route.fulfill({ response, headers: { ...response.headers(), "access-control-allow-origin": "*" } });
  });
  const control = async mode => {
    const response = await page.request.get("http://127.0.0.1:8743/control/" + mode);
    if (!response.ok()) throw Error(await response.text());
    const state = await response.json();
    await page.clock.setFixedTime(new Date(state.now));
    return state;
  };
  await control("failure");
  await page.goto("http://127.0.0.1:8742/#live?competition=CL");
  await page.locator("[data-scores-retry]").waitFor();
  passed.push("cold stored-service failure exposes retry");
  await control("empty");
  await page.locator("[data-scores-retry]").click();
  await page.getByText("No fixtures published", { exact: true }).waitFor();
  passed.push("validated empty snapshot");
  await control("initial");
  gate = new Promise(resolve => { release = resolve; });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText(/Loading.*matches|Loading.*scores/i).first().waitFor({ timeout: 3000 });
  release();
  const score = page.locator('.score-day [data-match-id="900001"]');
  await score.getByText("1 – 0", { exact: true }).waitFor();
  passed.push("loading to Worker stored-score response");
  await control("stale"); await page.reload({ waitUntil: "domcontentloaded" });
  await score.getByText("1 – 0", { exact: true }).waitFor();
  await page.getByText("Live data is behind", { exact: true }).waitFor();
  passed.push("read outage preserves score and age warning");
  await control("correction"); await page.reload({ waitUntil: "domcontentloaded" });
  await score.getByText("0 – 0", { exact: true }).waitFor();
  await page.getByText("Live data is behind", { exact: true }).waitFor({ state: "hidden" });
  passed.push("new version accepts downward correction and clears warning");
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error("Overflow at " + width);
  }
  const state = await control("state");
  if (state.forbiddenCalls || errors.length) throw Error(JSON.stringify({ ...state, errors }));
  passed.push("mobile and desktop layouts; zero provider calls");
  return { passed, errors, reads: state.reads, forbiddenCalls: state.forbiddenCalls };
}

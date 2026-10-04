// Isolated site preview :8742 and score-service-server.mjs :8743.
async page => {
  const errors = [], passed = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.clock.install({ time: new Date("2026-10-13T19:30:00Z") });
  await page.route("**/data/*/scorers.json*", route => route.fulfill({ json: { scorers: [] } }));
  await page.route("**/data/*/live.json*", route => route.fulfill({ status: 503 }));
  let release;
  let gate = Promise.resolve();
  await page.route("https://goon-squad-data.gs-wc.workers.dev/**", async route => {
    if (!route.request().url().endsWith("/CL/live")) return route.fulfill({ status: 404 });
    await gate;
    const response = await route.fetch({ url: "http://127.0.0.1:8743/CL/live" });
    await route.fulfill({ response });
  });
  const control = path => page.request.get("http://127.0.0.1:8743/" + path);
  const reload = () => page.reload({ waitUntil: "domcontentloaded" });
  await control("reset");
  await page.goto("http://127.0.0.1:8742/#live?competition=CL");
  await page.locator('[data-scores-retry]').waitFor();
  passed.push("not-yet-collected scores remain an error with retry");
  await control("empty");
  await page.locator('[data-scores-retry]').click();
  await page.getByText("No fixtures published", { exact: true }).waitFor();
  passed.push("validated empty discovery differs from collection failure");
  await control("initial");
  gate = new Promise(resolve => { release = resolve; });
  await reload();
  await page.getByText(/Loading.*matches|Loading.*scores/i).first().waitFor({ timeout: 3000 });
  release();
  const score = page.locator('.score-day [data-match-id="900001"]');
  await score.getByText("1 – 0", { exact: true }).waitFor();
  passed.push("loading transitions to stored scores");
  await control("stall");
  await page.clock.setFixedTime(new Date("2026-10-13T19:31:00Z"));
  await reload();
  await score.getByText("1 – 0", { exact: true }).waitFor();
  await page.getByText("Live data is behind", { exact: true }).waitFor();
  passed.push("collector stall preserves score and exposes original data age");
  await control("recover");
  await page.clock.setFixedTime(new Date("2026-10-13T19:31:01Z"));
  await reload();
  await score.getByText("2 – 0", { exact: true }).waitFor();
  await page.getByText("Live data is behind", { exact: true }).waitFor({ state: "hidden" });
  passed.push("new collector observation updates scores and clears stale warning");
  await control("mixed-age");
  await page.clock.setFixedTime(new Date("2026-10-13T19:31:02Z"));
  await reload();
  await score.getByText("3 – 0", { exact: true }).waitFor();
  await page.getByText("Live data is behind", { exact: true }).waitFor();
  passed.push("new snapshot version keeps fresh scores while exposing another game's older age");
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error("Overflow at " + width);
  }
  if (errors.length) throw Error(errors.join("\n"));
  const state = await (await control("state")).json();
  if (state.publications !== 4) throw Error("A viewer read changed published data");
  passed.push("mobile and desktop layouts", "reads never publish");
  return { passed, errors, publications: state.publications };
}

// Preview on 8732; feeder-browser-server.mjs on 8733 with FEEDER_TRACE and matching competition.
async (browserPage) => {
  const competition = process.env.QA_COMPETITION ?? 'CL';
  const context = await browserPage.context().browser().newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'UTC' });
  try {
    const page = await context.newPage();
    const errors = [], visible = [];
    page.on('pageerror', error => errors.push(error.message));
    const { deliveries: samples, startedAt: start } = await (await page.request.get('http://127.0.0.1:8733/schedule')).json();
    if (samples.length < 5) throw Error('Trace has too few live deliveries');
    await page.clock.install({ time: new Date(start + samples[0].at) });
    await page.route('**/data/*/scorers.json*', r => r.fulfill({ json: { scorers: [] } }));
    await page.route('**/data/*/live.json*', r => r.fulfill({ status: 503 }));
    await page.route('https://goon-squad-data.gs-wc.workers.dev/**', async route => {
      if (!route.request().url().endsWith(`/${competition}/live`)) return route.fulfill({ status: 404 });
      const response = await route.fetch({ url: `http://127.0.0.1:8733/${competition}/live` });
      const data = await response.json();
      if (!data.ingestedLive) throw Error('Scores did not use the backup');
      await route.fulfill({ response, headers: { ...response.headers(), 'access-control-allow-origin': '*' } });
    });
    for (const [index, sample] of samples.entries()) {
      if (index) {
        await page.request.get('http://127.0.0.1:8733/next');
        await page.clock.setFixedTime(new Date(start + sample.at));
        await page.reload();
      } else await page.goto(`http://127.0.0.1:8732/#live?competition=${competition}`);
      const score = `${sample.score} – 0`;
      await page.locator('.score-day [data-match-id="900001"]').getByText(score, { exact: true }).waitFor();
      await page.getByText('Live data is behind', { exact: true }).waitFor();
      if (new Date(start + sample.at).getUTCDate() !== new Date(start).getUTCDate()) {
        await page.getByText('Includes matches still live from yesterday.', { exact: true }).waitFor();
      }
      visible.push({ at: sample.at, score });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    if (!await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)) throw Error('Desktop overflow');
    if (errors.length) throw Error(errors.join('; '));
    return { competition, visible, errors };
  } finally { await context.close(); }
}

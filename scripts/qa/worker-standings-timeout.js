// Requires the isolated preview on 8732 and stalled-standings-server.mjs on 8733.
async (browserPage) => {
  const passed = [];
  for (const width of [1440, 390]) {
    const context = await browserPage.context().browser().newContext({ viewport: { width, height: 900 } });
    try {
      const page = await context.newPage();
      const errors = [], timings = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.request.get('http://127.0.0.1:8733/reset/' + (width === 390 ? 'body' : 'healthy'));
      await page.clock.install({ time: new Date('2026-09-19T15:00:00Z') });
      await page.route('**/data/*/scorers.json*', route => route.fulfill({ json: { scorers: [] } }));
      await page.route('**/data/*/live.json*', route => route.fulfill({ status: 503 }));
      await page.route('https://goon-squad-data.gs-wc.workers.dev/**', async route => {
        if (!route.request().url().endsWith('/CL/live')) return route.fulfill({ status: 404 });
        const response = await route.fetch({ url: 'http://127.0.0.1:8733/CL/live' });
        timings.push(Number(response.headers()['x-fixture-duration-ms']));
        await route.fulfill({ response, headers: { ...response.headers(), 'access-control-allow-origin': '*' } });
      });
      await page.goto('http://127.0.0.1:8732/#live?competition=CL');
      const score = page.locator('.score-day [data-match-id="900001"] .mline__score');
      await score.waitFor({ timeout: 4000 });
      if (width === 1440) {
        if (await score.innerText() !== '1 – 0') throw Error('Initial score missing');
        await page.request.get('http://127.0.0.1:8733/mode/slow');
        await page.clock.setFixedTime(new Date('2026-09-19T15:06:01Z'));
        await page.reload();
        await score.waitFor({ timeout: 4000 });
      }
      if (await score.innerText() !== '2 – 0') throw Error('Slow table lost the fresh score');
      const slow = timings.at(-1);
      if (slow < 1400 || slow >= 2500) throw Error('Unexpected supplementary wait: ' + slow);
      if (await page.getByText('Live data is behind', { exact: true }).count()) throw Error('Table delay incorrectly marked scores stale');
      if (width === 390) await page.locator('[data-tab="tables"]').click();
      const tableArea = width === 1440 ? page.getByRole('complementary', { name: 'League standings' }) : page.locator('#layout');
      await tableArea.getByText(width === 1440 ? 'Showing the saved table' : 'Standings temporarily unavailable.', { exact: false }).waitFor();
      if (width === 1440 && await tableArea.locator('.minirow__pts').innerText() !== '3') throw Error('Saved table was changed');
      await page.request.get('http://127.0.0.1:8733/mode/recovered');
      await page.clock.setFixedTime(new Date(width === 1440 ? '2026-09-19T15:12:02Z' : '2026-09-19T15:06:01Z'));
      await tableArea.getByRole('button', { name: 'Retry', exact: true }).click();
      await tableArea.getByText(width === 1440 ? 'Showing the saved table' : 'Standings temporarily unavailable.', { exact: false }).waitFor({ state: 'hidden' });
      if (width === 1440 && await tableArea.locator('.minirow__pts').innerText() !== '6') throw Error('Table did not recover');
      if (width === 390) await page.locator('[data-tab="live"]').click();
      await page.locator('.score-day [data-match-id="900001"]').getByText('3 – 0', { exact: true }).waitFor();
      if (!await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)) throw Error('Horizontal overflow');
      if (errors.length) throw Error(errors.join('; '));
      passed.push({ width, timings, states: [width === 1440 ? 'saved table after header timeout' : 'unavailable table after body timeout', 'fresh score preserved', 'Retry recovers table and score'] });
    } finally { await context.close(); }
  }
  return { passed };
}

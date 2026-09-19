// Local production preview on 8732; feeder-browser-server.mjs on 8733.
async (browserPage) => {
  const context = await browserPage.context().browser().newContext({ viewport: { width: 390, height: 844 } });
  try {
    const page = await context.newPage();
    const errors = [], samples = [];
    page.on('pageerror', error => errors.push(error.message));
    let now = Date.parse('2026-09-19T15:00:00Z');
    await page.clock.install({ time: new Date(now) });
    await page.route('**/data/*/scorers.json*', r => r.fulfill({ json: { scorers: [] } }));
    await page.route('**/data/*/live.json*', r => r.fulfill({ status: 503 }));
    await page.route('https://goon-squad-data.gs-wc.workers.dev/**', async route => {
      if (!route.request().url().endsWith('/PL/live')) return route.fulfill({ status: 404 });
      const response = await route.fetch({ url: 'http://127.0.0.1:8733/PL/live' });
      const data = await response.json();
      if (!data.ingestedLive) throw Error('Fixture did not use the backup ingestion path');
      samples.push({ score: data.matches[0].score.home, ageMs: data.staleAgeMs });
      await route.fulfill({ response, headers: { ...response.headers(), 'access-control-allow-origin': '*' } });
    });
    await page.goto('http://127.0.0.1:8732/#live?competition=PL');
    const check = async score => {
      await page.locator('.score-day [data-match-id="900001"]').getByText(`${score} – 0`, { exact: true }).waitFor();
      await page.getByText('Live data is behind', { exact: true }).waitFor();
    };
    await check(1);
    for (const [seconds, score] of [[60, 2], [72, 3], [121, 3], [60, 4]]) {
      await page.request.get('http://127.0.0.1:8733/step/' + seconds);
      now += seconds * 1000;
      await page.clock.setFixedTime(new Date(now));
      await page.reload();
      await check(score);
      if (seconds === 121 && !(await page.locator('#updated').innerText()).includes('2m ago')) throw Error('Missed backup push was hidden');
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    if (!await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)) throw Error('Desktop overflow');
    if (errors.length) throw Error(errors.join('; '));
    return { samples, passed: ['backup updates visible during primary refusal', 'handoff update visible', 'missing push retains score with correct age', 'next push recovers'], errors };
  } finally { await context.close(); }
}

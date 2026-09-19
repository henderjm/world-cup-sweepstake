// Run against an isolated production preview on 8732; all data is synthetic.
async (browserPage) => {
  const passed = [];
  for (const width of [390, 1440]) {
    const context = await browserPage.context().browser().newContext({ viewport: { width, height: 900 } });
    try {
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      let mode = 'stalled';
      let score = 2;
      const stale = width === 1440;
      await page.clock.install({ time: new Date('2026-09-19T13:10:00Z') });
      await page.route('**/data/*/scorers.json*', route => {
        if (mode === 'stalled') return;
        if (mode === 'error') return route.fulfill({ status: 503 });
        return route.fulfill({ json: { scorers: mode === 'empty' ? [] : [{ player: 'Example Player', team: 'Home', goals: 2, assists: 1, points: 3 }] } });
      });
      await page.route('https://goon-squad-data.gs-wc.workers.dev/**', route => {
        if (!route.request().url().endsWith('/CL/live')) return route.fulfill({ status: 404 });
        return route.fulfill({ json: {
          source: 'Browser fixture', competition: 'CL', season: 2026,
          lastUpdated: stale ? '2026-09-19T13:07:00Z' : '2026-09-19T13:10:00Z', stale,
          matches: [{ id: 990001, utcDate: '2026-09-19T13:00:00Z', stage: 'LEAGUE_STAGE', status: 'IN_PLAY', homeTeam: 'Home', awayTeam: 'Away', score: { home: score, away: 0 } }],
          standings: [{ type: 'TOTAL', table: [{ position: 1, team: { name: 'Home' }, playedGames: 1, won: 1, draw: 0, lost: 0, points: 3, goalsFor: 1, goalsAgainst: 0, goalDifference: 1 }] }],
        } });
      });
      const started = Date.now();
      await page.goto('http://127.0.0.1:8732/#live?competition=CL');
      await page.getByRole('heading', { name: 'Loading scores…', exact: true }).waitFor();
      await page.locator('.score-day [data-match-id="990001"]').getByText('2 – 0', { exact: true }).waitFor({ timeout: 3000 });
      const elapsed = Date.now() - started;
      if (elapsed >= 3500) throw Error('Scorer request held up scores: ' + elapsed);
      if (stale) await page.getByText('Live data is behind', { exact: true }).waitFor();
      await page.locator('[data-tab="stats"]').click();
      const unavailable = page.getByText('Player statistics temporarily unavailable.', { exact: false });
      const retry = unavailable.getByRole('button', { name: 'Retry', exact: true });
      await unavailable.waitFor();
      mode = 'error';
      const [failed] = await Promise.all([page.waitForResponse(response => response.url().includes('scorers.json')), retry.click()]);
      if (failed.status() !== 503) throw Error('Retry did not exercise the failed response');
      await unavailable.waitFor();
      mode = 'empty';
      await retry.click();
      await page.getByText('Player statistics are not published yet.', { exact: true }).waitFor();
      mode = 'healthy'; score = 3;
      await page.reload();
      await page.getByText('Example Player', { exact: true }).waitFor();
      if (await unavailable.count()) throw Error('Recovery retained an unavailable marker');
      await page.locator('[data-tab="live"]').click();
      await page.locator('.score-day [data-match-id="990001"]').getByText('3 – 0', { exact: true }).waitFor();
      if (!await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)) throw Error('Horizontal overflow');
      if (errors.length) throw Error(errors.join('; '));
      passed.push({ width, scoreVisibleMs: elapsed, states: ['loading', 'stalled stats', 'failed retry', 'unpublished stats', 'recovered stats and score', stale ? 'delayed feed retained' : 'fresh feed retained'] });
    } finally { await context.close(); }
  }
  return { passed };
}

// Run against the isolated production preview on port 8732.
async (browserPage) => {
  const browser = browserPage.context().browser();
  const passed = [];
  const assert = (value, message) => { if (!value) throw Error(message); };
  for (const scenario of ['normal', 'loading', 'error', 'empty']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    let release;
    const held = new Promise(resolve => { release = resolve; });
    let failed = scenario === 'error';
    let points = 3;
    const feed = code => ({ competition: code, source: 'Browser fixture', lastUpdated: '2026-09-10T19:20:00Z',
      standings: scenario === 'empty' && code === 'CL' ? [] : [{ type: 'TOTAL', table: [{ position: 1, team: { name: `${code} Home` }, playedGames: 1, won: 1, draw: 0, lost: 0, goalsFor: 1, goalsAgainst: 0, goalDifference: 1, points }] }],
      matches: code === 'CL' ? [{ id: 900002, utcDate: '2026-09-10T19:00Z', homeTeam: 'CL Home', awayTeam: 'CL Away', status: 'IN_PLAY', stage: 'LEAGUE_STAGE', score: { home: 1, away: 0 } }] : [],
    });
    try {
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.clock.install({ time: new Date('2026-09-10T19:20:10Z') });
      await page.addInitScript(() => localStorage.setItem('gs-local-follows', JSON.stringify([{ competition: 'CL', team: 'CL Home' }])));
      await context.route('**/data/*/scorers.json*', route => route.fulfill({ json: { scorers: [] } }));
      await context.route('**/data/*/live.json*', route => route.fulfill({ status: 503 }));
      await context.route('https://goon-squad-data.gs-wc.workers.dev/**', async route => {
        const code = route.request().url().endsWith('/CL/live') ? 'CL' : route.request().url().endsWith('/PL/live') ? 'PL' : null;
        if (!code) return route.fulfill({ status: 404 });
        if (code === 'CL' && scenario === 'loading') await held;
        return code === 'CL' && failed ? route.fulfill({ status: 503 }) : route.fulfill({ json: feed(code) });
      });
      await page.goto('http://127.0.0.1:8732/#live?date=2026-09-10&following=1');
      const aside = page.getByRole('complementary', { name: 'League standings' });
      const selector = aside.getByLabel('Competition');
      await selector.waitFor();
      await selector.selectOption('CL');
      if (scenario === 'loading') {
        await aside.getByText('Loading standings…', { exact: true }).waitFor({ timeout: 2000 });
        release();
        await aside.getByRole('table').waitFor();
        passed.push('standings loading and recovery');
      } else if (scenario === 'error') {
        await aside.getByText('Standings unavailable.', { exact: true }).waitFor();
        failed = false;
        await aside.getByRole('button', { name: 'Retry standings' }).click();
        await aside.getByRole('table').waitFor();
        passed.push('initial failure and retry');
      } else if (scenario === 'empty') {
        await aside.getByText('No standings published yet.', { exact: true }).waitFor();
        passed.push('missing standings distinguished from errors');
      } else {
        await aside.getByRole('table', { name: 'Champions League standings' }).waitFor();
        const route = page.url();
        await selector.selectOption('PL');
        assert(page.url() === route, 'Table selection changed score filters');
        assert(await page.locator('.score-day [data-match-id]').count() === 1, 'Table selection filtered the matches');
        await aside.getByRole('table', { name: 'Premier League standings' }).waitFor();
        await selector.focus();
        points = 6;
        await page.clock.runFor(20000);
        await page.waitForFunction(() => document.querySelector('.minirow__pts')?.textContent === '6');
        assert(await selector.evaluate(e => e === document.activeElement && e.value === 'PL'), 'Polling lost table selection or focus');
        await selector.selectOption('CL');
        failed = true;
        await page.clock.runFor(20000);
        await aside.getByText('Standings updates delayed.', { exact: false }).waitFor();
        assert(await aside.getByRole('table').count() === 1, 'Delayed feed erased standings');
        failed = false;
        await aside.getByRole('button', { name: 'Retry', exact: true }).click();
        await aside.getByText('Standings updates delayed.', { exact: false }).waitFor({ state: 'hidden' });
        await selector.selectOption('PL');
        await aside.getByRole('button', { name: 'Full Premier League table' }).click();
        await page.locator('[data-tab="tables"].is-active').waitFor();
        assert(page.url().includes('competition=PL') && page.url().includes('following=1') && page.url().includes('date=2026-09-10'), 'Full table lost league or filters');
        await page.goBack();
        await selector.waitFor();
        assert(await selector.inputValue() === 'PL', 'Back navigation lost the table choice');
        for (const width of [1440, 1200, 1024, 390, 320]) {
          await page.setViewportSize({ width, height: width < 500 ? 844 : 1000 });
          await page.waitForFunction(w => document.documentElement.clientWidth === w, width);
          assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Overflow at ' + width);
          assert(await aside.isVisible() === (width >= 1200), 'Wrong standings visibility at ' + width);
        }
        passed.push('independent table selection', 'date and Following preserved', 'table updates during polling', 'selector focus retained', 'delayed data retained and recovered', 'full table and Back', '1440/1200/1024/390/320 layouts');
      }
      assert(errors.length === 0, errors.join('\n'));
    } finally { release(); await context.close(); }
  }
  return { passed };
}

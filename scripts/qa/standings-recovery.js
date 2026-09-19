async (browserPage) => {
  const passed = [];
  for (const scenario of ['saved', 'cold', 'unavailable', 'preseason', 'wrong-season', 'storage-blocked']) {
    const c = await browserPage.context().browser().newContext({ viewport: { width: 1440, height: 1000 } });
    const p = await c.newPage();
    const assert = (ok, text) => { if (!ok) throw Error(text); };
    let complete = scenario === 'saved' || scenario === 'storage-blocked';
    let score = 1;
    let reads = 0;
    const table = [{ type: 'TOTAL', table: [{ position: 1, team: { name: 'Home' }, playedGames: 1, won: 1, draw: 0, lost: 0, points: 3, goalsFor: 1, goalsAgainst: 0, goalDifference: 1 }] }];
    const raw = () => ({ competition: 'PL', season: 2026, source: 'Browser fixture', lastUpdated: '2026-09-19T12:00:00Z', standings: complete ? table : [], matches: [{ id: 900001, utcDate: '2026-09-19T11:30:00Z', homeTeam: 'Home', awayTeam: 'Away', status: scenario === 'preseason' ? 'TIMED' : 'IN_PLAY', score: { home: score, away: 0 } }] });
    const old = { ...raw(), season: scenario === 'wrong-season' ? 2025 : 2026, lastUpdated: '2026-09-19T11:00:00Z', standings: table };
    const errors = []; p.on('pageerror', e => errors.push(e.message));
    try {
      await p.clock.install({ time: new Date('2026-09-19T12:00:05Z') });
      if (scenario === 'storage-blocked') await p.addInitScript(() => { Storage.prototype.getItem = () => { throw Error('blocked'); }; Storage.prototype.setItem = () => { throw Error('blocked'); }; });
      await p.route('**/data/*/scorers.json*', r => r.fulfill({ json: {} }));
      await p.route('**/data/PL/live.json*', r => { reads++; return scenario === 'unavailable' ? r.fulfill({ status: 503 }) : r.fulfill({ json: old }); });
      await p.route('https://goon-squad-data.gs-wc.workers.dev/**', r => r.request().url().includes('/PL/live') ? r.fulfill({ json: raw() }) : r.fulfill({ status: 404 }));
      await p.goto('http://127.0.0.1:8732/#live?competition=PL');
      const aside = p.getByRole('complementary', { name: 'League standings' });
      await p.locator('.score-day [data-match-id]').waitFor();
      if (complete) {
        await aside.getByRole('table').waitFor();
        complete = false; score = 2;
        await p.clock.runFor(20000);
        await p.locator('.score-day').getByText('2 – 0', { exact: true }).waitFor();
        assert(reads === 0, 'Known table caused a redundant static read');
      }
      if (['unavailable', 'wrong-season'].includes(scenario)) {
        await aside.getByText('Standings temporarily unavailable.', { exact: false }).waitFor();
        assert(await aside.getByRole('table').count() === 0, 'Invented or wrong-season table');
      } else if (scenario === 'preseason') {
        await aside.getByText('No standings published yet.', { exact: true }).waitFor();
        assert(reads === 0, 'Unstarted season fetched a table');
      } else {
        await aside.getByText('Showing the saved table', { exact: false }).waitFor();
        assert(await aside.locator('.minirow__pts').innerText() === '3', 'Saved table incorrectly projected live score');
        assert(await aside.locator('[data-feed-age]').count() === 0, 'Saved table inherited fresh score timestamp');
        if (scenario !== 'storage-blocked') {
          await p.reload();
          await aside.getByText('Showing the saved table', { exact: false }).waitFor();
        }
        if (scenario === 'cold') await p.screenshot({ path: '/Users/markhender/personal-projects/world-cup-sweepstake/docs/live-score-evidence/standings-recovery-desktop.png' });
        await p.setViewportSize({ width: 390, height: 844 });
        await p.goto('http://127.0.0.1:8732/#tables?competition=PL');
        await p.getByText('Showing the saved table', { exact: false }).first().waitFor();
        assert(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile table overflow');
        if (scenario === 'cold') await p.screenshot({ path: '/Users/markhender/personal-projects/world-cup-sweepstake/docs/live-score-evidence/standings-recovery-mobile.png' });
      }
      if (scenario !== 'preseason') {
        complete = true;
        const retry = p.locator('[data-score-feed-retry="PL"]').filter({ visible: true }).first();
        await retry.click();
        await p.getByText('Showing the saved table', { exact: false }).waitFor({ state: 'hidden' });
        await p.getByText('Standings temporarily unavailable.', { exact: false }).waitFor({ state: 'hidden' });
      }
      assert(errors.length === 0, errors.join('; '));
      passed.push(scenario + ': correct table state, score continuity, recovery and layout');
    } finally { await c.close(); }
  }
  return { passed };
}

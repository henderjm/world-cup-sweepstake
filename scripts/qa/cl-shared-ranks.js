async (browserPage) => {
  const passed = [];
  for (const width of [390, 1440]) {
    const context = await browserPage.context().browser().newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage(); const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const teams = ['Home', 'Away', 'Other', 'Fourth'];
    const check = (value, message) => { if (!value) throw Error(message); };
    try {
      await page.clock.install({ time: new Date('2026-10-13T19:10:00Z') });
      await page.route('**/data/**', r => r.fulfill({ json: { scorers: [] } }));
      await page.route('https://goon-squad-data.gs-wc.workers.dev/**', r => r.request().url().endsWith('/CL/live') ? r.fulfill({ json: {
        competition: 'CL', season: 2026, lastUpdated: '2026-10-13T19:10:00Z',
        standings: [{ type: 'TOTAL', table: teams.map((team, i) => ({ position: i + 1, team: { name: team },
          playedGames: 0, won: 0, draw: 0, lost: 0, points: 0, goalDifference: 0, goalsFor: 0, awayGoals: 0, awayWins: 0 })) }],
        matches: [0, 2].map(i => ({ id: 990010 + i, homeTeam: teams[i], awayTeam: teams[i + 1], stage: 'LEAGUE_STAGE',
          status: 'IN_PLAY', utcDate: '2026-10-13T19:00:00Z', score: { home: 0, away: 0 } })),
      } }) : r.fulfill({ status: 404 }));
      await page.goto('http://127.0.0.1:8731/#tables?competition=CL');
      await page.locator('.ltable__posnum').first().waitFor();
      check(JSON.stringify(await page.locator('.ltable__posnum').allTextContents()) === '["1","1","1","1"]', 'Live table lost shared ranks');
      check(await page.getByText('Some tied positions remain', { exact: false }).count() === 0, 'Known interim tie labelled incomplete');
      check(await page.getByText('Shared ranks:', { exact: false }).count() === 1, 'Shared-rank explanation missing');
      check(await page.getByText('As it stands:', { exact: false }).count() === 1, 'Live projection disclosure missing');
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Horizontal overflow');
      check(errors.length === 0, errors.join('; '));
      await page.screenshot({ path: `/tmp/kickoff-cl-shared-ranks-${width}.png` });
      passed.push({ width, ranks: [1, 1, 1, 1], errors });
    } finally { await context.close(); }
  }
  return { passed };
}

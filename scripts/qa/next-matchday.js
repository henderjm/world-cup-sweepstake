async (browserPage) => {
  const passed = [];
  const assert = (value, message) => { if (!value) throw Error(message); };
  for (const width of [390, 1440]) for (const competition of [null, 'CL']) {
    const context = await browserPage.context().browser().newContext({ viewport: { width, height: 900 }, timezoneId: 'Europe/Dublin' });
    const page = await context.newPage(); const errors = [];
    page.on('pageerror', error => errors.push(error.stack));
    try {
      await page.clock.install({ time: new Date('2026-10-04T12:00:00Z') });
      await page.addInitScript(() => localStorage.setItem('gs-local-follows', JSON.stringify([{ competition: 'CL', team: 'Arsenal' }])));
      await page.route('**/data/**', r => r.fulfill({ json: { matches: [], standings: [], scorers: [] } }));
      await page.route('https://goon-squad-data.gs-wc.workers.dev/**', r => {
        if (!r.request().url().endsWith('/CL/live')) return r.fulfill({ status: 503 });
        return r.fulfill({ json: { competition: 'CL', season: 2026, source: 'Local browser fixture',
          lastUpdated: '2026-10-04T11:00:00Z', stale: true, staleAgeMs: 3600000, standings: [], matches: [
            { id: 990001, homeTeam: 'Lens', awayTeam: 'Sporting CP', status: 'TIMED', stage: 'LEAGUE_STAGE', utcDate: '2026-10-13T17:45:00Z' },
            { id: 990002, homeTeam: 'Arsenal', awayTeam: 'Lille', status: 'TIMED', stage: 'LEAGUE_STAGE', utcDate: '2026-10-13T20:00:00Z' },
          ] } });
      });
      const hash = '#live?date=2026-10-04&live=1&following=1' + (competition ? '&competition=CL' : '');
      await page.goto('http://127.0.0.1:8731/' + hash);
      const jump = page.getByRole('link', { name: 'View upcoming matches', exact: true });
      await jump.waitFor();
      assert((await page.locator('.score-day').innerText()).includes('Next: Arsenal v Lille'), 'Followed fixture not prioritized');
      assert((await jump.boundingBox()).height >= 44, 'Shortcut touch target is too small');
      await jump.click();
      await page.locator('.score-day [data-match-id="990002"]').waitFor();
      assert(await page.locator('[data-score-date]').inputValue() === '2026-10-13', 'Shortcut missed target date');
      assert(await page.locator('[data-score-action="live"]').getAttribute('aria-pressed') === 'false', 'Upcoming fixtures hidden behind Live');
      assert(await page.locator('[data-score-action="following"]').getAttribute('aria-pressed') === 'true', 'Following was cleared');
      assert(await page.locator('.score-day [data-match-id="990001"]').count() === 0, 'Unfollowed fixture leaked');
      assert(new URLSearchParams(page.url().split('?')[1]).get('competition') === competition, 'Competition scope changed');
      assert((await page.locator('body').innerText()).includes(competition ? 'Live data is behind' : 'Live updates delayed'), 'Saved schedule lost stale disclosure');
      await page.locator('.score-day [data-match-id="990002"]').click();
      await page.keyboard.press('Escape');
      assert(await page.locator('[data-score-date]').inputValue() === '2026-10-13', 'Detail return lost target date');
      await page.goBack(); await jump.waitFor();
      assert(await page.locator('[data-score-action="live"]').getAttribute('aria-pressed') === 'true', 'Back lost original Live filter');
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Horizontal overflow');
      assert(!errors.length, errors.join('; '));
      await page.screenshot({ path: `/tmp/kickoff-next-matchday-${width}-${competition ?? 'all'}.png` });
      passed.push({ width, competition, shortcut: 'followed matchday, stale disclosure, detail return and Back verified' });
    } finally { await context.close(); }
  }
  return { passed };
}

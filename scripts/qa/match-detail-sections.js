// Run against the isolated release preview on 8732; all service requests are intercepted.
async (browserPage) => {
  const passed = [];
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  for (const width of [320, 390, 1440]) {
    const context = await browserPage.context().browser().newContext({ viewport: { width, height: 844 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let count = 25;
    let unavailable = false;
    let loading = true;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const feed = () => ({ competition: 'CL', source: 'Browser fixture', lastUpdated: new Date().toISOString(), standings: [], matches: [{ id: 900001, homeTeam: 'Home', awayTeam: 'Away', utcDate: '2026-09-11T12:00:00Z', status: 'IN_PLAY', minute: count, stage: 'LEAGUE_STAGE', matchday: 1, score: { home: 1, away: 0 } }] });
    const detail = () => ({ id: 900001, goals: [{ minute: 1, scorer: 'Scorer', team: 'Home' }], cards: Array.from({ length: count }, (_, i) => ({ minute: i + 2, player: `Card ${i + 1}`, team: 'Home', card: 'YELLOW' })), home: { name: 'Home', lineup: Array.from({ length: 11 }, (_, i) => ({ name: `Home player ${i + 1}`, num: i + 1 })) }, away: { name: 'Away', lineup: Array.from({ length: 11 }, (_, i) => ({ name: `Away player ${i + 1}`, num: i + 1 })) }, playerStats: [{ playerId: 1 }] });
    try {
      await page.clock.install({ time: new Date('2026-09-11T12:30:00Z') });
      await page.addInitScript(() => localStorage.setItem('gs-session', 'intercepted-test-session'));
      await page.route('**/data/CL/matches/*', route => route.fulfill({ status: 503, body: 'Unavailable' }));
      await page.route('https://goon-squad-data.gs-wc.workers.dev/**', async route => {
        const path = route.request().url().split('workers.dev')[1].split('?')[0];
        if (path === '/CL/live') return route.fulfill({ json: feed() });
        if (path === '/me') return route.fulfill({ json: { user: { email: 'qa@example.invalid', name: 'QA', prefs: {} }, follows: [] } });
        if (path === '/banter/900001') return route.fulfill({ json: { reactions: { counts: {}, mine: [] }, messages: [] } });
        if (path === '/match/900001') {
          if (loading) await gate;
          return unavailable ? route.fulfill({ status: 503, body: 'Unavailable' }) : route.fulfill({ json: detail() });
        }
        return route.fulfill({ status: 404, body: 'Not in fixture' });
      });
      await page.goto('http://127.0.0.1:8732/#live?competition=CL');
      await page.locator('.score-day [data-match-id]').click();
      await page.getByText('Loading timeline…', { exact: true }).waitFor();
      await page.getByRole('navigation', { name: 'Match sections' }).getByRole('button', { name: 'Line-ups', exact: true }).click();
      assert(await page.locator('#mdLineups').evaluate(e => e === document.activeElement), 'Loading section not keyboard reachable');
      loading = false;
      release();
      await page.getByText('Home player 1', { exact: false }).first().waitFor();
      assert(await page.locator('#mdLineups').evaluate(e => e === document.activeElement), 'Loading completion lost section focus');
      const hash = await page.evaluate(() => location.hash);
      const nav = page.getByRole('navigation', { name: 'Match sections' });
      await nav.getByRole('button', { name: 'Line-ups', exact: true }).click();
      const before = await page.locator('#mdLineups').evaluate(e => e.getBoundingClientRect().top);
      count = 30;
      await page.clock.runFor(20000);
      await page.getByText('Card 30', { exact: false }).waitFor();
      const after = await page.locator('#mdLineups').evaluate(e => e.getBoundingClientRect().top);
      assert(Math.abs(before - after) < 2, `Line-ups jumped ${after - before}px at ${width}`);
      assert(await page.locator('#mdLineups').evaluate(e => e === document.activeElement), 'Polling lost section focus');
      await nav.getByRole('button', { name: 'Banter', exact: true }).click();
      const input = page.getByRole('textbox', { name: 'Your banter' });
      await input.fill('Keep my unfinished thought');
      const inputTop = await input.evaluate(e => e.getBoundingClientRect().top);
      count = 35;
      await page.clock.runFor(20000);
      await page.getByText('Card 35', { exact: false }).waitFor();
      assert(await input.inputValue() === 'Keep my unfinished thought', 'Polling erased draft');
      assert(await input.evaluate(e => e === document.activeElement), 'Polling moved composer focus');
      assert(Math.abs((await input.evaluate(e => e.getBoundingClientRect().top)) - inputTop) < 2, 'Growing timeline moved the composer');
      unavailable = true;
      await page.clock.runFor(20000);
      await page.locator('#mdUpdate').waitFor({ state: 'visible' });
      assert(await page.getByText('Card 35', { exact: false }).count() === 1, 'Failed refresh erased timeline');
      assert(Math.abs((await input.evaluate(e => e.getBoundingClientRect().top)) - inputTop) < 2, 'Failure banner moved the composer');
      await nav.getByRole('button', { name: 'Timeline', exact: true }).click();
      assert(await page.locator('#mdTimeline').evaluate(e => e.getBoundingClientRect().top >= document.querySelector('.dz__tools').getBoundingClientRect().bottom), 'Toolbar covers timeline');
      unavailable = false;
      await page.getByRole('button', { name: 'Try again', exact: true }).click();
      await page.locator('#mdUpdate').waitFor({ state: 'hidden' });
      await nav.getByRole('button', { name: 'Overview', exact: true }).click();
      assert(await page.evaluate(() => location.hash) === hash, 'Section navigation changed score route');
      assert(await page.locator('.dz__panel').evaluate(e => e.scrollWidth <= e.clientWidth), 'Drawer overflow');
      assert(await nav.getByRole('button').evaluateAll(nodes => nodes.every(e => e.getBoundingClientRect().height >= 44)), 'Section touch target too small');
      if (width === 390) await page.screenshot({ path: '/Users/markhender/personal-projects/world-cup-sweepstake/docs/live-score-evidence/mobile-match-sections.png' });
      await nav.getByRole('button', { name: 'Line-ups', exact: true }).click();
      if (width === 1440) await page.screenshot({ path: '/Users/markhender/personal-projects/world-cup-sweepstake/docs/live-score-evidence/desktop-match-sections.png' });
      await page.keyboard.press('Escape');
      assert(await page.locator('.score-day [data-match-id]').evaluate(e => e === document.activeElement), 'Close lost match focus');
      assert(errors.length === 0, errors.join('; '));
      passed.push(`${width}px: loading navigation, stable line-ups, stable banter draft, stale retention/retry, route and focus preservation, touch targets, no overflow`);
    } finally { release(); await context.close(); }
  }
  for (const status of ['TIMED', 'IN_PLAY', 'FINISHED', 'POSTPONED', 'CANCELLED', 'ERROR']) {
    const context = await browserPage.context().browser().newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    let failure = status === 'ERROR';
    try {
      await page.clock.install({ time: new Date('2026-09-11T12:30:00Z') });
      const feed = { competition: 'CL', source: 'Browser fixture', lastUpdated: '2026-09-11T12:30:00Z', standings: [], matches: [{ id: 900001, homeTeam: 'Home', awayTeam: 'Away', utcDate: '2026-09-11T12:00:00Z', status: status === 'ERROR' ? 'IN_PLAY' : status, stage: 'LEAGUE_STAGE', matchday: 1, score: { home: null, away: null } }] };
      await page.route('**/data/CL/matches/*', route => route.fulfill({ status: 503, body: 'Unavailable' }));
      await page.route('https://goon-squad-data.gs-wc.workers.dev/**', route => {
        const path = route.request().url().split('workers.dev')[1].split('?')[0];
        if (path === '/CL/live') return route.fulfill({ json: feed });
        if (path === '/match/900001') return failure ? route.fulfill({ status: 503, body: 'Unavailable' }) : route.fulfill({ json: { id: 900001, venue: 'Test stadium' } });
        return route.fulfill({ status: 404, body: 'Not in fixture' });
      });
      await page.goto('http://127.0.0.1:8732/#live?competition=CL');
      await page.locator('.score-day [data-match-id]').click();
      await page.locator('[data-md-loading]').waitFor({ state: 'detached' });
      const text = await page.locator('#mdBody').innerText();
      assert(status === 'TIMED' ? text.includes('match has not started') : text.includes('Timeline unavailable'), `${status}: wrong coverage message`);
      assert(!text.includes('comes back automatically') && !text.includes('score stays live'), 'Unsupported freshness promise');
      if (['POSTPONED', 'CANCELLED'].includes(status)) assert((await page.locator('.dz__pill').innerText()).toUpperCase() === status, `${status}: hidden match status`);
      if (failure) {
        await page.locator('#mdUpdate').waitFor({ state: 'visible' });
        failure = false;
        await page.getByRole('button', { name: 'Try again', exact: true }).click();
        await page.locator('#mdUpdate').waitFor({ state: 'hidden' });
      }
      await page.locator('.dz__meta').filter({ hasText: 'Test stadium' }).waitFor();
      if (status === 'TIMED') {
        feed.matches[0].status = 'IN_PLAY';
        failure = true;
        await page.clock.runFor(60000);
        await page.locator('#mdUpdate').waitFor({ state: 'visible' });
        assert((await page.locator('#mdBody').innerText()).includes('Timeline unavailable'), 'Kickoff retained pre-match coverage copy during an outage');
        assert((await page.locator('#mdBody').innerText()).includes('Test stadium'), 'Outage lost known metadata');
      }
      passed.push(`${status}: honest absent coverage${status === 'ERROR' ? ', initial failure and retry' : ''}`);
    } finally { await context.close(); }
  }
  return { passed };
}

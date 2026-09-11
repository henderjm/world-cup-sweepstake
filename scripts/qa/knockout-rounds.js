// Isolated preview on 8732. Historical input is the captured September 10 CL feed.
async (browserPage) => {
  const browser = browserPage.context().browser();
  const passed = [];
  const assert = (value, message) => { if (!value) throw Error(message); };
  const history = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  try {
    const page = await history.newPage();
    await page.clock.install({ time: new Date('2026-09-10T21:20:00Z') });
    await history.route('https://goon-squad-data.gs-wc.workers.dev/**', route => route.request().url().endsWith('/CL/live')
      ? route.fulfill({ path: '/Users/markhender/personal-projects/world-cup-sweepstake/scripts/qa/fixtures/cl-qualifying-2026.json', contentType: 'application/json' }) : route.fulfill({ status: 404 }));
    await history.route('**/data/*/scorers.json*', route => route.fulfill({ json: { scorers: [] } }));
    await history.route('**/data/*/matches/*', route => route.fulfill({ status: 404 }));
    await page.goto('http://127.0.0.1:8732/#knockout?competition=CL');
    await page.getByText('No knockout fixtures published yet', { exact: true }).waitFor({ timeout: 12000 });
    assert(await page.locator('[data-knockout-tie]').count() === 0, 'Invented main knockout fixtures');
    assert(await page.locator('.hero__head .hero__meta').count() === 0, 'Knockout heading shows unrelated league summary');
    await page.locator('[data-knockout-phase="qualifying"]').click();
    const round = page.getByLabel('Knockout round');
    assert(await round.inputValue() === 'PLAYOFFS', 'History did not open at the latest qualifying round');
    assert(await page.locator('[data-knockout-tie]').count() === 7, 'Qualifying play-offs are not grouped into seven ties');
    assert(await page.locator('.ko-leg').count() === 14, 'A qualifying leg was lost');
    for (const [stage, count] of [['FIRST_QUALIFYING_ROUND', 14], ['SECOND_QUALIFYING_ROUND', 14], ['THIRD_QUALIFYING_ROUND', 10], ['PLAYOFFS', 7]]) {
      await round.selectOption(stage);
      assert(await page.locator('[data-knockout-tie]').count() === count, 'Wrong tie count for ' + stage);
      assert(await page.locator('.ko-leg').count() === count * 2, 'Missing leg in ' + stage);
    }
    await round.selectOption('SECOND_QUALIFYING_ROUND');
    await page.reload();
    await round.waitFor();
    assert(await round.inputValue() === 'SECOND_QUALIFYING_ROUND', 'Reload lost selected round');
    await page.locator('[data-knockout-phase="main"]').click();
    await page.goBack();
    await round.waitFor();
    assert(await round.inputValue() === 'SECOND_QUALIFYING_ROUND', 'Back lost phase or round');
    const leg = page.locator('.ko-leg').first();
    const id = await leg.getAttribute('data-match-id');
    await leg.click();
    await page.getByRole('dialog', { name: 'Match detail' }).waitFor();
    await page.keyboard.press('Escape');
    assert(await page.locator(`.ko-leg[data-match-id="${id}"]`).evaluate(e => e === document.activeElement), 'Closing detail lost leg focus');
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: width < 500 ? 844 : 1000 });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Knockout overflow at ' + width);
    }
    passed.push('unpublished main phase', 'latest qualifying round', '45 historical ties grouped across four rounds', 'both leg links retained', 'round reload and Back', 'leg detail and focus restoration', '1440/390/320 layouts');
  } finally { await history.close(); }

  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let mode = 'live';
  let failed = false;
  let timestamp = '2027-02-17T20:00:00Z';
  const leg = (id, homeTeam, awayTeam, score, extra = {}) => ({ id, homeTeam, awayTeam, score, stage: 'ROUND_OF_16', status: 'FINISHED', utcDate: id === 901001 ? '2027-02-10T19:00Z' : '2027-02-17T19:00Z', ...extra });
  const feed = () => ({ competition: 'CL', source: 'Browser fixture', lastUpdated: timestamp, standings: [], matches: [
    leg(901001, 'Alpha', 'Beta', mode === 'live' ? { home: 2, away: 0 } : { home: 1, away: 1 }),
    leg(901002, 'Beta', 'Alpha', { home: 1, away: 1 }, { status: mode === 'live' ? 'IN_PLAY' : mode === 'pens' ? 'PENALTY_SHOOTOUT' : 'FINISHED', penalties: mode === 'live' ? null : { home: 4, away: 1 } }),
    leg(901003, 'Gamma', 'Delta', mode === 'final' ? { home: 2, away: 1 } : {}, { stage: 'FINAL', status: mode === 'final' ? 'FINISHED' : 'TIMED', utcDate: '2027-05-29T19:00Z' }),
  ] });
  try {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.clock.install({ time: new Date('2027-02-17T20:00:10Z') });
    await context.route('**/data/*/scorers.json*', route => route.fulfill({ json: { scorers: [] } }));
    await context.route('**/data/*/live.json*', route => route.fulfill({ status: 503 }));
    await context.route('https://goon-squad-data.gs-wc.workers.dev/**', async route => {
      if (!route.request().url().endsWith('/CL/live')) return route.fulfill({ status: 404 });
      await held;
      return failed ? route.fulfill({ status: 503 }) : route.fulfill({ json: feed() });
    });
    await page.goto('http://127.0.0.1:8732/#knockout?competition=CL');
    await page.getByText('Loading scores…', { exact: true }).waitFor({ timeout: 2000 });
    release();
    await page.getByText('Live aggregate', { exact: true }).waitFor();
    assert((await page.locator('.kocard__score').allTextContents()).join(',') === '3,1', 'Live aggregate reversed the teams');
    const round = page.getByLabel('Knockout round');
    await round.focus();
    mode = 'pens';
    timestamp = '2027-02-17T20:00:20Z';
    await page.clock.runFor(20000);
    await page.getByText('Penalty shoot-out in progress', { exact: true }).waitFor();
    assert(await page.locator('.kocard__note.is-complete').count() === 0, 'Live penalties declared advancement');
    assert(await round.evaluate(e => e === document.activeElement), 'Polling lost round-selector focus');
    mode = 'finished';
    timestamp = '2027-02-17T20:00:40Z';
    await page.clock.runFor(20000);
    await page.getByText('Beta advance on penalties', { exact: true }).waitFor();
    assert((await page.locator('.kocard__score').allTextContents()).join(',') === '2,2', 'Shoot-out goals polluted aggregate');
    await page.getByText('Penalties 1–4', { exact: true }).waitFor();
    await round.selectOption('FINAL');
    await page.getByText('Not started', { exact: true }).waitFor();
    mode = 'final';
    timestamp = '2027-02-17T20:01:00Z';
    await page.clock.runFor(60000);
    await page.getByText('Gamma win the final', { exact: true }).waitFor();
    failed = true;
    await page.clock.runFor(60000);
    await page.getByText('Live data is behind', { exact: true }).waitFor();
    await page.getByText('Gamma win the final', { exact: true }).waitFor();
    failed = false;
    timestamp = await page.evaluate(() => new Date().toISOString());
    await page.clock.runFor(60000);
    await page.getByText('Live data is behind', { exact: true }).waitFor({ state: 'hidden' });
    assert(errors.length === 0, errors.join('\n'));
    passed.push('initial loading', 'live aggregate', 'live penalties stay undecided', 'shoot-out totals remain separate', 'round focus survives polling', 'single-match final', 'stale result retention and recovery');
  } finally { release(); await context.close(); }
  return { passed };
}

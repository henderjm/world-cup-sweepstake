// Run against the isolated production preview on port 8732.
async (browserPage) => {
  const context = await browserPage.context().browser().newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let mode = 'healthy';
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const final = { competition: 'CL', source: 'Browser regression', lastUpdated: '2026-09-10T21:09:00Z', standings: [], matches: [
    { id: 900001, utcDate: '2026-09-10T19:00Z', stage: 'LEAGUE_STAGE', homeTeam: 'Home', awayTeam: 'Away', status: 'FINISHED', score: { home: 4, away: 0 } },
  ] };
  const old = { ...final, lastUpdated: '2026-09-10T19:16:00Z', matches: [{ ...final.matches[0], status: 'TIMED', score: {} }] };
  const assert = (condition, message) => { if (!condition) throw Error(message); };
  try {
    await page.clock.install({ time: new Date('2026-09-10T21:10:00Z') });
    await context.route('**/data/*/scorers.json*', route => route.fulfill({ json: { scorers: [] } }));
    await context.route('**/data/CL/live.json*', route => route.fulfill({ json: old }));
    await context.route('https://goon-squad-data.gs-wc.workers.dev/**', async route => {
      if (!route.request().url().endsWith('/CL/live')) return route.fulfill({ status: 404 });
      if (mode === 'timeout') await held;
      const body = mode === 'older' ? old : mode === 'correction'
        ? { ...final, lastUpdated: '2026-09-10T21:10:09Z', matches: [{ ...final.matches[0], score: { home: 3, away: 0 } }] }
        : final;
      await route.fulfill({ json: body }).catch(() => {});
    });
    await page.goto('http://127.0.0.1:8732/#live?competition=CL');
    const score = page.locator('.score-day [data-match-id="900001"] .mline__score');
    await score.waitFor();
    assert(await score.innerText() === '4 – 0', 'Initial final score missing');
    mode = 'timeout';
    await page.reload();
    await page.clock.runFor(9000);
    await score.waitFor();
    assert(await score.innerText() === '4 – 0', 'Timeout plus reload reverted the final score');
    await page.getByText('Live data is behind', { exact: true }).waitFor();
    assert((await page.locator('#updated').innerText()).includes('delayed'), 'Saved scores presented as fresh');
    release();
    mode = 'older';
    await page.reload();
    await score.waitFor();
    assert(await score.innerText() === '4 – 0', 'Older successful provider response reverted scores');
    mode = 'correction';
    await page.reload();
    await score.waitFor();
    assert(await score.innerText() === '3 – 0', 'Newer provider correction was suppressed');
    await page.getByText('Live data is behind', { exact: true }).waitFor({ state: 'hidden' });
    assert(errors.length === 0, errors.join('\n'));
    return { passed: ['final score loaded', 'reload and eight-second timeout preserve final score', 'saved data labelled delayed', 'older successful response rejected', 'newer score correction accepted', 'delay cleared on recovery'], errors };
  } finally {
    release();
    await context.close();
  }
}

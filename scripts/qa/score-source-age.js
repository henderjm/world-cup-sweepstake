// Preview on 8732; stalled-standings-server.mjs with the isolated Worker on 8733.
async (browserPage) => {
  const context = await browserPage.context().browser().newContext({ viewport: { width: 390, height: 844 } });
  try {
    const page = await context.newPage();
    const errors = [], labels = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.request.get('http://127.0.0.1:8733/reset/healthy');
    await page.clock.install({ time: new Date('2026-09-19T15:00:00Z') });
    await page.route('**/data/*/scorers.json*', route => route.fulfill({ json: { scorers: [] } }));
    await page.route('**/data/*/live.json*', route => route.fulfill({ status: 503 }));
    await page.route('https://goon-squad-data.gs-wc.workers.dev/**', async route => {
      if (!route.request().url().endsWith('/CL/live')) return route.fulfill({ status: 404 });
      const response = await route.fetch({ url: 'http://127.0.0.1:8733/CL/live' });
      await route.fulfill({ response, headers: { ...response.headers(), 'access-control-allow-origin': '*' } });
    });
    const read = async expectedScore => {
      if (page.url() === 'about:blank') await page.goto('http://127.0.0.1:8732/#live?competition=CL');
      else await page.reload();
      await page.locator('.score-day [data-match-id="900001"]').getByText(expectedScore, { exact: true }).waitFor({ timeout: 8000 });
      const label = await page.locator('#updated').innerText();
      labels.push(label);
      return label;
    };
    await read('1 – 0');
    await page.request.get('http://127.0.0.1:8733/clock/20');
    await page.clock.setFixedTime(new Date('2026-09-19T15:00:20Z'));
    const cached = await read('1 – 0');
    if (!cached.includes('20s ago')) throw Error('Cached scores were presented as just updated: ' + cached);
    await page.request.get('http://127.0.0.1:8733/mode/recovered');
    await page.clock.setFixedTime(new Date('2026-09-19T15:06:21Z'));
    await read('2 – 0');
    await page.request.get('http://127.0.0.1:8733/mode/score-slow');
    await page.clock.setFixedTime(new Date('2026-09-19T15:12:22Z'));
    await read('2 – 0');
    await page.getByText('Live data is behind', { exact: true }).waitFor();
    if (!labels.at(-1).includes('6m ago')) throw Error('Failure lost the score source age: ' + labels.at(-1));
    await page.request.get('http://127.0.0.1:8733/mode/recovered');
    await page.clock.setFixedTime(new Date('2026-09-19T15:18:23Z'));
    await read('4 – 0');
    await page.getByText('Live data is behind', { exact: true }).waitFor({ state: 'hidden' });
    if (errors.length) throw Error(errors.join('; '));
    return { labels, passed: ['cached score age retained', 'fresh update advances score', 'provider stall retains marked score and original age', 'recovery clears delay'], errors };
  } finally { await context.close(); }
}

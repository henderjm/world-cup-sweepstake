// Requires the isolated release preview on 8732 and stalled-provider-server.mjs on 8733.
async (browserPage) => {
  const context = await browserPage.context().browser().newContext({ viewport: { width: 390, height: 844 } });
  try {
    const page = await context.newPage();
    const errors = [], timings = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.clock.install({ time: new Date('2026-09-10T19:20:00Z') });
    await page.route('**/data/*/scorers.json*', route => route.fulfill({ json: { scorers: [] } }));
    await page.route('https://goon-squad-data.gs-wc.workers.dev/**', async route => {
      if (!route.request().url().endsWith('/CL/live')) return route.fulfill({ status: 404 });
      const response = await route.fetch({ url: 'http://127.0.0.1:8733/CL/live' });
      timings.push(Number(response.headers()['x-fixture-duration-ms']));
      await route.fulfill({ response, headers: { ...response.headers(), 'access-control-allow-origin': '*' } });
    });
    await page.goto('http://127.0.0.1:8732/#live?competition=CL');
    const score = page.locator('.score-day [data-match-id="900002"] .mline__score');
    await score.waitFor({ timeout: 12000 });
    if (await score.innerText() !== '1 – 0') throw Error('Initial score missing');
    await page.request.get('http://127.0.0.1:8733/mode/slow');
    await page.clock.setFixedTime(new Date('2026-09-10T19:21:01Z'));
    await page.reload();
    await score.waitFor({ timeout: 12000 });
    await page.getByText('Live data is behind', { exact: true }).waitFor({ timeout: 2000 });
    if (await score.innerText() !== '1 – 0') throw Error('Timeout lost the known score');
    const slow = Math.max(...timings);
    if (slow < 4900 || slow >= 8000) throw Error('Unexpected timeout duration: ' + slow);
    await page.request.get('http://127.0.0.1:8733/mode/recovered');
    await page.clock.setFixedTime(new Date('2026-09-10T19:22:02Z'));
    await page.reload();
    await score.waitFor({ timeout: 12000 });
    if (await score.innerText() !== '2 – 0') throw Error('A new read did not recover the score');
    await page.getByText('Live data is behind', { exact: true }).waitFor({ state: 'hidden', timeout: 2000 });
    if (errors.length) throw Error(errors.join('\n'));
    return { timings, passed: ['stalled provider aborted before browser deadline', 'known score retained with delay marker', 'new read recovers score and clears delay'], errors };
  } finally { await context.close(); }
}

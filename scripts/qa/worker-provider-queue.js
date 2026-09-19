// Requires the isolated preview on 8732 and queued-provider-server.mjs on 8733.
async (browserPage) => {
  const c = await browserPage.context().browser().newContext({ viewport: { width: 390, height: 844 } });
  try {
    const p = await c.newPage();
    const timings = [], errors = [];
    p.on('pageerror', e => errors.push(e.message));
    await p.clock.install({ time: new Date('2026-09-19T12:00:00Z') });
    await p.route('**/data/*/scorers.json*', r => r.fulfill({ json: {} }));
    await p.route('**/data/*/live.json*', r => r.fulfill({ status: 503 }));
    await p.route('https://goon-squad-data.gs-wc.workers.dev/**', async r => {
      if (!r.request().url().endsWith('/CL/live')) return r.fulfill({ status: 404 });
      const response = await r.fetch({ url: 'http://127.0.0.1:8733/CL/live' });
      timings.push(Number(response.headers()['x-fixture-duration-ms']));
      await r.fulfill({ response, headers: { ...response.headers(), 'access-control-allow-origin': '*' } });
    });
    await p.goto('http://127.0.0.1:8732/#live?competition=CL');
    const score = p.locator('.score-day [data-match-id="900001"] .mline__score');
    await score.waitFor();
    if (await score.innerText() !== '1 – 0') throw Error('Initial score absent');
    await p.request.get('http://127.0.0.1:8733/mode/overload');
    await p.clock.setFixedTime(new Date('2026-09-19T12:01:01Z'));
    await p.reload();
    await p.getByText('Live data is behind', { exact: true }).waitFor({ timeout: 5000 }).catch(async e => {
      throw Error(e.message + '\nTimings: ' + JSON.stringify(timings) + '\n' + await p.locator('body').innerText());
    });
    if (await score.innerText() !== '1 – 0') throw Error('Queue overload lost known score');
    if (timings.at(-1) >= 1500) throw Error('Queue exceeded budget: ' + timings.at(-1));
    await p.request.get('http://127.0.0.1:8733/mode/recovered');
    await p.clock.setFixedTime(new Date('2026-09-19T12:02:02Z'));
    await p.reload();
    await score.waitFor();
    if (await score.innerText() !== '2 – 0') throw Error('Score did not recover');
    await p.getByText('Live data is behind', { exact: true }).waitFor({ state: 'hidden' });
    if (errors.length) throw Error(errors.join('; '));
    return { timings, passed: ['overloaded queue returns promptly', 'known score retained with delay marker', 'queue drains and later score recovers'], errors };
  } finally { await c.close(); }
}

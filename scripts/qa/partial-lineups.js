// Run on an isolated release preview at 8732. All service requests are intercepted.
async (browserPage) => {
  const passed = [];
  for (const missing of ['home', 'away', 'unavailable']) {
    const context = await browserPage.context().browser().newContext({ viewport: { width: missing === 'home' ? 1440 : 390, height: 844 } });
    const page = await context.newPage();
    let recovered = false;
    let bakeReads = 0;
    const assert = (ok, message) => { if (!ok) throw new Error(message); };
    const side = (name, prefix) => ({ name, coach: `${prefix} coach`, formation: '4-3-3', lineup: Array.from({ length: 11 }, (_, i) => ({ name: `${prefix} starter ${i + 1}`, num: i + 1 })), bench: [{ name: `${prefix} substitute` }] });
    const raw = () => ({ id: 900001, home: side('Home', 'Fresh home'), away: side('Away', 'Fresh away'), goals: [{ scorer: 'Fresh scorer', team: 'Home', minute: 1 }], cards: [], subs: [], playerStats: [{ playerId: 1 }] });
    const absent = missing === 'unavailable' ? 'away' : missing;
    const present = absent === 'home' ? 'away' : 'home';
    const workerDetail = () => { const detail = raw(); if (!recovered) detail[absent] = { name: absent === 'home' ? 'Home' : 'Away', lineup: [] }; return detail; };
    const bake = { ...raw(), home: side('Home', 'Saved home'), away: side('Away', 'Saved away'), goals: [{ scorer: 'Outdated scorer', team: 'Home', minute: 1 }] };
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      await page.clock.install({ time: new Date('2026-09-11T16:30:00Z') });
      await page.route('**/data/CL/matches/*', route => {
        bakeReads++;
        return missing === 'unavailable' ? route.fulfill({ status: 503, body: 'Unavailable' }) : route.fulfill({ json: bake });
      });
      await page.route('https://goon-squad-data.gs-wc.workers.dev/**', route => {
        const path = route.request().url().split('workers.dev')[1].split('?')[0];
        if (path === '/CL/live') return route.fulfill({ json: { competition: 'CL', source: 'Browser fixture', lastUpdated: '2026-09-11T16:30:00Z', standings: [], matches: [{ id: 900001, homeTeam: 'Home', awayTeam: 'Away', utcDate: '2026-09-11T16:00:00Z', status: 'IN_PLAY', minute: 30, stage: 'LEAGUE_STAGE', score: { home: 1, away: 0 } }] } });
        if (path === '/match/900001') return route.fulfill({ json: workerDetail() });
        return route.fulfill({ status: 404, body: 'Not in fixture' });
      });
      await page.goto('http://127.0.0.1:8732/#live?competition=CL');
      await page.locator('.score-day [data-match-id]').click();
      await page.getByText('Fresh scorer', { exact: false }).waitFor();
      await page.getByRole('navigation', { name: 'Match sections' }).getByRole('button', { name: 'Line-ups', exact: true }).click();
      const expected = missing === 'unavailable' ? 'Line-up unavailable from the feed' : `Saved ${absent} starter 1`;
      await page.getByText(expected, { exact: false }).first().waitFor();
      assert(bakeReads === 1, `Partial ${missing} read did not check the bake exactly once`);
      const content = await page.locator('#mdBody').innerText();
      assert(content.includes(`Fresh ${present} starter 1`) && content.includes(`Fresh ${present} substitute`), 'Fallback replaced available starters or bench');
      assert(!content.includes(`Saved ${present}`) && !content.includes('Outdated scorer'), 'Fallback replaced a fresh section');
      const top = await page.locator('#mdLineups').evaluate(e => e.getBoundingClientRect().top);
      recovered = true;
      await page.clock.runFor(20000);
      await page.getByText(`Fresh ${absent} starter 1`, { exact: false }).first().waitFor();
      assert(bakeReads === 1, 'Complete Worker detail still fetched the bake');
      assert(!(await page.locator('#mdBody').innerText()).includes(`Saved ${absent}`), 'Recovered line-up retained old players');
      assert(await page.locator('#mdLineups').evaluate(e => e === document.activeElement), 'Recovery lost section focus');
      assert(Math.abs((await page.locator('#mdLineups').evaluate(e => e.getBoundingClientRect().top)) - top) < 2, 'Recovery moved section');
      assert(errors.length === 0, errors.join('; '));
      passed.push(`${missing}: independent recovery, fresh sections retained, no redundant fallback after recovery, stable section focus/position`);
    } finally { await context.close(); }
  }
  return { passed };
}

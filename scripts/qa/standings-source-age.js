// Preview on 8731. Scores and standings must retain independent source ages.
async (page) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.clock.install({ time: new Date('2026-10-04T18:00:00Z') });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const feed = code => ({ source: 'Browser regression', competition: code, season: '2026',
    lastUpdated: '2026-10-04T17:57:00Z', standingsUpdatedAt: '2026-10-04T17:59:30Z',
    standingsDelayed: false, matches: [], standings: [{ type: 'TOTAL', table: [{ position: 1,
      team: { id: 42, name: 'Arsenal' }, playedGames: 3, won: 3, draw: 0, lost: 0,
      goalsFor: 6, goalsAgainst: 1, goalDifference: 5, points: 9 }] }] });
  await page.route('**/data/*/scorers.json*', route => route.fulfill({ json: { scorers: [] } }));
  await page.route('https://goon-squad-data.gs-wc.workers.dev/**', route => {
    const code = route.request().url().match(/\/(PL|CL)\/live$/)?.[1];
    return code ? route.fulfill({ json: feed(code) }) : route.fulfill({ status: 404 });
  });
  await page.goto('http://127.0.0.1:8731/#live');
  await page.locator('[data-standings-age="PL"]').getByText('30s ago', { exact: true }).waitFor();
  if (await page.locator('[data-feed-age="PL"]').innerText() !== '3m ago') throw Error('Table age replaced score age');
  await page.locator('[data-standings-selector]').selectOption('CL');
  await page.locator('[data-standings-age="CL"]').getByText('30s ago', { exact: true }).waitFor();
  await page.clock.runFor(60000);
  await page.locator('[data-standings-age="CL"]').getByText('1m ago', { exact: true }).waitFor();
  if (await page.locator('[data-feed-age="CL"]').innerText() !== '4m ago') throw Error('Polling reset source age');
  if (errors.length) throw Error(errors.join('; '));
  return { passed: ['independent score and table ages', 'league switch', 'elapsed source age survives polling'], errors };
}

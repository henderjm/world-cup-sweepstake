// Local fixture: pass an isolated release export; never contacts a provider.
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
const workerUrl = pathToFileURL(process.argv[2] + '/worker/worker.js');
let worker, run = 0, mode = 'healthy', score = 1, now;
const reset = async nextMode => {
  mode = nextMode; score = mode === 'healthy' ? 1 : 2;
  now = Date.parse('2026-09-19T15:00:00Z');
  worker = (await import(workerUrl + '?standings-run=' + ++run)).default;
};
Date.now = () => now;
globalThis.fetch = async (url, { signal }) => {
  if (!String(url).startsWith('https://v3.football.api-sports.io/')) throw Error('Unexpected fixture origin');
  if (String(url).includes('/standings')) {
    const wait = () => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    if (mode === 'slow') return wait();
    if (mode === 'body') return { ok: true, status: 200, headers: new Headers(), json: wait };
    return Response.json({ errors: [], response: mode === 'empty' ? [] : [{ league: { standings: [[{
      rank: 1, team: { id: 1, name: 'Home' }, points: score === 1 ? 3 : 6,
      all: { played: 1, win: 1, draw: 0, lose: 0, goals: { for: 1, against: 0 } },
    }]] } }] });
  }
  return Response.json({ errors: [], response: [{
    fixture: { id: 900001, date: '2026-09-19T14:30:00Z', status: { short: '1H', elapsed: 30 } },
    league: { id: 2, season: 2026, round: 'League Stage - 1' },
    teams: { home: { id: 1, name: 'Home' }, away: { id: 2, name: 'Away' } },
    goals: { home: score, away: 0 }, score: { fulltime: { home: null, away: null } },
  }] });
};
await reset('healthy');
createServer(async (req, res) => {
  if (req.url.startsWith('/reset/')) { await reset(req.url.split('/').at(-1)); res.end('reset'); return; }
  if (req.url.startsWith('/mode/')) { mode = req.url.split('/').at(-1); score++; now += 361000; res.end('ready'); return; }
  if (req.url !== '/CL/live') { res.writeHead(404); res.end(); return; }
  const started = performance.now();
  const response = await worker.fetch(new Request('https://test.invalid/CL/live'), { API_FOOTBALL_KEY: 'fixture', API_FOOTBALL_COMPETITIONS: 'CL:2026' }, { waitUntil() {} });
  res.writeHead(response.status, { 'content-type': 'application/json', 'x-fixture-duration-ms': String(Math.round(performance.now() - started)) });
  res.end(await response.text());
}).listen(8733, '127.0.0.1', () => console.log('Local standings fixture ready on 8733'));

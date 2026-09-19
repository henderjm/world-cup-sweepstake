// Local-only overload fixture: pass the path to an isolated release export.
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
const { default: worker } = await import(pathToFileURL(process.argv[2] + '/worker/worker.js'));
let now = Date.parse('2026-09-19T12:00:00Z');
let score = 1;
let pending = [];
let overloadNextRead = false;
Date.now = () => now;
const fixtures = () => Array.from({ length: 15 }, (_, i) => ({
  fixture: { id: 900001 + i, date: '2026-09-19T11:30:00Z', status: { short: i ? 'FT' : '1H', elapsed: i ? 90 : 30 } },
  league: { id: 2, season: 2026, round: 'League Stage - 1' },
  teams: { home: { id: 1, name: 'Home' }, away: { id: 2, name: 'Away' } },
  goals: { home: score, away: 0 }, score: { fulltime: { home: i ? score : null, away: i ? 0 : null } },
}));
globalThis.fetch = async url => {
  const parsed = new URL(url);
  if (parsed.origin !== 'https://v3.football.api-sports.io') throw Error('Unexpected fixture origin');
  const response = parsed.pathname !== '/fixtures' ? [] : parsed.searchParams.has('id') ? fixtures().filter(f => f.fixture.id === Number(parsed.searchParams.get('id'))) : fixtures();
  return Response.json({ response, errors: [] });
};
const read = path => worker.fetch(new Request('https://test.invalid' + path), { API_FOOTBALL_KEY: 'fixture', API_FOOTBALL_COMPETITIONS: 'CL:2026' }, { waitUntil() {} });
createServer(async (req, res) => {
  if (req.url === '/mode/overload') {
    overloadNextRead = true;
    res.end('overloaded'); return;
  }
  if (req.url === '/mode/recovered') {
    await Promise.all(pending);
    score = 2; now += 61000;
    res.end('recovered'); return;
  }
  if (req.url !== '/CL/live') { res.writeHead(404); res.end(); return; }
  if (overloadNextRead) {
    overloadNextRead = false;
    pending = Array.from({ length: 14 }, (_, i) => read('/match/' + (900002 + i)));
    await new Promise(resolve => setTimeout(resolve, 1));
    now += 61000;
  }
  const start = performance.now();
  const response = await read('/CL/live');
  res.writeHead(response.status, { 'content-type': 'application/json', 'x-fixture-duration-ms': String(Math.round(performance.now() - start)) });
  res.end(await response.text());
}).listen(8733, '127.0.0.1', () => console.log('Isolated queue fixture ready on 8733'));

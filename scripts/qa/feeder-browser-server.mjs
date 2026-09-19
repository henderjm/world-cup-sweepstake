// Local Worker ingestion fixture. Simulates provider refusal and backup pushes.
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
const { default: worker } = await import(pathToFileURL(process.argv[2] + '/worker/worker.js'));
const competition = process.argv[3] ?? 'PL';
if (!['PL', 'CL'].includes(competition)) throw Error('Use PL or CL for this fixture');
let now = Date.parse('2026-09-19T15:00:00Z'), score = 1;
Date.now = () => now;
const kv = new Map();
const env = { API_FOOTBALL_KEY: 'fixture', DETAIL_INGEST_TOKEN: 'fixture', API_FOOTBALL_COMPETITIONS: `${competition}:2026`,
  ANALYSIS_CACHE: { get: async key => kv.get(key) ?? null, put: async (key, value) => { kv.set(key, value); } } };
const fixtures = () => ({ errors: [], response: [{
  fixture: { id: 900001, date: '2026-09-19T14:30:00Z', status: { short: '1H', elapsed: 30 } },
  league: { id: competition === 'CL' ? 2 : 39, season: 2026, round: competition === 'CL' ? 'League Stage - 1' : 'Regular Season - 5' },
  teams: { home: { id: 1, name: 'Home' }, away: { id: 2, name: 'Away' } },
  goals: { home: score, away: 0 }, score: { fulltime: { home: null, away: null } },
}] });
globalThis.fetch = async url => {
  const parsed = new URL(url);
  if (parsed.origin !== 'https://v3.football.api-sports.io') throw Error('Unexpected provider origin');
  if (parsed.searchParams.has('ids')) return new Response('Provider unavailable', { status: 503 });
  return Response.json(parsed.pathname === '/standings' ? { errors: [], response: [] } : fixtures());
};
const call = (path, init) => worker.fetch(new Request('https://test.invalid' + path, init), env, { waitUntil() {} });
async function push() {
  const response = await call(`/ingest/live/${competition}`, { method: 'POST', headers: { authorization: 'Bearer fixture' }, body: JSON.stringify({ fixtures: fixtures() }) });
  if (!(await response.json()).stored) throw Error('Fixture ingestion failed');
}
await push();
createServer(async (req, res) => {
  if (req.url.startsWith('/step/')) {
    const seconds = Number(req.url.split('/').at(-1));
    now += seconds * 1000;
    if (seconds !== 121) { score++; await push(); }
    res.end('ready'); return;
  }
  if (req.url !== `/${competition}/live`) { res.writeHead(404); res.end(); return; }
  const response = await call(`/${competition}/live`);
  res.writeHead(response.status, { 'content-type': 'application/json' });
  res.end(await response.text());
}).listen(8733, '127.0.0.1', () => console.log('Local backup ingestion fixture ready on 8733'));

import test from 'node:test';
import assert from 'node:assert/strict';
import { ScoreCollector } from '../collector.mjs';
import { initialBudget, reserveRequest, finishRequest } from '../budget.mjs';
import { nextSnapshot } from '../snapshots.mjs';
import { detailKey, detailPublication } from '../details.mjs';

import { storedMatchDetail } from '../detail-read.mjs';

const DAY = Date.parse('2026-10-11T00:00:00Z');
const envelope = response => ({ errors: [], results: response.length, paging: { current: 1, total: 1 }, response });

// The production scheduler, validation, publication and quota state machines run
// on a virtual clock; only network/storage I/O are replaced. No provider calls.
async function simulate({ initialUsed = 0, startHour = 0, failures = true } = {}) {
  let now = DAY + startHour * 3600000;
  const startedAt = now, reconciled = new Map();
  let budget = initialBudget({ dailyLimit: 7500, minuteLimit: 300, scoreReserve: 6000 }, initialUsed, now - 61000);
  const snapshots = new Map(), details = new Map(), calls = [], outcomes = [];
  const matches = Array.from({ length: 28 }, (_, i) => ({ id: 900001 + i, competition: i < 10 ? 'PL' : 'CL',
    kickoff: DAY + (i < 10 ? 12 + 2 * Math.floor(i / 2) : 19) * 3600000 }));
  const archives = Array.from({ length: 60 }, (_, i) => ({ id: 910001 + i, competition: i % 2 ? 'PL' : 'CL', kickoff: DAY - 3 * 86400000 }));
  const all = [...matches, ...archives];
  const lineup = [1, 2].map(id => ({ team: { id }, startXI: Array.from({ length: 11 }, (_, n) => ({ player: { id: id * 100 + n, name: `Player ${n}` } })), substitutes: [] }));
  const record = spec => {
    const elapsed = Math.floor((now - spec.kickoff) / 60000), final = elapsed >= 110;
    const goals = elapsed < 0 ? null : elapsed < 20 ? 0 : elapsed < 75 ? 1 : elapsed < 100 ? 2 : 3;
    const events = [20, 75, 100].filter(minute => minute <= elapsed).map(minute => ({ time: { elapsed: minute }, team: { id: 2, name: 'Away' }, type: 'Goal', detail: 'Normal Goal', player: { id: 200, name: 'Scorer' } }));
    if (final && elapsed < 112) events.pop(); // provider settles the last goal late
    if (elapsed >= 80) events.push({ time: { elapsed: 80 }, team: { id: 1 }, type: 'subst', detail: 'Substitution', player: { id: 100, name: 'Off' }, assist: { id: 120, name: 'On' } });
    return { fixture: { id: spec.id, date: new Date(spec.kickoff).toISOString(), status: { short: elapsed < 0 ? 'NS' : final ? 'FT' : elapsed < 45 ? '1H' : elapsed < 60 ? 'HT' : '2H', elapsed: elapsed < 0 ? null : Math.min(90, elapsed) } },
      league: { id: spec.competition === 'PL' ? 39 : 2, season: 2026, round: spec.competition === 'PL' ? 'Regular Season - 6' : 'League Stage - 2' },
      teams: { home: { id: 1, name: 'Home' }, away: { id: 2, name: 'Away' } }, goals: { home: elapsed < 0 ? null : 0, away: goals },
      events, lineups: elapsed >= -60 ? lineup : [], players: elapsed < 0 ? [] : lineup.map(team => ({ team: team.team, players: [...team.startXI, ...(team.team.id === 1 && elapsed >= 80 ? [{ player: { id: 120, name: "On" } }] : [])].map(entry => ({ ...entry, statistics: [{ games: { position: "M", minutes: Math.max(0, Math.min(90, elapsed)) }, tackles: { total: 0, blocks: 0, interceptions: 0 } }] })) })) };
  };
  const lease = { owner: 'simulation', epoch: 1, expiresAt: now + 30000 };
  const store = {
    async claim() { lease.expiresAt = now + 30000; return { ...lease }; },
    async read(code) { return snapshots.get(code) ?? null; },
    async publish(_lease, input) { snapshots.set(input.competition, nextSnapshot(snapshots.get(input.competition), input, { epoch: lease.epoch, now })); },
    async readDetailManifest(code, season, id) { const stored = details.get(detailKey(code, season, id)); if (!stored) return null; const { payloads, ...manifest } = stored; return manifest; },
    async readDetail(code, season, id) { return details.get(detailKey(code, season, id)) ?? null; },
    async publishDetail(_lease, input) { const key = detailKey(input.competition, input.season, input.id), previous = details.get(key); const { payloads, ...priorManifest } = previous ?? {}; const { manifest } = detailPublication(previous ? priorManifest : null, input, lease, now); details.set(key, { ...manifest, payloads: { ...previous?.payloads, [input.section]: input.payload } }); return manifest; },
    async readFantasyManifest() { return null; },
  };
  const provider = { async request(_lease, path, { priority }) {
    const permit = reserveRequest(budget, { priority, now, id: String(calls.length), admissionTimeoutMs: 3000 });
    if (!permit.allowed) return permit;
    budget = permit.next;
    calls.push({ at: now, path, priority });
    const outage = failures && now >= DAY + 18.5 * 3600000 && now < DAY + 18.55 * 3600000;
    const fail = outage || (failures && calls.length % 97 === 0);
    budget = finishRequest(budget, permit.permit, { ok: !fail, status: fail ? 503 : 200 }, now);
    if (fail) throw Error('Simulated provider outage');
    const url = new URL(path, 'https://example.invalid');
    let response;
    if (url.pathname === '/standings') response = [{ league: { id: Number(url.searchParams.get('league')), season: 2026,
      standings: [[1, 2].map(id => ({ rank: id, team: { id, name: `Team ${id}` }, points: 3, goalsDiff: 1,
        all: { played: 1, win: 1, draw: 0, lose: 0, goals: { for: 2, against: 1 } } }))] } }];
    else if (url.pathname === '/fixtures') {
      const ids = url.searchParams.get('ids')?.split('-').map(Number);
      const id = Number(url.searchParams.get('id'));
      response = all.filter(m => ids ? ids.includes(m.id) : id ? m.id === id : m.competition === (url.searchParams.get('league') === '39' ? 'PL' : 'CL')).map(record);
      if (!ids && !id) response = response.map(({ events, lineups, players, ...row }) => row);
    } else if (url.pathname.startsWith('/fixtures/')) response = record(all.find(m => m.id === Number(url.searchParams.get('fixture'))))[url.pathname.split('/').at(-1)];
    else response = []; // unavailable fantasy history exercises its bounded retry path
    return { allowed: true, observedAt: now, payload: envelope(response) };
  } };
  let collector = new ScoreCollector({ store, provider, seasons: { PL: '2026', CL: '2026' }, owner: lease.owner, now: () => now });
  let restarted = false, maxLiveAge = 0;
  while (now < DAY + 86400000 - 10000) {
    if (!restarted && now >= DAY + 17 * 3600000) { restarted = true; lease.epoch++; collector = new ScoreCollector({ store, provider, seasons: { PL: '2026', CL: '2026' }, owner: lease.owner, now: () => now }); }
    const result = await collector.step();
    if (result.state === 'failed' && result.phase !== 'request' && result.kind !== 'fantasy'
      && !(['events','fixture'].includes(result.section) && result.phase === 'validation')) outcomes.push(result);
    for (const snapshot of snapshots.values()) for (const row of snapshot.fixtures) {
      if (row.match.status !== 'IN_PLAY') continue;
      if (now >= DAY + 18.5 * 3600000 && now < DAY + 18.57 * 3600000) continue;
      maxLiveAge = Math.max(maxLiveAge, now - row.observedAt);
    }
    for (const spec of matches) {
      if (reconciled.has(spec.id)) continue;
      const snapshot = snapshots.get(spec.competition), row = snapshot?.fixtures.find(r => r.match.id === spec.id);
      if (row?.match.status !== 'FINISHED') continue;
      const stored = details.get(detailKey(spec.competition, '2026', spec.id));
      if (stored && Object.values(storedMatchDetail(snapshot, row, stored, now).coverage).every(s => s.state === 'complete'))
        reconciled.set(spec.id, now - Math.max(startedAt, spec.kickoff + 110 * 60000));
    }
    now += result.state === 'idle' ? Math.max(1000, Math.min(5000, result.retryAt - now)) : 1000;
  }
  const missing = matches.flatMap(m => {
    const row = snapshots.get(m.competition)?.fixtures.find(row => row.match.id === m.id);
    const stored = details.get(detailKey(m.competition, '2026', m.id));
    const coverage = row && storedMatchDetail(snapshots.get(m.competition), row, stored, now).coverage;
    return !stored || row.match.status !== 'FINISHED' || row.match.score.away !== 3 || ['fixture', 'events', 'lineups', 'players'].some(s => coverage[s].state !== 'complete')
      || stored.payloads.events.response.filter(e => e.type === 'Goal').length !== 3
      || stored.payloads.events.response.filter(e => e.type === 'subst').length !== 1 ? [{ id: m.id, coverage }] : [];
  });
  if (missing.length) console.log(JSON.stringify({used:budget.used, calls: calls.length, missing:missing.length, paths:Object.fromEntries([...new Set(calls.map(c=>c.path.split('?')[0]))].map(p=>[p,calls.filter(c=>c.path.split('?')[0]===p).length]))}));
  assert.deepEqual(outcomes, [], 'unexpected validation/publication failure');
  assert.equal(reconciled.size, 28);
  const maxFinalRecoveryMs = Math.max(...reconciled.values());
  assert.ok(maxFinalRecoveryMs <= 180000, `final reconciliation delay ${maxFinalRecoveryMs}`);
  assert.deepEqual(missing, [], 'all 28 final match details reconcile, including delayed final goals');
  assert.equal(calls.some(c => /\/fixtures\/(events|players)/.test(c.path) && c.at < all.find(m => m.id === Number(new URL(c.path, 'https://example.invalid').searchParams.get('fixture'))).kickoff), false, 'no empty event/stat polling before kickoff');
  assert.ok(budget.used < 7500, `daily requests ${budget.used}`);
  assert.ok(maxLiveAge <= 65000, `freshness outside injected outage: ${maxLiveAge}`);
  assert.equal(calls.some(c => c.priority === 'supplementary'), initialUsed < 1500);
  return { matches: matches.length, archives: archives.length, initialUsed, requests: calls.length, totalUsed: budget.used,
    maxLiveAgeMs: maxLiveAge, maxFinalRecoveryMs, finalDetailsComplete: matches.length,
    callsByPriority: Object.fromEntries(['scores','supplementary'].map(p => [p, calls.filter(c => c.priority === p).length])) };
}

test('full busy day: 10 PL + 18 CL, background pressure, late final data, outage and collector restart', async t => {
  t.diagnostic(JSON.stringify(await simulate()));
});

test('late-day recovery starts beyond the old 4500 cutoff and still reconciles every final match', async t => {
  t.diagnostic(JSON.stringify(await simulate({ initialUsed: 4916, startHour: 17.5, failures: false })));
});

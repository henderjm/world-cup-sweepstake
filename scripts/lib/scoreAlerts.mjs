import { createHash, randomUUID } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { evaluateCheck, validatePlan } from './scoreReliability.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const MAX_LEDGER = 64 * 1024 * 1024;

export function alertDestination(value) {
  let url;
  try { url = new URL(value); } catch { throw Error('Set SCORE_ALERT_URL to an approved receiver'); }
  if (url.username || url.password || url.search || url.hash
    || !(url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))))
    throw Error('Alert receiver requires HTTPS or loopback HTTP, without URL credentials or query parameters');
  return url.href;
}

export function readLedger(bytes) {
  if (bytes.length > MAX_LEDGER) throw Error('Ledger exceeds the 64 MiB watcher limit; retain it and split future measurement windows');
  const complete = bytes.subarray(0, bytes.lastIndexOf(10) + 1);
  if (!complete.length) throw Error('Ledger has no durable plan record yet');
  const rows = complete.toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line));
  if (rows[0].type !== 'plan' || rows[0].schema !== 1) throw Error('Unsupported observation ledger');
  const plan = validatePlan(rows[0].plan);
  const slots = new Map(), start = Date.parse(plan.start), end = Date.parse(plan.end);
  for (const row of rows.slice(1)) {
    const key = `${row.competition}:${row.scheduledAt}`;
    if (row.type !== 'probe' || !plan.competitions.includes(row.competition)
      || !Number.isSafeInteger(row.scheduledAt) || row.scheduledAt < start || row.scheduledAt >= end
      || (row.scheduledAt - start) % plan.intervalMs || slots.has(key))
      throw Error('Duplicate or out-of-plan observation');
    slots.set(key, row);
  }
  return { plan, slots, complete };
}

export function advanceAlerts(previous, ledger, destination, now) {
  const { plan, slots, complete } = ledger;
  const planHash = hash(JSON.stringify(plan)), destinationHash = hash(destination);
  const state = previous ? structuredClone(previous) : {
    schema: 1, planHash, destinationHash, nextAt: Date.parse(plan.start),
    competitions: Object.fromEntries(plan.competitions.map(code => [code, { retired: [], incident: null }])),
    events: [], sourceBytes: 0, sourceHash: hash(''),
  };
  if (state.schema !== 1 || state.planHash !== planHash || state.destinationHash !== destinationHash
    || !Number.isSafeInteger(state.nextAt) || state.nextAt < Date.parse(plan.start)
    || (state.nextAt - Date.parse(plan.start)) % plan.intervalMs
    || !Array.isArray(state.events) || state.events.length > 1000
    || !Number.isSafeInteger(state.sourceBytes) || state.sourceBytes < 0
    || state.sourceBytes > complete.length || hash(complete.subarray(0, state.sourceBytes)) !== state.sourceHash)
    throw Error('Alert state, destination or recorded evidence changed; refusing to reset delivery history');
  for (; state.nextAt < Date.parse(plan.end) && state.nextAt + plan.intervalMs <= now; state.nextAt += plan.intervalMs) {
    for (const code of plan.competitions) {
      const current = state.competitions[code];
      const retired = new Set(current.retired);
      const row = slots.get(`${code}:${state.nextAt}`);
      // Finalize only closed slots. A missing recorder cannot hide by never
      // completing a request, and late arrivals cannot rewrite alert history.
      const check = evaluateCheck(plan, code, state.nextAt, row, retired, state.nextAt + plan.intervalMs);
      current.retired = [...retired];
      const failedFixtures = check.fixtures.filter(f => f.reason);
      const failed = !check.usable || failedFixtures.length > 0;
      if (failed === Boolean(current.incident)) continue;
      const id = hash(`${planHash}:${code}:${state.nextAt}:${failed ? 'incident' : 'recovery'}`);
      state.events.push({ id, incidentId: failed ? id : current.incident, competition: code,
        kind: failed ? 'incident' : 'recovery', scheduledAt: state.nextAt, detectedAt: now,
        reasons: failed ? [...new Set([!check.usable ? check.transportReason ?? 'unusable-or-slow-api' : null,
          ...failedFixtures.map(f => f.reason)].filter(Boolean))] : [],
        fixtureIds: failedFixtures.map(f => f.id), attempts: 0, nextAttemptAt: now, acknowledgedAt: null });
      current.incident = failed ? id : null;
      if (state.events.length > 1000) throw Error('Alert history limit reached; retain evidence and investigate flapping');
    }
  }
  state.sourceBytes = complete.length;
  state.sourceHash = hash(complete);
  return state;
}

export async function saveAlertState(path, state) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify({ ...state, checksum: hash(JSON.stringify(state)) }) + '\n'); await file.sync(); }
  finally { await file.close(); }
  try {
    await rename(temporary, path);
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

export function readAlertState(contents) {
  const { checksum, ...state } = JSON.parse(contents);
  if (checksum !== hash(JSON.stringify(state))) throw Error('Alert state checksum mismatch; restore verified state, never reset pending delivery');
  return state;
}

export async function deliverAlert(destination, event, { token, fetcher = fetch, timeoutMs = 2000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let reader;
  try {
    const { attempts, nextAttemptAt, acknowledgedAt, lastError, ...payload } = event;
    const response = await fetcher(destination, { method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': event.id,
        ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ schema: 1, ...payload }) });
    if (!response.ok) return { accepted: false, reason: `receiver-http-${response.status}` };
    reader = response.body?.getReader();
    if (!reader) return { accepted: false, reason: 'missing-receiver-ack' };
    const chunks = []; let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 4096) return { accepted: false, reason: 'receiver-ack-too-large' };
      chunks.push(value);
    }
    const ack = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return ack.acceptedEventId === event.id ? { accepted: true } : { accepted: false, reason: 'wrong-receiver-ack' };
  } catch {
    return { accepted: false, reason: controller.signal.aborted ? 'receiver-timeout' : 'receiver-request-failed' };
  } finally {
    clearTimeout(timeout);
    controller.abort();
    await reader?.cancel().catch(() => {});
  }
}

export async function dispatchAlerts(state, destination, persist, { now = Date.now, ...options } = {}) {
  // Keep incident/recovery delivery ordered within each competition, while a
  // failing competition does not hold up the other's delivery.
  const first = new Map();
  for (const event of state.events) if (event.acknowledgedAt === null && !first.has(event.competition)) first.set(event.competition, event);
  const due = [...first.values()].filter(event => event.nextAttemptAt <= now());
  if (!due.length) return;
  for (const event of due) {
    event.attempts++;
    event.nextAttemptAt = now() + Math.min(30000, 5000 * 2 ** Math.min(event.attempts - 1, 3));
  }
  await persist(state);
  const results = await Promise.all(due.map(event => deliverAlert(destination, event, options)));
  due.forEach((event, i) => {
    if (results[i].accepted) { event.acknowledgedAt = now(); delete event.lastError; }
    else event.lastError = results[i].reason;
  });
  await persist(state);
}

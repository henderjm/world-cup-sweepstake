import { TERMINAL_MATCH_STATUSES } from "../../src/mapApiFootball.js";

const LIVE = new Set(["IN_PLAY", "PAUSED", "EXTRA_TIME", "PENALTY_SHOOTOUT", "BREAK"]);
const scoreValid = score => Number.isInteger(score?.home) && score.home >= 0
  && Number.isInteger(score?.away) && score.away >= 0;

export function validatePlan(plan) {
  const start = Date.parse(plan.start), end = Date.parse(plan.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 24 * 3600000)
    throw Error("Plan must have an explicit window of at most 24 hours");
  if (!Number.isInteger(plan.intervalMs) || plan.intervalMs < 1000 || plan.intervalMs > 60000)
    throw Error("intervalMs must be between 1000 and 60000");
  const origin = new URL(plan.origin);
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/"
    || !(origin.protocol === "https:" || (origin.protocol === "http:" && ["localhost", "127.0.0.1"].includes(origin.hostname))))
    throw Error("Use an HTTPS origin, or a local HTTP fixture server, without credentials");
  if (!Array.isArray(plan.competitions) || !plan.competitions.length
    || new Set(plan.competitions).size !== plan.competitions.length
    || plan.competitions.some(code => !["PL", "CL"].includes(code))) throw Error("Select PL and/or CL once each");
  if (!Array.isArray(plan.fixtures)) throw Error("An explicit expected-fixture list is required");
  const ids = new Set();
  for (const f of plan.fixtures) {
    const key = `${f.competition}:${f.id}`;
    if (!plan.competitions.includes(f.competition) || !Number.isSafeInteger(f.id) || f.id <= 0
      || !Number.isFinite(Date.parse(f.utcDate)) || Date.parse(f.utcDate) >= end || ids.has(key))
      throw Error("Invalid or duplicate expected fixture");
    ids.add(key);
  }
  return { ...plan, start: new Date(start).toISOString(), end: new Date(end).toISOString(), origin: origin.origin };
}

export function observeFeed(body, competition, expected, at) {
  if (body?.competition !== competition || body.error || !Array.isArray(body.matches))
    return { reason: "invalid-feed", fixtures: [] };
  const ids = body.matches.map(m => m?.id);
  if (ids.some(id => !Number.isSafeInteger(id) || id <= 0) || new Set(ids).size !== ids.length)
    return { reason: "invalid-fixture-ids", fixtures: [] };
  const timestamp = typeof body.lastUpdated === "string" ? Date.parse(body.lastUpdated) : NaN;
  const ageMs = at - timestamp;
  const reason = !Number.isFinite(ageMs) ? "missing-source-time"
    : ageMs < -1000 ? "future-source-time"
    : body.stale || (Number.isFinite(body.staleAgeMs) && body.staleAgeMs > 60000) ? "stale-feed"
    : ageMs > 60000 ? "old-source-time" : null;
  const matches = new Map(body.matches.map(m => [m.id, m]));
  return {
    reason, sourceTime: Number.isFinite(timestamp) ? timestamp : null,
    reportedAgeMs: Number.isFinite(ageMs) ? ageMs : null,
    fixtures: expected.map(f => {
      const m = matches.get(f.id);
      const terminal = TERMINAL_MATCH_STATUSES.has(m?.status);
      const valid = (LIVE.has(m?.status) || ["FINISHED", "AWARDED"].includes(m?.status))
        ? scoreValid(m.score) : ["POSTPONED", "CANCELLED", "TIMED", "SCHEDULED"].includes(m?.status);
      const fixtureReason = !m ? "missing-fixture" : !valid ? "invalid-fixture"
        : ["TIMED", "SCHEDULED"].includes(m.status) ? "kickoff-unconfirmed" : null;
      return { id: f.id, status: m?.status ?? null,
        score: scoreValid(m?.score) ? m.score : null,
        reason: fixtureReason,
        terminal: terminal && valid && !reason };
    }),
  };
}

export async function probe(plan, competition, scheduledAt, { fetcher = fetch, now = Date.now } = {}) {
  const startedAt = now();
  const base = { type: "probe", competition, scheduledAt, startedAt };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(8000, plan.intervalMs));
  let httpStatus = null;
  try {
    const response = await fetcher(`${plan.origin}/${competition}/live`, {
      signal: controller.signal, redirect: "error", headers: { Origin: "https://kickoffdraft.com" },
    });
    httpStatus = response.status;
    if (!response.ok) throw Error(`http-${httpStatus}`);
    const body = await response.json();
    const completedAt = now();
    return { ...base, httpStatus, completedAt, durationMs: completedAt - startedAt,
      ...observeFeed(body, competition, plan.fixtures.filter(f => f.competition === competition), completedAt) };
  } catch (error) {
    const completedAt = now();
    return { ...base, httpStatus, completedAt, durationMs: completedAt - startedAt,
      reason: controller.signal.aborted ? "timeout" : httpStatus && httpStatus !== 200 ? `http-${httpStatus}`
        : error instanceof SyntaxError ? "invalid-json" : "request-failed", fixtures: [] };
  } finally { clearTimeout(timer); }
}

const percentage = (good, total) => total ? 100 * good / total : null;
const percentile = (values, fraction) => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1] : null;

export function summarize(plan, records, asOf = Date.now()) {
  const start = Date.parse(plan.start), end = Math.max(start, Math.min(Date.parse(plan.end), asOf));
  const slots = new Map();
  for (const row of records) {
    if (row.type !== "probe") continue;
    const key = `${row.competition}:${row.scheduledAt}`;
    if (!plan.competitions.includes(row.competition) || row.scheduledAt < start
      || row.scheduledAt >= Date.parse(plan.end) || (row.scheduledAt - start) % plan.intervalMs || slots.has(key))
      throw Error("Ledger contains duplicate or out-of-plan observations");
    slots.set(key, row);
  }
  const competitions = {};
  for (const code of plan.competitions) {
    const totals = { scheduledChecks: 0, completedChecks: 0, missingChecks: 0, usableApiChecks: 0,
      expectedFixtureChecks: 0, freshFixtureChecks: 0, feedReasons: {}, reasons: {}, fixtures: {} };
    const retired = new Set(), latencies = [];
    for (let at = start; at < end; at += plan.intervalMs) {
      const row = slots.get(`${code}:${at}`);
      const completed = row && Number.isFinite(row.completedAt) && row.completedAt <= asOf;
      totals.scheduledChecks++;
      if (completed) { totals.completedChecks++; latencies.push(row.durationMs); }
      else totals.missingChecks++;
      const timely = completed && row.startedAt >= at && row.startedAt <= at + Math.min(1000, plan.intervalMs / 10)
        && row.completedAt <= at + plan.intervalMs;
      const transportReason = !completed ? "missing-observation" : !timely ? "late-observation" : row.reason;
      if (transportReason) totals.feedReasons[transportReason] = (totals.feedReasons[transportReason] ?? 0) + 1;
      if (!transportReason) for (const detail of row?.fixtures ?? []) {
        if (LIVE.has(detail.status) && !detail.reason) retired.delete(detail.id);
      }
      const expected = plan.fixtures.filter(f => f.competition === code && Date.parse(f.utcDate) <= at && !retired.has(f.id));
      let usable = completed && timely && row.httpStatus === 200 && row.durationMs <= 2000
        && !["invalid-feed", "invalid-fixture-ids", "invalid-json", "request-failed"].includes(row.reason);
      for (const f of expected) {
        const detail = row?.fixtures?.find(m => m.id === f.id);
        const reason = transportReason ?? detail?.reason ?? (!detail ? "missing-fixture" : null);
        const stats = totals.fixtures[f.id] ??= { expected: 0, fresh: 0, longestFailureChecks: 0, consecutiveFailures: 0 };
        stats.expected++;
        totals.expectedFixtureChecks++;
        if (!reason) { stats.fresh++; totals.freshFixtureChecks++; stats.consecutiveFailures = 0; }
        else {
          totals.reasons[reason] = (totals.reasons[reason] ?? 0) + 1;
          stats.longestFailureChecks = Math.max(stats.longestFailureChecks, ++stats.consecutiveFailures);
        }
        if (!detail || ["missing-fixture", "invalid-fixture", "kickoff-unconfirmed"].includes(detail.reason)) usable = false;
        // A stale final result cannot erase an expected match from subsequent checks.
        if (detail?.terminal && !reason) retired.add(f.id);
      }
      if (usable) totals.usableApiChecks++;
    }
    for (const stats of Object.values(totals.fixtures)) {
      stats.reportedFreshnessPercent = percentage(stats.fresh, stats.expected);
      delete stats.consecutiveFailures;
    }
    competitions[code] = { ...totals,
      monitorCoveragePercent: percentage(totals.completedChecks, totals.scheduledChecks),
      usableApiPercent: percentage(totals.usableApiChecks, totals.scheduledChecks),
      reportedFixtureFreshnessPercent: percentage(totals.freshFixtureChecks, totals.expectedFixtureChecks),
      responseLatencyP95Ms: percentile(latencies, 0.95), responseLatencyP99Ms: percentile(latencies, 0.99) };
  }
  return { schema: 1, start: plan.start, end: new Date(end).toISOString(), intervalMs: plan.intervalMs,
    measurement: "API responses and feed-reported timestamps; not browser availability or verified provider freshness",
    competitions };
}

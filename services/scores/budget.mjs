import { isLimitRejection, parseQuotaHeaders } from "../../src/apiQuota.js";

export const DISPATCH_WINDOW_MS = 1000;
export const PROVIDER_TIMEOUT_MS = 5000;
const DAY_MS = 86400000;
const day = now => Math.floor(now / DAY_MS);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const gap = policy => Math.max(Math.ceil(60000 / policy.minuteLimit),
  Math.ceil(1000 / Math.max(1, Math.floor(policy.minuteLimit / 60)))) + 1;

function validPolicy(policy) {
  return integer(policy?.dailyLimit) && policy.dailyLimit > 0
    && integer(policy.minuteLimit) && policy.minuteLimit > 0 && policy.minuteLimit <= 1200
    && integer(policy.scoreReserve) && policy.scoreReserve <= policy.dailyLimit;
}

export function initialBudget(policy, used, now) {
  if (!integer(now) || !integer(used) || !validPolicy(policy) || used > policy.dailyLimit)
    throw Error("Verified initial usage and explicit provider budget policy are required");
  return { version: 1, policy: { ...policy }, day: day(now), used, updatedAt: now,
    nextAt: now + 60000, blockedUntil: 0, failures: 0, permit: null };
}

function currentBudget(previous, now) {
  if (!previous || !integer(now) || now < previous.updatedAt) throw Error("Missing budget or clock moved backwards");
  if (!validPolicy(previous.policy) || ![previous.used, previous.day, previous.updatedAt, previous.nextAt,
    previous.blockedUntil, previous.failures, previous.version].every(integer)
    || previous.day !== day(previous.updatedAt) || previous.version < 1
    || previous.version >= Number.MAX_SAFE_INTEGER || previous.failures > 6)
    throw Error("Invalid stored provider budget");
  return { ...previous, policy: { ...previous.policy }, day: day(now),
    used: day(now) === previous.day ? previous.used : 0,
    version: previous.version + 1, updatedAt: now };
}

export function reserveRequest(previous, { priority, id, now, admissionTimeoutMs }) {
  if (!["scores", "match-detail", "supplementary"].includes(priority) || !id) throw Error("Invalid provider request priority or ID");
  const next = currentBudget(previous, now);
  const expiresAt = now + admissionTimeoutMs + DISPATCH_WINDOW_MS + PROVIDER_TIMEOUT_MS;
  const tomorrow = (next.day + 1) * DAY_MS;
  const deny = (reason, retryAt) => ({ allowed: false, reason, retryAt });
  if (now < Math.max(next.nextAt, next.blockedUntil)) return deny("paced", Math.max(next.nextAt, next.blockedUntil));
  if (expiresAt >= tomorrow) return deny("day-boundary", tomorrow);
  // Current match details may use half the reserve; scores retain the other half.
  const reserve = priority === "scores" ? 0 : priority === "match-detail"
    ? Math.ceil(next.policy.scoreReserve / 2) : next.policy.scoreReserve;
  const cap = next.policy.dailyLimit - reserve;
  if (next.used >= cap) return deny(priority === "scores" ? "daily-limit" : "score-reserve", tomorrow);
  next.used++;
  next.permit = { id, day: next.day, dispatchBy: expiresAt - PROVIDER_TIMEOUT_MS, expiresAt };
  // A crashed caller spends its reservation and occupies the slot until its
  // entire dispatch/body deadline has passed. No refund can create a retry burst.
  next.nextAt = expiresAt + gap(next.policy);
  return { allowed: true, next, permit: next.permit };
}

export function finishRequest(previous, permit, { ok, status, headers, errors }, now) {
  const next = currentBudget(previous, now);
  if (next.permit?.id !== permit.id) throw Error("Provider permit was replaced");
  const quota = parseQuotaHeaders(headers);
  if (integer(quota.dailyLimit) && quota.dailyLimit > 0) next.policy.dailyLimit = Math.min(next.policy.dailyLimit, quota.dailyLimit);
  if (integer(quota.minuteLimit) && quota.minuteLimit > 0) next.policy.minuteLimit = Math.min(next.policy.minuteLimit, quota.minuteLimit);
  next.policy.scoreReserve = Math.min(next.policy.scoreReserve, next.policy.dailyLimit);
  if (permit.day === next.day && integer(quota.dailyRemaining))
    next.used = Math.max(next.used, (integer(quota.dailyLimit) && quota.dailyLimit > 0 ? quota.dailyLimit : next.policy.dailyLimit) - quota.dailyRemaining);
  next.failures = ok ? 0 : Math.min(6, next.failures + 1);
  const retry = headers?.get?.("retry-after");
  const retryMs = retry == null ? 0 : /^\d+(\.\d+)?$/.test(retry.trim()) ? Number(retry) * 1000 : Date.parse(retry) - now;
  const limited = isLimitRejection(status, errors) || quota.minuteRemaining === 0;
  const wait = Math.max(ok ? 0 : Math.min(30000, 1000 * 2 ** (next.failures - 1)), limited ? 60000 : 0,
    Number.isNaN(retryMs) ? 0 : Math.min(DAY_MS, Math.max(0, retryMs)));
  next.blockedUntil = Math.max(next.blockedUntil, now + wait);
  next.nextAt = now + gap(next.policy);
  next.permit = null;
  return next;
}

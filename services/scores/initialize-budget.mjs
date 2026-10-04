import { randomUUID } from 'node:crypto';
import { initialBudget } from './budget.mjs';

const DAY_MS = 86400000;
export function validateInitialization(input, now = Date.now()) {
  if (!input || !/^arn:aws:dynamodb:(?:eu-west-1:\d{12}|ddblocal:000000000000):table\/[A-Za-z0-9_.-]{3,255}$/.test(input.tableArn ?? ''))
    throw Error('An exact Ireland or DynamoDB Local table ARN is required');
  if (!Number.isSafeInteger(input.observedAt) || input.observedAt > now || now - input.observedAt > 300000
    || Math.floor(input.observedAt / DAY_MS) !== Math.floor(now / DAY_MS)
    || Math.floor((now + 30000) / DAY_MS) !== Math.floor(now / DAY_MS))
    throw Error('Usage evidence must be from this UTC day, at most five minutes old, and outside the last 30 seconds of the day');
  if (!Number.isSafeInteger(input.consumersStoppedAt) || input.consumersStoppedAt > input.observedAt
    || input.consumersStoppedAt < 0 || input.consumersStopped !== true
    || typeof input.evidence !== 'string' || !input.evidence.trim() || input.evidence.length > 1000)
    throw Error('Confirm all other consumers stopped before observing usage and supply an evidence reference');
  if (![input.used, input.uncertainRequests].every(value => Number.isSafeInteger(value) && value >= 0))
    throw Error('Explicit observed usage and uncertain in-flight requests are required');
  const used = input.used + input.uncertainRequests;
  const policy = input.policy && { dailyLimit: input.policy.dailyLimit, minuteLimit: input.policy.minuteLimit, scoreReserve: input.policy.scoreReserve };
  const budget = initialBudget(policy, used, now);
  return { tableArn: input.tableArn, observedAt: input.observedAt, used,
    policy: budget.policy, evidence: input.evidence, providerCalls: 0 };
}

export async function initializeVerifiedBudget(store, input, now = Date.now) {
  validateInitialization(input, now());
  if (await store.readBudget()) throw Error('Budget already exists; initialization cannot reset usage');
  const lease = await store.claim(`initialize-${randomUUID()}`);
  if (!lease) throw Error('Collector lease is occupied; stop collection and wait for expiry');
  const plan = validateInitialization(input, now());
  await store.initializeBudget(lease, plan.policy, plan.used);
  const saved = await store.readBudget();
  if (!saved || saved.used !== plan.used || saved.version !== 1)
    throw Error('Initialization outcome uncertain; inspect the stored budget before any retry');
  return { ...plan, version: saved.version, nextAt: saved.nextAt, day: saved.day };
}

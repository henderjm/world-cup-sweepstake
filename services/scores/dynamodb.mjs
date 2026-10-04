import { randomUUID } from "node:crypto";
import { GetItemCommand, PutItemCommand, TransactWriteItemsCommand } from "@aws-sdk/client-dynamodb";
import { COMPETITIONS } from "../../src/competitions.js";
import { nextSnapshot } from "./snapshots.mjs";
import { initialBudget, reserveRequest, finishRequest } from "./budget.mjs";
import { snapshotLayout, validateManifest, assembleSnapshot, digest, MAX_PART_BYTES } from "./layout.mjs";

const leaseKey = { pk: { S: "COLLECTOR" } };
const budgetKey = { pk: { S: "PROVIDER_BUDGET" } };
function snapshotKey(competition, season) {
  if (!Object.hasOwn(COMPETITIONS, competition) || !/^\d{4}$/.test(String(season))) throw Error("Invalid snapshot identity");
  return { pk: { S: `SCORE#${competition}#${season}` } };
}

function leaseFrom(item) {
  if (!item) return null;
  const lease = { owner: item.owner?.S, epoch: Number(item.epoch?.N), expiresAt: Number(item.expiresAt?.N) };
  if (!lease.owner || !Number.isSafeInteger(lease.epoch) || lease.epoch < 1 || !Number.isSafeInteger(lease.expiresAt))
    throw Error("Invalid stored collector lease");
  return lease;
}

export class DynamoScoreStore {
  constructor({ client, tableName, now = Date.now, requestTimeoutMs = 3000 }) {
    if (!client || !tableName || !Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 10000)
      throw Error("Client, table and bounded request timeout are required");
    this.client = client;
    this.tableName = tableName;
    this.now = now;
    this.requestTimeoutMs = requestTimeoutMs;
    this.parts = new Map();
    this.partBytes = 0;
  }

  send(command, signal) {
    const timeout = AbortSignal.timeout(this.requestTimeoutMs);
    return this.client.send(command, { abortSignal: signal ? AbortSignal.any([timeout, signal]) : timeout });
  }

  async claim(owner, ttl = 30000) {
    if (typeof owner !== "string" || !owner || owner.length > 128 || !Number.isInteger(ttl)
      || ttl < Math.max(10000, 2 * this.requestTimeoutMs) || ttl > 60000) throw Error("Invalid collector lease");
    const result = await this.send(new GetItemCommand({ TableName: this.tableName, Key: leaseKey, ConsistentRead: true }));
    const previous = leaseFrom(result.Item), now = this.now();
    if (previous?.expiresAt > now && previous.owner !== owner) return null;
    const epoch = previous && previous.expiresAt > now ? previous.epoch : (previous?.epoch ?? 0) + 1;
    if (!Number.isSafeInteger(epoch)) throw Error("Collector generation exhausted");
    const lease = { owner, epoch, expiresAt: now + ttl };
    try {
      await this.send(new PutItemCommand({
        TableName: this.tableName,
        Item: { ...leaseKey, owner: { S: owner }, epoch: { N: String(epoch) }, expiresAt: { N: String(lease.expiresAt) } },
        ConditionExpression: previous ? "#owner = :owner AND epoch = :epoch AND expiresAt = :expiry" : "attribute_not_exists(pk)",
        ...(previous ? { ExpressionAttributeNames: { "#owner": "owner" }, ExpressionAttributeValues: {
          ":owner": { S: previous.owner }, ":epoch": { N: String(previous.epoch) }, ":expiry": { N: String(previous.expiresAt) },
        } } : {}),
      }));
      return lease.expiresAt > this.now() + this.requestTimeoutMs ? lease : null;
    } catch (error) {
      if (error.name === "ConditionalCheckFailedException") return null;
      throw error;
    }
  }

  async read(competition, season) {
    const key = snapshotKey(competition, season), deadline = AbortSignal.timeout(this.requestTimeoutMs);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await this.send(new GetItemCommand({ TableName: this.tableName, Key: key, ConsistentRead: true }), deadline);
      if (!result.Item) return null;
      const manifest = JSON.parse(result.Item.manifest.S);
      validateManifest(manifest, competition, season, Number(result.Item.version.N));
      const entries = await Promise.all(Object.entries(manifest.parts).map(async ([name, hash]) =>
        [name, await this.readPart(`${key.pk.S}#${name}`, hash, deadline)]));
      // A writer may replace a mutable partition after the manifest read.
      // Retry the whole read; never attach that newer part to the older version.
      if (entries.every(([, data]) => data !== null)) return assembleSnapshot(manifest, Object.fromEntries(entries));
    }
    throw Error("Score publication changed during read or a partition is unavailable");
  }

  async readPart(key, hash, signal) {
    const cacheKey = `${key}#${hash}`;
    if (this.parts.has(cacheKey)) return this.parts.get(cacheKey);
    const result = await this.send(new GetItemCommand({ TableName: this.tableName, Key: { pk: { S: key } }, ConsistentRead: true }), signal);
    const data = result.Item?.data?.S;
    if (typeof data !== "string" || Buffer.byteLength(data) > MAX_PART_BYTES || result.Item.digest?.S !== hash || digest(data) !== hash) return null;
    // Cache immutable strings by content digest; returning parsed objects would
    // let one caller corrupt the value used by later readers.
    if (!this.parts.has(cacheKey)) {
      const size = Buffer.byteLength(data);
      while (this.partBytes + size > 8 * 1024 * 1024) {
        const oldest = this.parts.keys().next().value;
        this.partBytes -= Buffer.byteLength(this.parts.get(oldest)); this.parts.delete(oldest);
      }
      this.parts.set(cacheKey, data); this.partBytes += size;
    }
    return data;
  }

  async publish(lease, input) {
    const previous = await this.read(input.competition, input.season);
    const next = nextSnapshot(previous, input, { epoch: lease.epoch, now: this.now() });
    const key = snapshotKey(input.competition, input.season), { manifest, parts } = snapshotLayout(next);
    const old = previous ? snapshotLayout(previous).parts : {};
    const changed = Object.entries(parts).filter(([name, part]) => old[name]?.digest !== part.digest)
      .map(([name, part]) => ({ Put: { TableName: this.tableName,
        Item: { pk: { S: `${key.pk.S}#${name}` }, digest: { S: part.digest }, data: { S: part.data } } } }));
    await this.commit(lease, { ...key, manifest: { S: JSON.stringify(manifest) } }, input.baseVersion, undefined, changed);
    return next.version;
  }

  async readBudget() {
    const result = await this.send(new GetItemCommand({ TableName: this.tableName, Key: budgetKey, ConsistentRead: true }));
    return result.Item ? JSON.parse(result.Item.budget.S) : null;
  }

  async initializeBudget(lease, policy, used) {
    const next = initialBudget(policy, used, this.now());
    await this.writeBudget(lease, next, 0);
  }

  async reserve(lease, priority) {
    const previous = await this.readBudget();
    const result = reserveRequest(previous, { priority, id: randomUUID(), now: this.now(), admissionTimeoutMs: this.requestTimeoutMs });
    if (!result.allowed) return result;
    await this.writeBudget(lease, result.next, previous.version, result.permit.expiresAt);
    return { allowed: true, permit: result.permit };
  }

  async finish(lease, permit, outcome) {
    const previous = await this.readBudget();
    const next = finishRequest(previous, permit, outcome, this.now());
    await this.writeBudget(lease, next, previous.version);
  }

  writeBudget(lease, next, baseVersion, validThrough) {
    return this.commit(lease, { ...budgetKey, budget: { S: JSON.stringify(next) } }, baseVersion, validThrough);
  }

  async commit(lease, item, baseVersion, validThrough = this.now() + this.requestTimeoutMs, additionalItems = []) {
    if (!lease || !Number.isSafeInteger(lease.expiresAt) || lease.expiresAt <= validThrough)
      throw Error("Collector lease expired or too close to expiry");
    await this.send(new TransactWriteItemsCommand({
      ClientRequestToken: randomUUID(),
      TransactItems: [
        { ConditionCheck: {
          TableName: this.tableName, Key: leaseKey,
          ConditionExpression: "#owner = :owner AND epoch = :epoch AND expiresAt >= :expiry AND expiresAt > :through",
          ExpressionAttributeNames: { "#owner": "owner" },
          ExpressionAttributeValues: { ":owner": { S: lease.owner }, ":epoch": { N: String(lease.epoch) },
            ":expiry": { N: String(lease.expiresAt) }, ":through": { N: String(validThrough) } },
        } },
        { Put: {
          TableName: this.tableName,
          Item: { ...item, version: { N: String(baseVersion + 1) } },
          ConditionExpression: baseVersion ? "#version = :version" : "attribute_not_exists(pk)",
          ...(baseVersion ? { ExpressionAttributeNames: { "#version": "version" },
            ExpressionAttributeValues: { ":version": { N: String(baseVersion) } } } : {}),
        } },
        ...additionalItems,
      ],
    }));
  }
}

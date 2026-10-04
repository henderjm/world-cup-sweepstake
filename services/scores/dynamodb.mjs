import { randomUUID } from "node:crypto";
import { GetItemCommand, PutItemCommand, TransactWriteItemsCommand } from "@aws-sdk/client-dynamodb";
import { COMPETITIONS } from "../../src/competitions.js";
import { nextSnapshot } from "./snapshots.mjs";

const leaseKey = { pk: { S: "COLLECTOR" } };
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
  }

  send(command) {
    return this.client.send(command, { abortSignal: AbortSignal.timeout(this.requestTimeoutMs) });
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
    const result = await this.send(new GetItemCommand({ TableName: this.tableName,
      Key: snapshotKey(competition, season), ConsistentRead: true }));
    return result.Item ? JSON.parse(result.Item.snapshot.S) : null;
  }

  async publish(lease, input) {
    const previous = await this.read(input.competition, input.season);
    const now = this.now(), validThrough = now + this.requestTimeoutMs;
    if (!lease || !Number.isSafeInteger(lease.expiresAt) || lease.expiresAt <= validThrough)
      throw Error("Collector lease expired or too close to expiry");
    const next = nextSnapshot(previous, input, { epoch: lease.epoch, now });
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
          Item: { ...snapshotKey(input.competition, input.season), version: { N: String(next.version) }, snapshot: { S: JSON.stringify(next) } },
          ConditionExpression: previous ? "#version = :version" : "attribute_not_exists(pk)",
          ...(previous ? { ExpressionAttributeNames: { "#version": "version" },
            ExpressionAttributeValues: { ":version": { N: String(input.baseVersion) } } } : {}),
        } },
      ],
    }));
    return next.version;
  }
}

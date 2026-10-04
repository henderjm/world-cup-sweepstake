import { randomUUID } from "node:crypto";
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";

export const endpoint = process.env.SCORE_DYNAMODB_ENDPOINT ?? "http://127.0.0.1:18043";
const target = new URL(endpoint);
if (target.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(target.hostname) || target.username || target.password)
  throw Error("Integration tests require a loopback DynamoDB Local endpoint");

export const client = () => new DynamoDBClient({ endpoint, region: "eu-west-1", maxAttempts: 1,
  credentials: { accessKeyId: "localtest", secretAccessKey: "localtest" } });

export async function createTable(db) {
  const TableName = `kickoff_score_test_${randomUUID().replaceAll("-", "")}`;
  await db.send(new CreateTableCommand({ TableName, BillingMode: "PAY_PER_REQUEST",
    AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }], KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }] }),
  { abortSignal: AbortSignal.timeout(10000) });
  return TableName;
}

export async function deleteTable(db, tableName) {
  if (!/^kickoff_score_test_[a-f0-9]{32}$/.test(tableName)) throw Error("Not an owned integration-test table");
  await db.send(new DeleteTableCommand({ TableName: tableName }), { abortSignal: AbortSignal.timeout(10000) });
}

export function input(now, baseVersion = 0, score = 1) {
  return { competition: "CL", season: "2026", baseVersion, scheduleObservedAt: now,
    fixtures: [{ observedAt: now, providerUpdatedAt: null, match: { id: 900001,
      utcDate: new Date(now - 1800000).toISOString(), status: "IN_PLAY", stage: "LEAGUE_STAGE",
      homeTeam: "Home", awayTeam: "Away", score: { home: score, away: 0 } } }] };
}

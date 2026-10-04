import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoScoreStore } from "./dynamodb.mjs";
import { ScoreProvider } from "./provider.mjs";
import { ScoreCollector } from "./collector.mjs";
import { parseSeasons, loopbackEndpoint } from "./config.mjs";

const { SCORE_TABLE_NAME: tableName, SCORE_SEASONS: configuredSeasons, SCORE_DYNAMODB_ENDPOINT: databaseEndpoint,
  SCORE_PROVIDER_ENDPOINT: providerEndpoint, API_FOOTBALL_KEY: apiKey } = process.env;
if (!tableName || !configuredSeasons) throw Error("SCORE_TABLE_NAME and SCORE_SEASONS are required; storage must already be initialized");
const seasons = parseSeasons(configuredSeasons);
const local = Boolean(databaseEndpoint || providerEndpoint);
if (local) {
  for (const endpoint of [databaseEndpoint, providerEndpoint]) loopbackEndpoint(endpoint);
} else if (!apiKey) throw Error("API_FOOTBALL_KEY is required outside local test mode");
const db = new DynamoDBClient({ region: process.env.AWS_REGION ?? "eu-west-1", maxAttempts: 2,
  ...(local ? { endpoint: databaseEndpoint, credentials: { accessKeyId: "localtest", secretAccessKey: "localtest" } } : {}) });
const store = new DynamoScoreStore({ client: db, tableName });
const provider = new ScoreProvider({ store, apiKey: local ? "localtest" : apiKey,
  ...(local ? { fetch: (url, options) => fetch(new URL(url.pathname + url.search, providerEndpoint), options) } : {}) });
const collector = new ScoreCollector({ store, provider, seasons });
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => controller.abort());
try {
  await collector.run({ signal: controller.signal, onEvent: event => {
    if (!["idle", "standby", "deferred"].includes(event.state)) console.log(JSON.stringify({ at: new Date().toISOString(), ...event }));
  } });
} finally { db.destroy(); }

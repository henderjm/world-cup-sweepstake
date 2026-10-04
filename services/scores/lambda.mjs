import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoScoreStore } from "./dynamodb.mjs";
import { createReadHandler } from "./read-handler.mjs";
import { parseSeasons, loopbackEndpoint } from "./config.mjs";

const tableName = process.env.SCORE_TABLE_NAME;
if (!tableName) throw Error("SCORE_TABLE_NAME is required");
const endpoint = process.env.SCORE_DYNAMODB_ENDPOINT;
export const database = new DynamoDBClient({ region: process.env.AWS_REGION ?? "eu-west-1", maxAttempts: 2,
  ...(endpoint ? { endpoint: loopbackEndpoint(endpoint), credentials: { accessKeyId: "localtest", secretAccessKey: "localtest" } } : {}) });
const store = new DynamoScoreStore({ client: database, tableName });
export const handler = createReadHandler({ store, seasons: parseSeasons(process.env.SCORE_SEASONS) });

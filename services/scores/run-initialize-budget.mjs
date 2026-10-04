import { readFile, stat } from 'node:fs/promises';
import { DynamoDBClient, DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { DynamoScoreStore } from './dynamodb.mjs';
import { loopbackEndpoint } from './config.mjs';
import { validateInitialization, initializeVerifiedBudget } from './initialize-budget.mjs';

const [path, mode, ...extra] = process.argv.slice(2);
if (!path || (mode && mode !== '--apply') || extra.length)
  throw Error('Usage: node services/scores/run-initialize-budget.mjs EVIDENCE.json [--apply]');
if ((await stat(path)).size > 16384) throw Error('Evidence file exceeds 16 KiB');
const input = JSON.parse(await readFile(path, 'utf8'));
const plan = validateInitialization(input);
if (!mode) {
  console.log(JSON.stringify({ mode: 'preview', ...plan }));
} else {
  const endpoint = process.env.SCORE_DYNAMODB_ENDPOINT;
  if (!endpoint && input.tableArn.includes(':ddblocal:')) throw Error('A DynamoDB Local ARN requires a loopback endpoint');
  const db = new DynamoDBClient({ region: 'eu-west-1', maxAttempts: 1,
    ...(endpoint ? { endpoint: loopbackEndpoint(endpoint), credentials: { accessKeyId: 'localtest', secretAccessKey: 'localtest' } } : {}) });
  try {
    const tableName = input.tableArn.split('/')[1];
    const table = await db.send(new DescribeTableCommand({ TableName: tableName }), { abortSignal: AbortSignal.timeout(5000) });
    if (table.Table?.TableArn !== input.tableArn || table.Table?.TableStatus !== 'ACTIVE')
      throw Error('Table identity/status does not match approved evidence');
    const result = await initializeVerifiedBudget(new DynamoScoreStore({ client: db, tableName }), input);
    console.log(JSON.stringify({ mode: 'applied', ...result }));
  } finally { db.destroy(); }
}

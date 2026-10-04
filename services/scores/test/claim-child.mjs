import { DynamoScoreStore } from "../dynamodb.mjs";
import { client } from "./support.mjs";
const [tableName, owner, at] = process.argv.slice(2);
const db = client();
try {
  const store = new DynamoScoreStore({ client: db, tableName, now: () => Number(at) });
  console.log(JSON.stringify(await store.claim(owner)));
} finally { db.destroy(); }

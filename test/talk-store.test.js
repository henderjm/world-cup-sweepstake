import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, test } from "node:test";

import { readBanter, resetTalkTablesKnown, talkAction } from "../worker/talkStore.js";

// A D1-shaped adapter over real SQLite (as in live-wire-store.test.js), so the
// moderation SQL itself is under test. Base tables come from schema.sql's
// users/banter block; moderation tables from the 013 migration.
function d1({ migrated = true } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT);
    CREATE TABLE banter_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, match_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, text TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE banter_reactions (match_id INTEGER NOT NULL, user_id INTEGER NOT NULL, emoji TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (match_id, user_id, emoji));
    INSERT INTO users (id, name, email) VALUES (1, 'Ann', 'a@x'), (2, 'Ben', 'b@x'), (3, 'Cat', 'c@x'), (9, 'Mod', 'm@x');
  `);
  if (migrated) {
    sqlite.exec(readFileSync(new URL("../worker/migrations/013-talk-moderation.sql", import.meta.url), "utf8"));
    sqlite.exec("INSERT INTO talk_moderators (user_id) VALUES (9)");
  }
  const prepare = (sql) => {
    let args = [];
    const self = {
      bind: (...values) => { args = values; return self; },
      run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } }),
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
      first: async () => sqlite.prepare(sql).get(...args) ?? null,
    };
    return self;
  };
  return { sqlite, prepare };
}

const clean = (value) => String(value ?? "").trim().slice(0, 140);
const MATCH = 100;
let env;
const user = (id) => ({ id });
const post = (id, text) => talkAction(env, MATCH, user(id), { action: "message", text }, clean);
const act = (id, action, messageId) => talkAction(env, MATCH, user(id), { action, messageId }, clean);
const texts = async (viewer) => (await readBanter(env, MATCH, viewer)).messages.map((message) => `${message.text}:${message.state}`);
// Age every stored post past the 10-second window so tests can post again.
const age = () => env.DB.sqlite.exec("UPDATE banter_messages SET created_at = datetime('now', '-1 minute')");

beforeEach(() => {
  resetTalkTablesKnown();
  env = { DB: d1() };
});

test("one post per 10 seconds per account", async () => {
  assert.deepEqual(await post(1, "first"), {});
  const second = await post(1, "second");
  assert.equal(second.status, 429);
  assert.equal(second.reason, "too-fast");
  assert.deepEqual(await post(2, "someone else"), {});
});

test("two reports hide a comment from everyone but its author", async () => {
  await post(1, "spicy");
  const id = env.DB.sqlite.prepare("SELECT id FROM banter_messages").get().id;
  await act(2, "report", id);
  assert.deepEqual(await texts(3), ["spicy:visible"]);
  await act(3, "report", id);
  assert.deepEqual(await texts(3), []);
  assert.deepEqual(await texts(null), []);
  assert.deepEqual(await texts(1), ["spicy:pending"]);
  assert.deepEqual(await texts(9), ["spicy:pending"], "the moderator still sees it, labelled");
});

test("reporting your own comment, or one on another match, is refused", async () => {
  await post(1, "mine");
  const id = env.DB.sqlite.prepare("SELECT id FROM banter_messages").get().id;
  assert.equal((await act(1, "report", id)).status, 400);
  assert.equal((await talkAction(env, 999, user(2), { action: "report", messageId: id }, clean)).status, 404);
});

test("only a moderator can hide or mute", async () => {
  await post(1, "hello");
  const id = env.DB.sqlite.prepare("SELECT id FROM banter_messages").get().id;
  assert.equal((await act(2, "hide", id)).status, 403);
  assert.equal((await act(2, "mute", id)).status, 403);
  assert.deepEqual(await act(9, "hide", id), {});
  assert.deepEqual(await texts(2), []);
  assert.deepEqual(await texts(1), ["hello:removed"]);
});

test("a muted account keeps posting and only it can see the posts", async () => {
  await post(1, "before");
  const id = env.DB.sqlite.prepare("SELECT id FROM banter_messages").get().id;
  await act(9, "mute", id);
  age();
  assert.deepEqual(await post(1, "after"), {});
  assert.deepEqual(await texts(1), ["before:visible", "after:visible"], "never told it is muted");
  assert.deepEqual(await texts(2), []);
  await act(9, "unmute", id);
  assert.deepEqual(await texts(2), ["before:visible", "after:visible"]);
});

test("before the migration, banter still reads and posts, unmoderated", async () => {
  env = { DB: d1({ migrated: false }) };
  assert.deepEqual(await post(1, "one"), {});
  assert.deepEqual(await post(1, "two"), {}, "no rate limit without the tables");
  assert.deepEqual(await texts(2), ["one:visible", "two:visible"]);
  assert.equal((await act(2, "report", 1)).status, 501);
});

import assert from "node:assert/strict";
import test from "node:test";
import worker from "../worker/worker.js";

function environment(user = { id: 7, email: "one@example.test" }) {
  const calls = [];
  const env = {
    FCM_SERVICE_ACCOUNT: "{}",
    DB: {
      prepare(sql) {
        let values;
        const statement = {
          bind(...args) { values = args; return statement; },
          first: async () => user,
          run: async () => { calls.push({ sql, values }); return { success: true }; },
          all: async () => { calls.push({ sql, values }); return { results: [] }; },
        };
        return statement;
      },
    },
  };
  return { env, calls };
}

function post(path, body, token = "s".repeat(40)) {
  return new Request(`https://worker.test${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test("native registration requires a session and stores the verified account", async () => {
  const { env, calls } = environment();
  const subscription = { provider: "fcm", token: "a".repeat(40) };
  assert.equal((await worker.fetch(post("/push/subscribe", { subscription }, null), env)).status, 401);
  assert.equal((await worker.fetch(post("/push/subscribe", { subscription, user_id: 99 }), env)).status, 200);
  assert.deepEqual(calls[0].values, [`fcm:${subscription.token}`, 7]);
});

test("native configuration and malformed tokens fail without writes", async () => {
  const { env, calls } = environment();
  assert.equal((await worker.fetch(post("/push/subscribe", { subscription: { provider: "fcm", token: "https://evil.test/" } }), env)).status, 400);
  delete env.FCM_SERVICE_ACCOUNT;
  assert.equal((await worker.fetch(post("/push/subscribe", { subscription: { provider: "fcm", token: "a".repeat(40) } }), env)).status, 501);
  assert.equal(calls.length, 0);
});

test("device tests select the endpoint within the signed-in account", async () => {
  const { env, calls } = environment();
  const response = await worker.fetch(post("/push/test", { endpoint: "fcm:other-device", user_id: 99 }), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { sent: 0, devices: 0 });
  assert.match(calls[0].sql, /user_id = \?1 AND endpoint = \?2/);
  assert.deepEqual(calls[0].values, [7, "fcm:other-device"]);
});

test("older web test requests remain compatible and revocation works without delivery credentials", async () => {
  const { env, calls } = environment();
  assert.equal((await worker.fetch(post("/push/test"), env)).status, 200);
  assert.deepEqual(calls[0].values, [7]);
  delete env.FCM_SERVICE_ACCOUNT;
  assert.equal((await worker.fetch(post("/push/unsubscribe", { endpoint: "fcm:device" }), env)).status, 200);
  assert.match(calls[1].sql, /endpoint = \?1 AND user_id = \?2/);
  assert.deepEqual(calls[1].values, ["fcm:device", 7]);
});

import assert from "node:assert/strict";
import test from "node:test";
import { createNativePushController, notificationPath } from "../src/nativePushController.js";
import { nativeEndpoint, nativeMessage, sendNativePush } from "../worker/native-push.js";

function device() {
  const values = new Map();
  const calls = [];
  const events = {};
  let owner = "one@example.test";
  let token = "a".repeat(40);
  let permission = "granted";
  let fail = false;
  const sdk = {
    addListener: async (event, fn) => { events[event] = fn; },
    checkPermissions: async () => ({ receive: permission }),
    requestPermissions: async () => ({ receive: permission }),
    createChannel: async () => {},
    getToken: async () => ({ token }),
    deleteToken: async () => { calls.push(["deleteToken"]); },
  };
  const controller = createNativePushController({
    sdk, platform: "android", accountKey: () => owner,
    storage: { getItem: (k) => values.get(k), setItem: (k, v) => values.set(k, v), removeItem: (k) => values.delete(k) },
    request: async (...args) => { if (fail) throw new Error("offline"); calls.push(args); },
    navigate: (path) => calls.push(["navigate", path]),
  });
  return { controller, calls, events, values,
    owner: (value) => { owner = value; }, token: (value) => { token = value; },
    permission: (value) => { permission = value; }, fail: (value) => { fail = value; } };
}

test("OS permission alone does not mean this device is subscribed", async () => {
  const d = device();
  assert.equal(await d.controller.state(), "off");
  assert.equal(d.controller.endpoint(), null);
  await d.controller.resume();
  assert.equal(d.calls.length, 0);
});

test("enable waits for account registration and permission denial never registers", async () => {
  const d = device();
  d.permission("denied");
  await assert.rejects(d.controller.enable(), /permission/);
  assert.equal(d.calls.length, 0);
  d.permission("granted");
  d.fail(true);
  await assert.rejects(d.controller.enable(), /offline/);
  assert.equal(await d.controller.state(), "off");
  d.fail(false);
  await d.controller.enable();
  assert.equal(await d.controller.state(), "on");
  assert.equal(d.controller.endpoint(), `fcm:${"a".repeat(40)}`);
});

test("rotation updates registration and removes the prior token", async () => {
  const d = device();
  await d.controller.enable();
  d.token("b".repeat(40));
  await d.controller.resume();
  assert.deepEqual(d.calls.at(-1), ["/push/unsubscribe", { endpoint: `fcm:${"a".repeat(40)}` }]);
  assert.equal(d.controller.endpoint(), `fcm:${"b".repeat(40)}`);
});

test("another account does not inherit opt-in or a test endpoint", async () => {
  const d = device();
  await d.controller.enable();
  d.owner("two@example.test");
  await d.controller.resume();
  assert.equal(await d.controller.state(), "off");
  assert.equal(d.controller.endpoint(), null);
  assert.deepEqual(d.calls.at(-1), ["deleteToken"]);
  assert.equal(d.values.size, 0);
});

test("disable cancels refresh callbacks and removes only after server revocation", async () => {
  const d = device();
  await d.controller.enable();
  d.fail(true);
  await assert.rejects(d.controller.disable(), /offline/);
  assert.equal(d.values.size, 1);
  d.fail(false);
  await d.controller.disable();
  d.events.tokenReceived({ token: "b".repeat(40) });
  await d.controller.resume();
  assert.equal(d.values.size, 0);
  assert.equal(await d.controller.state(), "off");
  assert.equal(d.calls.filter(([path]) => path === "/push/subscribe").length, 1);
});

test("notification taps only navigate to the public app's routes", () => {
  assert.equal(notificationPath("https://kickoffdraft.com/?match=123#scores"), "/?match=123#scores");
  for (const url of ["javascript:alert(1)", "https://evil.test/", "https://kickoffdraft.com.evil.test/", "https://kickoffdraft.com/other"]) {
    assert.equal(notificationPath(url), null);
  }
});

test("native provider tokens cannot become arbitrary outbound URLs", () => {
  assert.equal(nativeEndpoint("a".repeat(40)), `fcm:${"a".repeat(40)}`);
  for (const value of [null, "short", "https://evil.test/path", "a".repeat(2049)]) assert.equal(nativeEndpoint(value), null);
});

test("FCM sends visible alerts for background Android and iOS apps", () => {
  const { message } = nativeMessage("test", { title: "Goal", body: "1–0", url: "https://kickoffdraft.com/?match=1", tag: "m1-goal" });
  assert.equal(message.notification.title, "Goal");
  assert.equal(message.android.notification.channel_id, "match-alerts");
  assert.equal(message.apns.headers["apns-push-type"], "alert");
  assert.equal(message.data.url, "https://kickoffdraft.com/?match=1");
});

test("FCM authorization is signed, cached, and prunes only UNREGISTERED tokens", async () => {
  const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const pem = Buffer.from(await crypto.subtle.exportKey("pkcs8", keys.privateKey)).toString("base64");
  const env = { FCM_SERVICE_ACCOUNT: JSON.stringify({ project_id: "test-project", client_email: "test@example.test", private_key: `-----BEGIN PRIVATE KEY-----\n${pem}\n-----END PRIVATE KEY-----` }) };
  let oauthCalls = 0;
  let status = 200;
  let code = "";
  const fetcher = async (url, options) => {
    if (url === "https://oauth2.googleapis.com/token") {
      oauthCalls++;
      const [header, payload, signature] = options.body.get("assertion").split(".");
      assert.equal(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", keys.publicKey, Buffer.from(signature, "base64url"), new TextEncoder().encode(`${header}.${payload}`)), true);
      assert.equal(JSON.parse(Buffer.from(payload, "base64url")).aud, url);
      return Response.json({ access_token: "access", expires_in: 3600 });
    }
    assert.equal(url, "https://fcm.googleapis.com/v1/projects/test-project/messages:send");
    assert.equal(options.headers.Authorization, "Bearer access");
    return Response.json(status === 200 ? { name: "accepted" } : { error: { details: [{ "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode: code }] } }, { status });
  };
  const results = await Promise.all([
    sendNativePush(env, "fcm:token", { title: "Test" }, fetcher),
    sendNativePush(env, "fcm:other", { title: "Test" }, fetcher),
  ]);
  assert.deepEqual(results, [{ accepted: true, expired: false }, { accepted: true, expired: false }]);
  status = 400; code = "INVALID_ARGUMENT";
  assert.deepEqual(await sendNativePush(env, "fcm:token", { title: "Test" }, fetcher), { accepted: false, expired: false });
  status = 404; code = "UNREGISTERED";
  assert.deepEqual(await sendNativePush(env, "fcm:token", { title: "Test" }, fetcher), { accepted: false, expired: true });
  assert.equal(oauthCalls, 1);
});

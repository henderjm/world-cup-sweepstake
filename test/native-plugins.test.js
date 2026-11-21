import assert from "node:assert/strict";
import test from "node:test";
import { createNativeHost, createPluginRouter, restoreWebNetworking } from "../src/nativePlugins.js";

function topPage() {
  const removed = [];
  const plugins = {
    FirebaseMessaging: {
      getToken: async function () { return { token: "t", self: this === plugins.FirebaseMessaging }; },
      addListener: async (event) => ({ remove: async () => { removed.push(event); } }),
    },
  };
  const host = createNativeHost({ registerPlugin: name => plugins[name], isPluginAvailable: name => name in plugins });
  return { host, removed };
}

test("the top page uses its own plugins", () => {
  const router = createPluginRouter({ host: null, registerLocal: name => `local:${name}`, availableLocal: () => true });
  assert.equal(router.framed, false);
  assert.equal(router.plugin("App"), "local:App");
  assert.equal(router.available("App"), true);
});

test("a frame borrows the top page's plugins and availability", async () => {
  const { host } = topPage();
  const router = createPluginRouter({ host, registerLocal: () => assert.fail("frame must not register locally"), availableLocal: () => false });
  assert.equal(router.framed, true);
  assert.equal(router.available("FirebaseMessaging"), true);
  assert.equal(router.available("FirebaseAuthentication"), false);
  const result = await router.plugin("FirebaseMessaging").getToken();
  assert.deepEqual(result, { token: "t", self: true }, "methods stay bound to the top page's plugin");
});

test("leaving the frame removes every listener it added through the top page", async () => {
  const { host, removed } = topPage();
  const router = createPluginRouter({ host, registerLocal: () => {}, availableLocal: () => false });
  const sdk = router.plugin("FirebaseMessaging");
  await sdk.addListener("tokenReceived", () => {});
  await sdk.addListener("notificationActionPerformed", () => {});
  router.release();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(removed.sort(), ["notificationActionPerformed", "tokenReceived"]);
});

test("a frame gets the WebView's own fetch and XMLHttpRequest back", () => {
  const original = { open() {}, send() {}, abort() {}, setRequestHeader() {}, getAllResponseHeaders() {}, getResponseHeader() {} };
  const prototype = Object.fromEntries(Object.keys(original).map(key => [key, () => "patched"]));
  const webFetch = () => "web";
  const win = { fetch: () => "native", CapacitorWebFetch: webFetch, CapacitorWebXMLHttpRequest: { ...original, prototype } };
  assert.equal(restoreWebNetworking(win), true);
  assert.equal(win.fetch, webFetch);
  for (const key of Object.keys(original)) assert.equal(prototype[key], original[key]);
});

test("outside Capacitor there is nothing to restore", () => {
  const win = { fetch: () => "web" };
  const before = win.fetch;
  assert.equal(restoreWebNetworking(win), false);
  assert.equal(win.fetch, before);
});

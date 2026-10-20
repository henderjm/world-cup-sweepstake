export function notificationPath(value) {
  try {
    const url = new URL(value);
    if (url.origin !== "https://kickoffdraft.com" || url.pathname !== "/") return null;
    return `/${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

export function createNativePushController({ sdk, request, storage, accountKey, platform, navigate, received = () => {} }) {
  const key = "kd-native-push";
  let listeners;
  let queue = Promise.resolve();
  let activeOwner;
  let verifiedToken;

  function saved() {
    try { return JSON.parse(storage.getItem(key)); } catch { return null; }
  }

  function serial(action) {
    const next = queue.then(action);
    queue = next.catch(() => {});
    return next;
  }

  async function subscribe(token, owner) {
    if (!owner || activeOwner !== owner || accountKey() !== owner) return;
    const old = saved();
    await request("/push/subscribe", { subscription: { provider: "fcm", token } });
    storage.setItem(key, JSON.stringify({ owner, token }));
    verifiedToken = token;
    if (old?.owner === owner && old.token !== token) {
      await request("/push/unsubscribe", { endpoint: `fcm:${old.token}` });
    }
  }

  async function listen() {
    if (!listeners) {
      listeners = (async () => {
        await sdk.addListener("tokenReceived", ({ token }) => {
          const owner = activeOwner;
          serial(() => subscribe(token, owner)).catch(() => { verifiedToken = undefined; });
        });
        await sdk.addListener("notificationActionPerformed", ({ notification }) => {
          const path = notificationPath(notification.data?.url);
          if (path) navigate(path);
        });
        if (platform === "android") {
          await sdk.addListener("notificationReceived", ({ notification }) => received(notification));
          await sdk.createChannel({ id: "match-alerts", name: "Match alerts", importance: 4, visibility: 0 });
        }
      })();
    }
    await listeners;
  }

  return {
    async resume() {
      await listen();
      const owner = accountKey();
      if (!owner) return;
      if (saved()?.owner && saved().owner !== owner) {
        activeOwner = undefined;
        await serial(async () => {
          // An expired session cannot revoke the previous owner's database row.
          // Invalidating its FCM token prevents the next account receiving it.
          await sdk.deleteToken();
          storage.removeItem(key);
          verifiedToken = undefined;
        });
        return;
      }
      if (saved()?.owner !== owner) return;
      if ((await sdk.checkPermissions()).receive !== "granted") return;
      activeOwner = owner;
      await serial(async () => subscribe((await sdk.getToken()).token, owner));
    },
    async state() {
      const permission = (await sdk.checkPermissions()).receive;
      if (permission === "denied") return "denied";
      const current = saved();
      return permission === "granted" && current?.token && current.owner === accountKey() && current.token === verifiedToken ? "on" : "off";
    },
    async enable() {
      const owner = accountKey();
      if (!owner) throw new Error("Sign in first");
      await listen();
      if ((await sdk.requestPermissions()).receive !== "granted") throw new Error("permission denied");
      activeOwner = owner;
      await serial(async () => subscribe((await sdk.getToken()).token, owner));
    },
    async disable() {
      activeOwner = undefined;
      await serial(async () => {
        const current = saved();
        if (current?.owner === accountKey()) {
          await request("/push/unsubscribe", { endpoint: `fcm:${current.token}` });
        }
        storage.removeItem(key);
        verifiedToken = undefined;
        await sdk.deleteToken();
      });
    },
    endpoint() {
      const current = saved();
      return current?.token && current.owner === accountKey() && current.token === verifiedToken ? `fcm:${current.token}` : null;
    },
  };
}

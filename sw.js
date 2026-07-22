// Squad Goals service worker: receives Web Push events and shows them as native
// notifications. Payloads are built by the Worker cron ({ title, body, url, tag });
// clicking focuses an open Squad Goals tab (navigating it to the match) or opens one.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data?.json() ?? {};
  } catch {
    payload = { title: "Squad Goals", body: event.data?.text() ?? "" };
  }
  event.waitUntil(
    self.registration.showNotification(payload.title || "Squad Goals", {
      body: payload.body || "",
      tag: payload.tag || undefined,
      data: { url: payload.url || "" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url;
  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const existing = clientList[0];
      if (existing) {
        await existing.focus();
        if (url && "navigate" in existing) {
          try {
            await existing.navigate(url);
          } catch {
            // some platforms refuse cross-scope navigate; focus alone is fine
          }
        }
        return;
      }
      if (url) await self.clients.openWindow(url);
    })(),
  );
});

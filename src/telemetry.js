const sentryScript = document.createElement("script");
sentryScript.src = "./vendor/sentry.min.js";
sentryScript.onload = initSentry;
document.head.append(sentryScript);

function initSentry() {
  if (!window.Sentry?.init) return;
  window.Sentry.init({
    dsn: "https://1a7a3df5710a91c4eb0b649c303519a2@o4511587918479360.ingest.de.sentry.io/4511587923066960",
    tunnel: "https://goon-squad-data.gs-wc.workers.dev/tunnel",
    integrations: [window.Sentry.replayIntegration()],
    replaysSessionSampleRate: 1.0,
    replaysOnErrorSampleRate: 1.0,
    enableLogs: true,
    tracesSampleRate: 0,
  });
  try {
    window.Sentry.setUser({ id: visitorId() });
  } catch {
    // Telemetry identity is best-effort.
  }
  window.dispatchEvent(new Event("sentry-ready"));
}

function visitorId() {
  const key = "gs_uid";
  let id = null;
  try {
    id = window.localStorage.getItem(key);
  } catch {
    // Storage can be blocked.
  }
  if (!id) id = readCookie(key);
  if (!id) id = window.crypto?.randomUUID?.() ?? `u-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  try {
    window.localStorage.setItem(key, id);
  } catch {
    // Storage can be blocked.
  }
  const expires = new Date(Date.now() + 365 * 864e5).toUTCString();
  document.cookie = `${key}=${encodeURIComponent(id)}; expires=${expires}; path=/; SameSite=Lax`;
  return id;
}

function readCookie(name) {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

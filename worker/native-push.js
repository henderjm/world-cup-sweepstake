const OAUTH_URL = "https://oauth2.googleapis.com/token";
let cachedAccess;
let pendingAccess;

function base64url(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
  return btoa(String.fromCharCode(...bytes)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export function nativePushConfigured(env) {
  return Boolean(env.FCM_SERVICE_ACCOUNT);
}

export function nativeEndpoint(token) {
  return typeof token === "string" && /^[A-Za-z0-9_:\-]{20,2048}$/.test(token) ? `fcm:${token}` : null;
}

async function accessToken(secret, fetcher) {
  if (cachedAccess?.secret === secret && cachedAccess.expires > Date.now() + 60_000) return cachedAccess.token;
  if (pendingAccess?.secret === secret) return pendingAccess.promise;
  const pending = { secret, promise: requestAccessToken(secret, fetcher) };
  pendingAccess = pending;
  try {
    return await pending.promise;
  } finally {
    if (pendingAccess === pending) pendingAccess = undefined;
  }
}

async function requestAccessToken(secret, fetcher) {
  const account = JSON.parse(secret);
  if (!account.project_id || !account.client_email || !account.private_key) throw new Error("Invalid FCM configuration");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(JSON.stringify({
    iss: account.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: OAUTH_URL,
    iat: now,
    exp: now + 3600,
  }))}`;
  const keyBytes = Uint8Array.from(atob(account.private_key.replace(/-----[^-]+-----|\s/g, "")), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", keyBytes, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const response = await fetcher(OAUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${base64url(signature)}` }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("FCM authorization failed");
  const result = await response.json();
  if (!result.access_token || !Number.isFinite(result.expires_in)) throw new Error("Invalid FCM authorization response");
  cachedAccess = { secret, token: result.access_token, expires: Date.now() + result.expires_in * 1000 };
  return result.access_token;
}

export function nativeMessage(token, payload) {
  return {
    message: {
      token,
      notification: { title: payload.title, body: payload.body ?? "" },
      data: { url: payload.url ?? "", tag: payload.tag ?? "" },
      android: {
        priority: "HIGH",
        ttl: "3600s",
        notification: { channel_id: "match-alerts", icon: "ic_notification", sound: "default", tag: payload.tag ?? "" },
      },
      apns: {
        headers: { "apns-push-type": "alert", "apns-priority": "10", "apns-expiration": String(Math.floor(Date.now() / 1000) + 3600) },
        payload: { aps: { sound: "default" } },
      },
    },
  };
}

// Provider acceptance is not device delivery. Only UNREGISTERED proves that a
// token should be removed; auth, quota and payload errors must preserve it.
export async function sendNativePush(env, endpoint, payload, fetcher = fetch) {
  if (!nativePushConfigured(env)) return { accepted: false, expired: false };
  const account = JSON.parse(env.FCM_SERVICE_ACCOUNT);
  const token = await accessToken(env.FCM_SERVICE_ACCOUNT, fetcher);
  const response = await fetcher(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.project_id)}/messages:send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(nativeMessage(endpoint.slice(4), payload)),
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 401) cachedAccess = undefined;
  if (response.ok) return { accepted: true, expired: false };
  const result = await response.json().catch(() => ({}));
  return {
    accepted: false,
    expired: result.error?.details?.some((detail) => detail["@type"] === "type.googleapis.com/google.firebase.fcm.v1.FcmError" && detail.errorCode === "UNREGISTERED") ?? false,
  };
}

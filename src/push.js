import { DATA_API } from "./data.js";
import { authHeaders } from "./account.js";

// Device push: service-worker registration, the browser push subscription, and the
// Worker routes that store it. All state lives in the browser's push manager and
// the Worker's D1; nothing here touches localStorage.

// Must match the Worker's VAPID_PUBLIC_KEY (the private half is a Worker secret).
const VAPID_PUBLIC_KEY = "BOJgZCuRFEipYuiJncqnpx199Ncr570h8IeIHAoxEbFYakhhmGz8PpXbMDshAiY9o0HK8HNzW3dh_wAJvk7h-eM";

export function pushSupported() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

// "unsupported" | "denied" | "on" | "off"
export async function pushState() {
  if (!pushSupported() || !DATA_API) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  return subscription ? "on" : "off";
}

export async function enablePush() {
  const registration = await navigator.serviceWorker.register("./sw.js");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("permission " + permission);
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
  });
  const response = await fetch(`${DATA_API}/push/subscribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ subscription: subscription.toJSON() }),
  });
  if (!response.ok) {
    // The Worker rejected it (session expired, push unconfigured): undo the browser
    // side so the state stays honest.
    await subscription.unsubscribe().catch(() => {});
    throw new Error(`subscribe ${response.status}`);
  }
}

export async function disablePush() {
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return;
  await fetch(`${DATA_API}/push/unsubscribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  }).catch(() => {});
  await subscription.unsubscribe();
}

export async function sendTestPush() {
  const response = await fetch(`${DATA_API}/push/test`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!response.ok) throw new Error(`test ${response.status}`);
  return response.json();
}

function urlBase64ToUint8Array(base64url) {
  const padding = "=".repeat((4 - (base64url.length % 4)) % 4);
  const base64 = (base64url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const output = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) output[index] = raw.charCodeAt(index);
  return output;
}

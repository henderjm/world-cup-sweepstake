import { Capacitor } from "@capacitor/core";
import { isFramed, nativePlugin, pluginAvailable } from "./native.js";
import { DATA_API } from "./data.js";
import { authHeaders, currentAccount } from "./account.js";
import { createNativePushController, notificationPath } from "./nativePushController.js";

// No web implementation: the website keeps its existing VAPID subscription.
// Inside V2's iframe these are the top page's plugins (see src/nativePlugins.js).
const sdk = nativePlugin("FirebaseMessaging");
const App = nativePlugin("App");
export const nativePushAvailable = () => Capacitor.isNativePlatform() && pluginAvailable("FirebaseMessaging");
let controller;
let resumeListener;

async function showForegroundNotification(notification) {
  if (!(await App.getState()).isActive) return;
  document.getElementById("native-notification")?.remove();
  const notice = document.createElement("div");
  notice.id = "native-notification";
  notice.className = "notification-alert";
  notice.setAttribute("role", "status");
  const content = document.createElement("button");
  content.textContent = `${notification.title ?? "Kickoff Draft"}${notification.body ? ` · ${notification.body}` : ""}`;
  content.onclick = () => {
    const path = notificationPath(notification.data?.url);
    if (path) window.location.href = path;
    notice.remove();
  };
  const dismiss = document.createElement("button");
  dismiss.textContent = "Dismiss";
  dismiss.onclick = () => notice.remove();
  notice.append(content, dismiss);
  document.body.append(notice);
}

export function nativePush() {
  if (!controller) {
    controller = createNativePushController({
      sdk,
      storage: window.localStorage,
      accountKey: () => currentAccount()?.user.email,
      platform: Capacitor.getPlatform(),
      // The top page's own controller handles taps and the foreground banner;
      // a framed copy doing it too would navigate the iframe, not the app.
      navigate: isFramed ? () => {} : (path) => { window.location.href = path; },
      received: isFramed ? () => {} : (notification) => { showForegroundNotification(notification).catch(() => {}); },
      request: async (path, body) => {
        const response = await fetch(`${DATA_API}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders() },
          body: JSON.stringify(body),
        });
        if (!response.ok) throw new Error(`notification registration ${response.status}`);
      },
    });
  }
  return controller;
}

export async function resumeNativePush() {
  if (!nativePushAvailable()) return;
  if (!resumeListener) {
    resumeListener = App.addListener("appStateChange", ({ isActive }) => {
      if (isActive) nativePush().resume().catch(() => {});
    });
  }
  await nativePush().resume();
}

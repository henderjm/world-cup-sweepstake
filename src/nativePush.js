import { Capacitor, registerPlugin } from "@capacitor/core";
import { App } from "@capacitor/app";
import { DATA_API } from "./data.js";
import { authHeaders, currentAccount } from "./account.js";
import { createNativePushController, notificationPath } from "./nativePushController.js";

// No web implementation: the website keeps its existing VAPID subscription.
const sdk = registerPlugin("FirebaseMessaging");
export const nativePushAvailable = () => Capacitor.isNativePlatform() && Capacitor.isPluginAvailable("FirebaseMessaging");
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
      navigate: (path) => { window.location.href = path; },
      received: (notification) => { showForegroundNotification(notification).catch(() => {}); },
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

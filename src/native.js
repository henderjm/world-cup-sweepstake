import { Capacitor } from "@capacitor/core";
import { App } from "@capacitor/app";

export const isNative = Capacitor.isNativePlatform();

export function shareBaseUrl() {
  return isNative ? "https://kickoffdraft.com/" : `${window.location.origin}${window.location.pathname}`;
}

export async function setupNative() {
  if (!isNative) return;
  document.documentElement.classList.add("native-app");
  const { resumeNativePush } = await import("./nativePush.js");
  await resumeNativePush().catch(() => {});
  if (Capacitor.getPlatform() === "android") {
    await App.addListener("backButton", ({ canGoBack }) => {
      const close = document.querySelector(".dz:not([hidden]) .dz__close");
      if (close) close.click();
      else if (canGoBack) window.history.back();
      else App.minimizeApp();
    });
  }
}

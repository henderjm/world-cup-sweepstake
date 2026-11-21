import { Capacitor, registerPlugin } from "@capacitor/core";
import { App } from "@capacitor/app";
import { isEmbedded } from "./appVersion.js";
import { NATIVE_HOST_KEY, createNativeHost, createPluginRouter, restoreWebNetworking } from "./nativePlugins.js";

export const isNative = Capacitor.isNativePlatform();

// True inside V2's iframe (Fantasy, Play, You): the top page owns notification
// taps, the foreground banner and the Android back button.
export const isFramed = isNative && isEmbedded();
if (isFramed) restoreWebNetworking(window);

if (isNative && !isFramed) {
  window[NATIVE_HOST_KEY] = createNativeHost({ registerPlugin, isPluginAvailable: name => Capacitor.isPluginAvailable(name) });
}

function parentHost() {
  try {
    return window.parent !== window ? window.parent[NATIVE_HOST_KEY] ?? null : null;
  } catch {
    return null;
  }
}

const router = createPluginRouter({
  host: isFramed ? parentHost() : null,
  registerLocal: registerPlugin,
  availableLocal: name => Capacitor.isPluginAvailable(name),
});
if (router.framed) addEventListener("pagehide", () => router.release());

export const nativePlugin = name => router.plugin(name);
export const pluginAvailable = name => router.available(name);

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

import { readFile, access } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const config = JSON.parse(await readFile(new URL("capacitor.config.json", root), "utf8"));
for (const [platform, file] of [["android", "android/app/google-services.json"], ["ios", "ios/App/App/GoogleService-Info.plist"]]) {
  const plugins = config[platform]?.includePlugins ?? config.includePlugins ?? [];
  if (!plugins.some((name) => name.startsWith("@capacitor-firebase/"))) {
    console.log(`${platform}: Firebase is disabled; this preview cannot receive native notifications.`);
    continue;
  }
  try {
    await access(new URL(file, root));
  } catch {
    throw new Error(`${platform}: add ${file} before enabling Firebase. See docs/mobile.md.`);
  }
  if (platform === "android") {
    const google = JSON.parse(await readFile(new URL(file, root), "utf8"));
    const client = google.client?.find((client) => client.client_info?.android_client_info?.package_name === config.appId);
    if (!client) {
      throw new Error("google-services.json belongs to a different Android application.");
    }
    if (plugins.includes("@capacitor-firebase/authentication") &&
        !client.oauth_client?.some((oauth) => oauth.client_type === 3 && oauth.client_id)) {
      throw new Error("Android Google sign-in has no web OAuth client. Enable Google sign-in in Firebase, register the signing fingerprint, and download google-services.json again.");
    }
  }
}

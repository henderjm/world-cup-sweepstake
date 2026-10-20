import { mkdir, copyFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const target = process.argv[2];
if (!["android", "ios-simulator"].includes(target)) {
  throw new Error("Choose android or ios-simulator.");
}
await mkdir(`${root}mobile-builds`, { recursive: true });

const command = target === "android" ? "./gradlew" : "xcodebuild";
const args = target === "android"
  ? ["--no-daemon", "assembleDebug"]
  : ["-project", "ios/App/App.xcodeproj", "-scheme", "App", "-configuration", "Debug",
    "-sdk", "iphonesimulator", "-destination", "generic/platform=iOS Simulator",
    "-derivedDataPath", "mobile-builds/ios-simulator", "CODE_SIGNING_ALLOWED=NO", "build"];
const result = spawnSync(command, args, {
  cwd: target === "android" ? `${root}android` : root,
  stdio: "inherit",
  env: process.env,
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
if (target === "android") {
  await copyFile(`${root}android/app/build/outputs/apk/debug/app-debug.apk`, `${root}mobile-builds/kickoff-draft-debug.apk`);
  console.log("Shareable test APK: mobile-builds/kickoff-draft-debug.apk");
} else {
  console.log("Simulator only: mobile-builds/ios-simulator/Build/Products/Debug-iphonesimulator/App.app");
}

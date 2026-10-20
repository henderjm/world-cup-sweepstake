# Kickoff Draft mobile builds

The Android and iOS Capacitor projects package the same Svelte app and bundled
fallback data as the website. App ID: `com.kickoffdraft.app`. Live HTTP requests
use Capacitor's native transport; no hosted website URL or broad navigation
allowlist is enabled. The website continues to use browser networking.

## Notification status

Android includes the native Firebase messaging and Google sign-in plugins. Its
local, ignored configuration belongs to Firebase project `kickoffdraft` and app
`com.kickoffdraft.app`; the debug signing fingerprints are registered. The Worker
still needs its sending credential and the updated Android sign-in audience
deployed, followed by physical-device verification.

iOS includes only the Capacitor App plugin until its Firebase configuration and
Apple signing setup are supplied. Enabling Firebase plugins without those files
can crash during native startup. That preview reports sign-in and notifications
as unconfigured.

Configured builds use Firebase Cloud Messaging on Android and iOS (Firebase
forwards iOS alerts through APNs). The existing Worker and its account, followed
club, event preference and league membership checks select recipients. Native
subscriptions use `fcm:<token>` in the existing subscription table with empty
Web Push key fields, so no database migration is needed. Browser subscriptions
continue using VAPID. Native token refresh updates the account registration;
sign-out first detaches that device, and fails visibly if detachment cannot be
completed. Notification taps only open routes on Kickoff Draft. Android shows an
in-app banner in the foreground; iOS uses its native presentation options.

A successful provider response is **acceptance, not proof of delivery**. New
"Send test" requests select the current account's current device. The UI asks you
to check the actual alert; older browser builds can still test all their own
devices. Test the steps below before distributing a notification-enabled build.

## Configure native notifications

Firebase Cloud Messaging has a [no-cost tier](https://firebase.google.com/pricing).
iOS push still requires your Apple Developer signing and APNs configuration.
No accounts, paid plans, production secrets or deployments were created here.

1. Create a Firebase project, preferably using the Google Cloud project behind
   the existing web Google client. Register Android and iOS apps with ID
   `com.kickoffdraft.app`.
2. Enable Google sign-in. For Android, register the SHA-1/SHA-256 fingerprints of
   the APK signing certificate (and the Play signing certificate if applicable).
   Download `google-services.json` to `android/app/google-services.json`. Set its web
   OAuth client (`client_type: 3`) as `GOOGLE_ANDROID_WEB_CLIENT_ID` in
   `worker/wrangler.toml`. Keep the existing website's `GOOGLE_CLIENT_ID` and
   authorized web origins unchanged when Firebase uses a separate project.
3. Download `GoogleService-Info.plist` to `ios/App/App/GoogleService-Info.plist`.
   Add it to the App target in Xcode, including Copy Bundle Resources. Add its
   `REVERSED_CLIENT_ID` under App → Info → URL Types. Set `GOOGLE_IOS_CLIENT_ID`
   in `worker/wrangler.toml` to its `CLIENT_ID`; the backend only accepts those
   explicitly configured Google audiences.
4. Enable Push Notifications for the Apple app identifier and App target. Select
   your Apple team and regenerate the provisioning profile with push enabled.
   `App.entitlements` uses development APNs for Debug and production for Release.
   Upload your APNs authentication key and team/key IDs in Firebase's Cloud
   Messaging settings for the iOS app. Keep Firebase delegate swizzling enabled.
5. For each configured platform, append `@capacitor-firebase/authentication` and
   `@capacitor-firebase/messaging` to its `includePlugins` array in
   `capacitor.config.json`. Run `npm run mobile:sync`. The build checks reject
   missing Firebase files and Android configurations for a different package.
   iOS SPM Google-only traits and Android Google provider support are configured.
6. Enable the FCM HTTP v1 API for that Firebase project. Create a service account
   authorized to send FCM messages for it. Store its JSON as the Cloudflare Worker
   secret `FCM_SERVICE_ACCOUNT`, using `wrangler secret put` from `worker/`.
   Never put the private key in a `VITE_` variable, native app resources or Git.
7. Deploy the Worker changes before updating clients. The native transport,
   explicit native origins and optional iOS Google audience are not live until
   deployment. Rebuild/sign/install the mobile apps after adding configuration.

## Verify delivery on actual devices

On an Android phone and a signed physical iPhone build, independently:

1. Sign in, follow a club, enable the desired event preferences and tap Enable
   on this device. Reject permission first and confirm no registration is shown;
   then grant it through device settings and enable again.
2. Tap Send test while foregrounded, then repeat with the app backgrounded and
   the screen locked. Actually observe the alert on the intended phone. Verify
   the title/body and that tapping it opens the correct app route.
3. Trigger an authorized test from another session while the app is closed;
   verify OS delivery without relying on an open WebView. Android force-stop is
   different from normal app dismissal and can prevent delivery until reopened.
4. Reopen the app and verify token registration is refreshed. Disable and confirm
   this device no longer receives alerts. Sign out and confirm its subscription
   was removed; a different account must explicitly opt in again.
5. Check a real followed-club event and an applicable league alert, including
   disabled preferences. Repeat the website's Web Push test to catch regressions.

Local tests cover permission denial, failed registration, rotation, revocation,
account isolation, targeted test requests, safe notification routes, FCM JWT
signing/cache, visible payloads and pruning only unregistered tokens. They do not
substitute for Firebase/APNs acceptance and observation on real phones.

## Build locally

Use Node 22.21+ (24 recommended). Android requires Java 21, Android SDK platform
36 and build tools; set `JAVA_HOME` and `ANDROID_HOME` to their installations.
iOS requires macOS and Xcode 26+ with the iOS platform installed. If command-line
tools are selected globally, set
`DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` for the build.

```sh
npm ci
npm run mobile:apk
npm run mobile:ios:simulator
```

The APK is `mobile-builds/kickoff-draft-debug.apk`. Share it directly for Android
testing; the recipient must allow installation from their download source. It
uses a local debug signing key, not a production signing identity. Builds from
different computers or CI runs may require uninstalling the old preview first,
which clears its local data. Use a persistent release keystore for real releases.

The iOS output is `mobile-builds/ios-simulator/Build/Products/Debug-iphonesimulator/App.app`.
It runs in the iOS Simulator on a Mac, **not on an iPhone**.

`npm run mobile:sync` rebuilds and copies web assets before native development.
Use `npm run mobile:android` or `npm run mobile:ios` to open the native project.
Commit native source/configuration; generated web assets, build output and signing
secrets are ignored. The manually triggered **Mobile preview builds** workflow
produces an APK and a zipped simulator app, with no store upload or deployment.

## Share on iPhone

An unsigned ZIP renamed to `.ipa` is not installable. To create a distributable
build, use your Apple Developer team and signing/provisioning configuration:

1. Run `npm run mobile:ios` and select the App target in Xcode.
2. Under Signing & Capabilities, select your team and confirm the bundle ID.
3. Choose a generic iOS device, then Product → Archive.
4. In Organizer, choose Distribute App → TestFlight & App Store for TestFlight,
   or the registered-device distribution option for an exported `.ipa`.
5. For registered-device distribution, include each recipient's device in the
   provisioning profile. For TestFlight, finish the upload and tester setup in
   App Store Connect; external testing may require Apple's beta review.

See [Apple distribution guidance](https://developer.apple.com/documentation/xcode/distributing-your-app-for-beta-testing-and-releases)
and [Capacitor prerequisites](https://capacitorjs.com/docs/getting-started/environment-setup).

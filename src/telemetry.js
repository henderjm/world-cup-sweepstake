import posthog from "posthog-js";

// import.meta.env only exists under Vite; the node:test suite loads these
// modules directly through plain Node, where it is undefined rather than {}.
const env = import.meta.env ?? {};
const POSTHOG_KEY = env.VITE_POSTHOG_KEY;
const POSTHOG_HOST = env.VITE_POSTHOG_HOST;

if (POSTHOG_KEY && POSTHOG_HOST) {
  posthog.init(POSTHOG_KEY, {
    api_host: POSTHOG_HOST,
    defaults: "2026-05-30",
  });
} else if (env.DEV) {
  console.error(
    "VITE_POSTHOG_KEY and VITE_POSTHOG_HOST variables required by PostHog are missing or un-configured, this causes events to be silently missed. This error stops appearing once VITE_POSTHOG_KEY and VITE_POSTHOG_HOST are configured",
  );
}

// Every analytics call in the app goes through one of the four wrappers below,
// and none of them can throw. This is not defensive decoration: PostHog is a
// third-party script talking to a third-party host, and it is blocked outright
// for a large share of real users by tracker blockers, network policy and
// privacy browsers. Analytics is the least important thing this app does, so a
// blocked, failed or half-initialised provider must degrade to "no data" and
// never to a broken draft room.
//
// The properties are built by the caller, usually from src/funnelEvents.js, so
// a builder reaching into half-initialised state and throwing is caught here
// too. That is why the builder call belongs INSIDE the try at the call site or
// as an argument to these functions, never assigned to a variable beforehand.
//
// Wrapping centrally rather than at each call site is the point: the previous
// arrangement wrapped only the metric()/log() helpers in app.js, so the fifteen
// direct posthog.capture() calls scattered through app.js, account.js and
// banter.js were each an unguarded third-party call on a user interaction path.

export function track(event, properties) {
  try {
    posthog.capture(event, properties);
  } catch {
    /* analytics must never break the app */
  }
}

export function trackException(error) {
  try {
    posthog.captureException(error);
  } catch {
    /* analytics must never break the app */
  }
}

export function identifyUser(distinctId, properties) {
  try {
    posthog.identify(distinctId, properties);
  } catch {
    /* analytics must never break the app */
  }
}

export function resetIdentity() {
  try {
    posthog.reset();
  } catch {
    /* analytics must never break the app */
  }
}

export { posthog };

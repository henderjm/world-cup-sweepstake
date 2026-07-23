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

export { posthog };

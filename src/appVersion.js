// Which app a visitor sees. V1 is production; V2 is the opt-in rebuild that
// runs beside it (docs/release-plan-matchday-2.md). `?v=2` or `?v=1` in the
// URL sets the choice, the in-app switch sets it too, and it is remembered per
// device. Storage that throws (private mode, blocked site data) just means V1.

const KEY = "kd-app-version";
export const VERSIONS = ["1", "2"];

export function chosenVersion(search = globalThis.location?.search ?? "", storage = safeStorage()) {
  if (isEmbedded(search)) return "1";
  const requested = new URLSearchParams(search).get("v");
  if (VERSIONS.includes(requested)) {
    try { storage?.setItem(KEY, requested); } catch { /* remembered for this load only */ }
    return requested;
  }
  try {
    const stored = storage?.getItem(KEY);
    if (VERSIONS.includes(stored)) return stored;
  } catch { /* fall through to V1 */ }
  return "1";
}

// V2 phase 1 shows the V1 Fantasy, Play and You screens inside its own shell
// by framing V1 with `?embed=1`. An embedded load is always V1, never touches
// the remembered choice, and hides V1's own navigation (see src/main.js).
export function isEmbedded(search = globalThis.location?.search ?? "") {
  return new URLSearchParams(search).get("embed") === "1";
}

// Switching reloads rather than hot-swapping: V1 wires global listeners and
// timers at boot, and a clean load is the only way to be sure none survive.
export function switchVersion(version, hash = "") {
  if (!VERSIONS.includes(version)) return;
  const url = new URL(globalThis.location.href);
  url.searchParams.set("v", version);
  url.hash = hash;
  globalThis.location.assign(url.toString());
}

function safeStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

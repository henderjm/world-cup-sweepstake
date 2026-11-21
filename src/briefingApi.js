// Home briefing client: GET /briefing and POST /briefing/seen, on the same
// bearer session as every other account route. Pure transport; what the
// briefing means lives in src/briefing.js.

import { authHeaders } from "./account.js";
import { DATA_API } from "./data.js";

export async function loadBriefing(signal) {
  if (!DATA_API) return null;
  const response = await fetch(`${DATA_API}/briefing`, {
    headers: authHeaders(),
    cache: "no-store",
    signal: signal ?? AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`briefing ${response.status}`);
  return response.json();
}

// keepalive so a "seen" sent while the tab is being hidden or closed still
// lands. A failure only means the same news shows again next visit.
export function markBriefingSeen() {
  if (!DATA_API) return;
  fetch(`${DATA_API}/briefing/seen`, { method: "POST", headers: authHeaders(), keepalive: true }).catch(() => {});
}

// Shared football-data.org fetch helper for Node scripts (the Worker has its own
// edge-caching fetchJson in worker/worker.js since Cloudflare's cf.cacheTtl option
// doesn't apply here). Retries a 429 by honouring Retry-After / "wait N seconds",
// so a script's request budget survives a busy window instead of dropping data.

const MAX_RATELIMIT_RETRIES = 4;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function fetchFootballData(path, token, attempt = 0) {
  const response = await fetch(`https://api.football-data.org${path}`, {
    headers: { "X-Auth-Token": token },
  });

  if (response.status === 429 && attempt < MAX_RATELIMIT_RETRIES) {
    const waitMs = retryAfterMs(response, await response.text());
    console.log(`rate limited on ${path}; waiting ${Math.round(waitMs / 1000)}s then retrying`);
    await sleep(waitMs);
    return fetchFootballData(path, token, attempt + 1);
  }

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
  }

  return response.json();
}

// How long to wait before retrying a 429, from the Retry-After header if present, else
// the "Wait N seconds" the body carries, else a full one-minute window. Padded by a
// second so we resume just after the window resets rather than on its edge.
function retryAfterMs(response, body) {
  const header = Number(response.headers.get("Retry-After"));
  if (Number.isFinite(header) && header > 0) return (header + 1) * 1000;
  const match = /wait\s+(\d+)\s*second/i.exec(body ?? "");
  if (match) return (Number(match[1]) + 1) * 1000;
  return 61_000;
}

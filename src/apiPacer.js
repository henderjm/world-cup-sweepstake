// Cache hits never enter this queue. Overloaded origin reads must reach their
// stale-data fallback before a browser gives up waiting for the response.
export function createUpstreamPacer({
  gapMs = 200,
  maxWaitMs = 1000,
  now = () => performance.now(),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  let tail = Promise.resolve();
  let lastStart = -Infinity;
  return () => {
    const requestedAt = now();
    const turn = tail.then(async () => {
      const wait = Math.max(0, lastStart + gapMs - now());
      if (now() - requestedAt + wait > maxWaitMs) throw new Error('Upstream queue deadline exceeded');
      if (wait > 0) await sleep(wait);
      if (now() - requestedAt > maxWaitMs) throw new Error('Upstream queue deadline exceeded');
      lastStart = now();
      return lastStart - requestedAt;
    });
    tail = turn.catch(() => {});
    return turn;
  };
}

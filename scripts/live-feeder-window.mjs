import { pathToFileURL } from 'node:url';

// Keep late fixtures discoverable across UTC midnight, including cold job starts.
export function fixtureDates(now) {
  const date = new Date(now);
  const today = date.toISOString().slice(0, 10);
  return date.getUTCHours() < 3
    ? [new Date(now - 86400000).toISOString().slice(0, 10), today]
    : [today];
}

export function shouldRearm(now, followUpNeeded) {
  const hour = new Date(now).getUTCHours();
  if (hour >= 11 && hour < 22) return true;
  // Bound retries for a stuck live status or a prolonged provider outage.
  return (hour >= 22 || hour < 3) && followUpNeeded;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = shouldRearm(Date.now(), process.env.FEEDER_FOLLOW_UP === 'true') ? 0 : 1;
}

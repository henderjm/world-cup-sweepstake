import { nextSnapshot } from "../../services/scores/snapshots.mjs";

// Single-process replay only. The production adapter needs atomic lease/version
// conditions in shared durable storage; this cannot coordinate separate hosts.
export class ScoreReplayStore {
  #lease = null;
  #epoch = 0;
  #snapshots = new Map();

  claim(owner, now, ttl = 30000) {
    if (typeof owner !== "string" || !owner || !Number.isSafeInteger(ttl) || ttl < 1000 || ttl > 60000)
      throw Error("Invalid collector lease");
    if (this.#lease?.expiresAt > now && this.#lease.owner !== owner) return null;
    if (!this.#lease || this.#lease.expiresAt <= now) this.#epoch++;
    this.#lease = { owner, epoch: this.#epoch, expiresAt: now + ttl };
    return { ...this.#lease };
  }

  publish(lease, input, now) {
    if (!lease || lease.owner !== this.#lease?.owner || lease.epoch !== this.#lease.epoch
      || now >= lease.expiresAt || now >= this.#lease.expiresAt) throw Error("Collector lease expired");
    const key = `${input.competition}:${input.season}`;
    const next = nextSnapshot(this.#snapshots.get(key), input, { epoch: lease.epoch, now });
    this.#snapshots.set(key, next);
    return next.version;
  }

  read(competition, season) {
    return structuredClone(this.#snapshots.get(`${competition}:${season}`) ?? null);
  }
}

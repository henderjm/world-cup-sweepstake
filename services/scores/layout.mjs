import { createHash } from "node:crypto";
import { isLive } from "../../src/format.js";
import { TERMINAL_MATCH_STATUSES } from "../../src/mapApiFootball.js";

export const MAX_PART_BYTES = 256 * 1024;
export const digest = text => createHash("sha256").update(text).digest("base64url");
const validPart = name => /^(H[0-7]|C([0-9]|1[0-5])|T)$/.test(name);

export function snapshotLayout(snapshot) {
  const { fixtures, standings, ...metadata } = snapshot;
  const groups = { T: standings };
  for (const row of [...fixtures].sort((a, b) => a.match.id - b.match.id)) {
    const hot = isLive(row.match.status) || (!TERMINAL_MATCH_STATUSES.has(row.match.status)
      && Date.parse(row.match.utcDate) <= snapshot.publishedAt + 2 * 3600000);
    const part = `${hot ? "H" : "C"}${row.match.id % (hot ? 8 : 16)}`;
    (groups[part] ??= []).push(row);
  }
  const parts = Object.fromEntries(Object.entries(groups).map(([name, value]) => {
    const data = JSON.stringify(value);
    if (Buffer.byteLength(data) > MAX_PART_BYTES) throw Error("Score partition exceeds storage limit");
    return [name, { data, digest: digest(data) }];
  }));
  const manifest = { ...metadata, layout: 1, parts: Object.fromEntries(Object.entries(parts).map(([name, part]) => [name, part.digest])) };
  if (Buffer.byteLength(JSON.stringify(manifest)) > 4096) throw Error("Score manifest exceeds storage limit");
  return { manifest, parts };
}

export function validateManifest(manifest, competition, season, version) {
  if (manifest.layout !== 1 || manifest.competition !== competition || manifest.season !== String(season)
    || !Number.isSafeInteger(manifest.version) || manifest.version < 1 || manifest.version !== version
    || !manifest.parts || typeof manifest.parts.T !== "string" || Object.keys(manifest.parts).length > 25
    || Object.entries(manifest.parts).some(([name, hash]) => !validPart(name) || !/^[A-Za-z0-9_-]{43}$/.test(hash)))
    throw Error("Invalid score manifest");
}

export function assembleSnapshot(manifest, parts) {
  const { layout, parts: references, ...metadata } = manifest;
  const fixtures = Object.entries(parts).filter(([name]) => name !== "T").flatMap(([, data]) => JSON.parse(data));
  fixtures.sort((a, b) => a.match.id - b.match.id);
  return { ...metadata, fixtures, standings: JSON.parse(parts.T) };
}

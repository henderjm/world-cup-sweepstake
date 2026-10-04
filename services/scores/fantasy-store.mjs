import { COMPETITIONS } from '../../src/competitions.js';
import { digest, MAX_PART_BYTES } from './layout.mjs';

const positive = value => Number.isSafeInteger(value) && value > 0;
const hash = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const CHUNK_BYTES = 128 * 1024;
const MAX_BYTES = 2 * 1024 * 1024;

export function fantasyKey(competition, season, kind) {
  if (!Object.hasOwn(COMPETITIONS, competition) || !/^\d{4}$/.test(String(season)) || !['squads', 'history'].includes(kind))
    throw Error('Invalid fantasy dataset identity');
  return `FANTASY#${competition}#${season}#${kind}`;
}

export function validateFantasyManifest(manifest, competition, season, kind, version) {
  fantasyKey(competition, season, kind);
  if (!manifest || manifest.layout !== 1 || manifest.competition !== competition || manifest.season !== String(season)
    || manifest.kind !== kind || !positive(manifest.version) || manifest.version !== version
    || !positive(manifest.collectorEpoch) || !positive(manifest.observedAt) || !positive(manifest.publishedAt)
    || manifest.observedAt > manifest.publishedAt || !positive(manifest.bytes) || manifest.bytes > MAX_BYTES
    || !hash(manifest.digest) || !Array.isArray(manifest.parts) || manifest.parts.length !== Math.ceil(manifest.bytes / CHUNK_BYTES)
    || manifest.parts.some(part => !hash(part)) || Buffer.byteLength(JSON.stringify(manifest)) > 4096)
    throw Error('Invalid fantasy dataset manifest');
  return manifest;
}

export function fantasyPublication(previous, input, lease, now) {
  const { competition, season, kind, baseVersion, observedAt, data } = input;
  fantasyKey(competition, season, kind);
  if (previous) validateFantasyManifest(previous, competition, season, kind, previous.version);
  if (!Number.isSafeInteger(baseVersion) || baseVersion < 0 || baseVersion !== (previous?.version ?? 0))
    throw Error('Fantasy dataset version conflict');
  if (!positive(observedAt) || observedAt > now || observedAt < (previous?.observedAt ?? 0)
    || !data || typeof data !== 'object' || Array.isArray(data)) throw Error('Invalid fantasy dataset observation');
  const bytes = Buffer.from(JSON.stringify(data));
  if (bytes.length > MAX_BYTES) throw Error('Fantasy dataset exceeds storage limit');
  // Bound the whole transaction below 4 MiB, including base64 and item overhead.
  // Byte chunks preserve Unicode even when a character crosses a part boundary.
  const parts = [];
  for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
    const data = bytes.subarray(offset, offset + CHUNK_BYTES).toString('base64');
    if (Buffer.byteLength(data) > MAX_PART_BYTES) throw Error('Fantasy partition exceeds storage limit');
    parts.push({ data, digest: digest(data) });
  }
  const manifest = { layout: 1, competition, season: String(season), kind, version: baseVersion + 1,
    collectorEpoch: lease.epoch, observedAt, publishedAt: now, bytes: bytes.length, digest: digest(bytes),
    parts: parts.map(part => part.digest) };
  validateFantasyManifest(manifest, competition, season, kind, manifest.version);
  return { manifest, parts };
}

export function assembleFantasy(manifest, parts) {
  const bytes = Buffer.concat(parts.map(part => Buffer.from(part, 'base64')));
  if (bytes.length !== manifest.bytes || digest(bytes) !== manifest.digest) throw Error('Invalid fantasy dataset content');
  const data = JSON.parse(bytes.toString('utf8'));
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error('Invalid fantasy dataset content');
  return { ...manifest, data };
}

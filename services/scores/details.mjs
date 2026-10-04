import { COMPETITIONS } from "../../src/competitions.js";
import { matchDetailCacheProfile } from "../../src/matchDetailCache.js";
import { digest, MAX_PART_BYTES } from "./layout.mjs";

export const DETAIL_SECTIONS = Object.freeze(["fixture", "lineups", "events", "players"]);
const positive = value => Number.isSafeInteger(value) && value > 0;
const hash = value => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);

export function detailKey(competition, season, id) {
  if (!Object.hasOwn(COMPETITIONS, competition) || !/^\d{4}$/.test(String(season)) || !positive(id))
    throw Error("Invalid detail identity");
  return `DETAIL#${competition}#${season}#${id}`;
}

// A final score correction requires another complete detail pass, whereas a
// discovery refresh with the same result must not invalidate settled detail.
export function detailSubject(match) {
  if (!positive(match?.id) || typeof match.status !== "string" || !Number.isFinite(Date.parse(match.utcDate)))
    throw Error("Invalid detail subject");
  return digest(JSON.stringify([match.id, match.utcDate, match.status, match.score?.home ?? null,
    match.score?.away ?? null, match.penalties?.home ?? null, match.penalties?.away ?? null, match.homeTeam, match.awayTeam]));
}

export function validateDetailManifest(manifest, competition, season, id, version) {
  detailKey(competition, season, id);
  if (!manifest || manifest.layout !== 1 || manifest.competition !== competition || manifest.season !== String(season)
    || manifest.id !== id || !positive(manifest.version) || manifest.version !== version
    || !positive(manifest.collectorEpoch) || !positive(manifest.publishedAt)
    || !manifest.sections || Array.isArray(manifest.sections) || typeof manifest.sections !== "object"
    || !Object.keys(manifest.sections).length || Object.keys(manifest.sections).length > DETAIL_SECTIONS.length
    || Object.entries(manifest.sections).some(([name, section]) => !DETAIL_SECTIONS.includes(name) || !section
      || !hash(section.digest) || !hash(section.subject) || !positive(section.observedAt)
      || section.observedAt > manifest.publishedAt || !["complete", "partial", "unpublished"].includes(section.coverage))
    || Buffer.byteLength(JSON.stringify(manifest)) > 4096) throw Error("Invalid detail manifest");
  return manifest;
}

export function detailPublication(previous, input, lease, now) {
  const { competition, season, id, section, observedAt, subject, coverage, payload, baseVersion } = input;
  detailKey(competition, season, id);
  if (previous) validateDetailManifest(previous, competition, season, id, previous.version);
  if (!Number.isSafeInteger(baseVersion) || baseVersion < 0 || baseVersion !== (previous?.version ?? 0))
    throw Error("Detail version conflict");
  if (!DETAIL_SECTIONS.includes(section) || !positive(observedAt) || observedAt > now
    || observedAt < (previous?.sections[section]?.observedAt ?? 0)
    || !hash(subject) || !["complete", "partial", "unpublished"].includes(coverage)
    || !payload || !Array.isArray(payload.response)) throw Error("Invalid detail observation");
  const data = JSON.stringify(payload);
  if (Buffer.byteLength(data) > MAX_PART_BYTES) throw Error("Detail section exceeds storage limit");
  const part = { data, digest: digest(data) };
  const manifest = { layout: 1, competition, season: String(season), id, version: baseVersion + 1,
    collectorEpoch: lease.epoch, publishedAt: now, sections: { ...previous?.sections,
      [section]: { digest: part.digest, observedAt, subject, coverage } } };
  validateDetailManifest(manifest, competition, season, id, manifest.version);
  return { manifest, part };
}

export function detailCoverage(manifest, match, now) {
  const profile = matchDetailCacheProfile(match, now), subject = detailSubject(match);
  const terminal = ["FINISHED", "AWARDED"].includes(match.status);
  return Object.fromEntries(DETAIL_SECTIONS.map(name => {
    const section = manifest?.sections[name];
    const ageMs = section ? Math.max(0, now - section.observedAt) : null;
    const state = !section ? "missing" : section.observedAt > now ? "invalid"
      : terminal && section.subject !== subject ? "outdated-result"
        : ageMs >= profile[name] * 1000 ? "stale" : section.coverage;
    return [name, { state, observedAt: section?.observedAt ?? null, ageMs }];
  }));
}

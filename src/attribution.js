// First-touch acquisition attribution for the sign-in funnel. Pure: no DOM, no
// storage, no posthog import, shared by the browser (src/account.js) and the
// Worker (handleGoogleAuth), so the two clean a value the same way.
//
// WHY THIS EXISTS. Every number that steers the business comes out of D1
// (scripts/metrics/), and until this module a `users` row said nothing about
// where the person came from. "Cost per sign-up from Reddit" and "did the
// Learn pages bring anyone" were unanswerable, which is the question the
// marketing budget (docs/funding-plan.md) is spent on. PostHog captures UTM
// parameters on its own, but it is a separate account the metrics do not read.
//
// HOW IT WORKS. The browser derives ONE attribution record on boot from the
// URL's utm_* parameters, else the invite-link route, else the referrer, else
// "direct", and keeps it in localStorage until a sign-in consumes it. The
// Worker writes it onto the users row at INSERT only; the ON CONFLICT branch
// never touches it, so a returning manager cannot have their origin rewritten
// by a later visit. NULL on an existing row means "signed up before this
// existed", the same discipline as fantasy_draft_picks.via: never backfilled.
//
// FIRST TOUCH WINS, with two exceptions that keep it honest: a stored record
// older than ATTRIBUTION_TTL_MS is replaced (somebody who glanced at the site
// in August and signed up off a January ad belongs to the ad), and a stored
// "direct" is replaced by anything that is not direct (direct carries no
// information, so a later referrer is strictly more). An invite link is a
// source of its own ("invite") and the code itself is NEVER stored: it is the
// join credential (see the NO PERSONAL DATA rule in src/funnelEvents.js).
//
// Every value is lowercased, reduced to [a-z0-9._-] and capped, on both sides:
// utm parameters and referrers are attacker-controlled strings that end up in
// a GROUP BY, and a 10 KB "campaign" is not a campaign.

export const ATTRIBUTION_KEY = "gs-attribution";
export const ATTRIBUTION_TTL_MS = 30 * 864e5;
export const ATTRIBUTION_VALUE_MAX = 64;
export const DIRECT_SOURCE = "direct";
export const INVITE_SOURCE = "invite";
export const LEARN_SOURCE = "learn";

// Referrer hosts worth naming. Anything else keeps its (cleaned) host, so an
// unexpected source is visible rather than folded into "other".
const KNOWN_REFERRERS = [
  [/(^|\.)google\.[a-z.]+$/, "google", "organic"],
  [/(^|\.)bing\.com$/, "bing", "organic"],
  [/(^|\.)duckduckgo\.com$/, "duckduckgo", "organic"],
  [/(^|\.)(reddit\.com|redd\.it)$/, "reddit", "social"],
  [/(^|\.)(twitter\.com|x\.com|t\.co)$/, "x", "social"],
  [/(^|\.)(facebook\.com|fb\.com|fb\.me)$/, "facebook", "social"],
  [/(^|\.)instagram\.com$/, "instagram", "social"],
  [/(^|\.)tiktok\.com$/, "tiktok", "social"],
  [/(^|\.)whatsapp\.com$/, "whatsapp", "social"],
  [/(^|\.)linkedin\.com$/, "linkedin", "social"],
  [/(^|\.)(youtube\.com|youtu\.be)$/, "youtube", "social"],
  [/(^|\.)producthunt\.com$/, "producthunt", "referral"],
  [/(^|\.)github\.com$/, "github", "referral"],
];

export function cleanAttributionValue(value) {
  if (value == null) return null;
  const cleaned = String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, ATTRIBUTION_VALUE_MAX);
  return cleaned || null;
}

function hashHead(hash) {
  return String(hash ?? "")
    .replace(/^#/, "")
    .split(/[/?]/)[0];
}

function referrerParts(referrer) {
  if (!referrer) return null;
  try {
    const url = new URL(String(referrer));
    return { host: url.hostname.toLowerCase().replace(/^www\./, ""), pathname: url.pathname };
  } catch {
    return null;
  }
}

function fromReferrer(referrer, ownHost) {
  const parts = referrerParts(referrer);
  if (!parts?.host) return null;
  const own = String(ownHost ?? "").toLowerCase().replace(/^www\./, "");
  if (own && parts.host === own) {
    // The pre-rendered Learn pages load no app code (CLAUDE.md, SEO section),
    // so a search visitor who read one and then opened the app arrives with
    // our own host as the referrer. That is the only same-host path worth
    // naming; everything else same-host is just navigation.
    return parts.pathname.startsWith("/learn") ? { source: LEARN_SOURCE, medium: "referral" } : null;
  }
  for (const [pattern, source, medium] of KNOWN_REFERRERS) {
    if (pattern.test(parts.host)) return { source, medium };
  }
  const host = cleanAttributionValue(parts.host);
  return host ? { source: host, medium: "referral" } : null;
}

// `search` is location.search, `hash` is location.hash, `referrer` is
// document.referrer, `host` is location.hostname. Never throws: a malformed
// input is treated as absent.
export function deriveAttribution(input) {
  const { search, hash, referrer, host, now } = input && typeof input === "object" ? input : {};
  let params;
  try {
    params = new URLSearchParams(String(search ?? ""));
  } catch {
    params = new URLSearchParams();
  }
  const landing = cleanAttributionValue(hashHead(hash)) ?? null;
  const capturedAt = Number.isFinite(now) ? now : Date.now();
  const utmSource = cleanAttributionValue(params.get("utm_source"));
  if (utmSource) {
    return {
      source: utmSource,
      medium: cleanAttributionValue(params.get("utm_medium")),
      campaign: cleanAttributionValue(params.get("utm_campaign")),
      landing,
      capturedAt,
    };
  }
  if (hashHead(hash) === "join") {
    return { source: INVITE_SOURCE, medium: "referral", campaign: null, landing, capturedAt };
  }
  const referred = fromReferrer(referrer, host);
  if (referred) return { ...referred, campaign: null, landing, capturedAt };
  return { source: DIRECT_SOURCE, medium: null, campaign: null, landing, capturedAt };
}

// Which record survives a new visit. First touch wins unless the stored one
// has aged out or says nothing (see the header).
export function mergeAttribution(stored, fresh, now = Date.now()) {
  if (!fresh) return stored ?? null;
  if (!stored) return fresh;
  const age = now - Number(stored.capturedAt);
  if (!Number.isFinite(age) || age < 0 || age > ATTRIBUTION_TTL_MS) return fresh;
  if (stored.source === DIRECT_SOURCE && fresh.source !== DIRECT_SOURCE) return fresh;
  return stored;
}

// The four fields that travel: to the Worker in the sign-in body, onto the
// users row, and (prefixed) onto the sign-in event. Returns null when there is
// no usable source, which every consumer treats as "nothing known". Used on
// BOTH sides, so a value the client would send is exactly a value the Worker
// would store.
export function normalizeAttribution(input) {
  if (!input || typeof input !== "object") return null;
  const source = cleanAttributionValue(input.source);
  if (!source) return null;
  return {
    source,
    medium: cleanAttributionValue(input.medium),
    campaign: cleanAttributionValue(input.campaign),
    landing: cleanAttributionValue(input.landing),
  };
}

// localStorage round trip. A record that fails to normalise reads as absent
// rather than as something to argue with.
export function parseStoredAttribution(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const normalized = normalizeAttribution(parsed);
    if (!normalized) return null;
    const capturedAt = Number(parsed?.capturedAt);
    return { ...normalized, capturedAt: Number.isFinite(capturedAt) ? capturedAt : 0 };
  } catch {
    return null;
  }
}

export function serializeAttribution(attribution) {
  const normalized = normalizeAttribution(attribution);
  if (!normalized) return null;
  const capturedAt = Number(attribution?.capturedAt);
  return JSON.stringify({ ...normalized, capturedAt: Number.isFinite(capturedAt) ? capturedAt : Date.now() });
}

import test from "node:test";
import assert from "node:assert/strict";

import {
  ATTRIBUTION_TTL_MS,
  ATTRIBUTION_VALUE_MAX,
  cleanAttributionValue,
  deriveAttribution,
  mergeAttribution,
  normalizeAttribution,
  parseStoredAttribution,
  serializeAttribution,
} from "../src/attribution.js";

const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);

test("utm parameters win over everything else and are cleaned", () => {
  const attribution = deriveAttribution({
    search: "?utm_source=Reddit&utm_medium=Social&utm_campaign=FPL%20Restart%20Jan",
    hash: "#join/ABCDEFGH",
    referrer: "https://www.google.com/",
    host: "kickoffdraft.com",
    now: NOW,
  });
  assert.deepEqual(attribution, {
    source: "reddit",
    medium: "social",
    campaign: "fpl-restart-jan",
    landing: "join",
    capturedAt: NOW,
  });
});

test("an invite link is its own source and the code never leaves the hash", () => {
  const attribution = deriveAttribution({ hash: "#join/SECRETCODE1", referrer: "https://web.whatsapp.com/", host: "kickoffdraft.com", now: NOW });
  assert.equal(attribution.source, "invite");
  assert.equal(attribution.medium, "referral");
  assert.equal(attribution.landing, "join");
  assert.ok(!JSON.stringify(attribution).toLowerCase().includes("secretcode1"));
});

test("known referrers are named, unknown ones keep their host, same-host is direct", () => {
  const at = (referrer) => deriveAttribution({ referrer, host: "kickoffdraft.com", hash: "#live", now: NOW });
  assert.deepEqual([at("https://www.google.ie/search?q=x").source, at("https://www.google.ie/").medium], ["google", "organic"]);
  assert.equal(at("https://old.reddit.com/r/FantasyPL/").source, "reddit");
  assert.equal(at("https://t.co/abc").source, "x");
  assert.equal(at("https://m.facebook.com/").source, "facebook");
  assert.deepEqual([at("https://news.ycombinator.com/item?id=1").source, at("https://news.ycombinator.com/").medium], ["news.ycombinator.com", "referral"]);
  assert.equal(at("https://kickoffdraft.com/#tables").source, "direct");
  assert.equal(at("https://www.kickoffdraft.com/").source, "direct");
  assert.equal(at("").source, "direct");
  assert.equal(at("not a url").source, "direct");
});

test("a visitor arriving from a pre-rendered Learn page is attributed to learn", () => {
  const attribution = deriveAttribution({ referrer: "https://kickoffdraft.com/learn/how-waivers-work/", host: "kickoffdraft.com", hash: "", now: NOW });
  assert.equal(attribution.source, "learn");
  assert.equal(attribution.landing, null);
});

test("values are lowercased, restricted to a safe alphabet and capped", () => {
  assert.equal(cleanAttributionValue("  Reddit Ads / r/FantasyPL  "), "reddit-ads-r-fantasypl");
  assert.equal(cleanAttributionValue("'; DROP TABLE users; --"), "drop-table-users");
  assert.equal(cleanAttributionValue("x".repeat(500)).length, ATTRIBUTION_VALUE_MAX);
  assert.equal(cleanAttributionValue("---"), null);
  assert.equal(cleanAttributionValue(""), null);
  assert.equal(cleanAttributionValue(null), null);
  assert.equal(cleanAttributionValue(42), "42");
});

test("derive never throws on garbage", () => {
  for (const input of [undefined, null, {}, { search: 42, hash: {}, referrer: [], host: null }, { search: "%E0%A4%A" }]) {
    const attribution = deriveAttribution(input);
    assert.equal(attribution.source, "direct");
    assert.ok(Number.isFinite(attribution.capturedAt));
  }
});

test("first touch wins, except that an aged-out or direct record yields", () => {
  const reddit = { source: "reddit", medium: "social", campaign: null, landing: "live", capturedAt: NOW };
  const google = { source: "google", medium: "organic", campaign: null, landing: "live", capturedAt: NOW + 1000 };
  const direct = { source: "direct", medium: null, campaign: null, landing: "live", capturedAt: NOW };
  assert.equal(mergeAttribution(reddit, google, NOW + 1000), reddit, "a second referrer must not overwrite the first");
  assert.equal(mergeAttribution(direct, google, NOW + 1000), google, "direct carries no information");
  assert.equal(mergeAttribution(reddit, direct, NOW + 1000), reddit, "a later direct visit keeps the referrer");
  assert.equal(mergeAttribution(reddit, google, NOW + ATTRIBUTION_TTL_MS + 1), google, "an aged-out record yields");
  assert.equal(mergeAttribution({ ...reddit, capturedAt: "bogus" }, google, NOW), google, "an unreadable timestamp yields");
  assert.equal(mergeAttribution(null, google, NOW), google);
  assert.equal(mergeAttribution(reddit, null, NOW), reddit);
  assert.equal(mergeAttribution(null, null, NOW), null);
});

test("normalize accepts only the four fields and refuses a record without a source", () => {
  assert.deepEqual(normalizeAttribution({ source: "Reddit", medium: "SOCIAL", campaign: null, landing: "Live", extra: "dropped" }), {
    source: "reddit",
    medium: "social",
    campaign: null,
    landing: "live",
  });
  assert.equal(normalizeAttribution({ medium: "social" }), null);
  assert.equal(normalizeAttribution({ source: "!!!" }), null);
  assert.equal(normalizeAttribution("reddit"), null);
  assert.equal(normalizeAttribution(null), null);
});

test("the storage round trip survives corruption", () => {
  const stored = serializeAttribution({ source: "reddit", medium: "social", campaign: "jan", landing: "live", capturedAt: NOW });
  assert.deepEqual(parseStoredAttribution(stored), { source: "reddit", medium: "social", campaign: "jan", landing: "live", capturedAt: NOW });
  assert.equal(parseStoredAttribution("{not json"), null);
  assert.equal(parseStoredAttribution('{"medium":"social"}'), null);
  assert.equal(parseStoredAttribution(null), null);
  assert.equal(parseStoredAttribution('{"source":"x","capturedAt":"soon"}').capturedAt, 0);
  assert.equal(serializeAttribution({ source: "" }), null);
});

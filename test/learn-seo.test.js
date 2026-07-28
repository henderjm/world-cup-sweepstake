import assert from "node:assert/strict";
import test from "node:test";

import {
  LEARN_INDEX_PATH,
  SITE_ORIGIN,
  absoluteUrl,
  buildSitemap,
  learnPageSlug,
  learnPages,
  sitemapEntries,
  slugify,
} from "../src/learnSeo.js";
import { TUTORIALS } from "../src/tutorials.js";

// -- slugify -------------------------------------------------------------------

test("slugify lowercases and hyphenates a title", () => {
  assert.equal(slugify("How waivers work"), "how-waivers-work");
  assert.equal(slugify("Running your first league"), "running-your-first-league");
});

test("slugify drops apostrophes rather than splitting the word", () => {
  assert.equal(slugify("A manager's first draft"), "a-managers-first-draft");
  assert.equal(slugify("A manager’s first draft"), "a-managers-first-draft");
});

test("slugify strips diacritics instead of dropping the letter", () => {
  assert.equal(slugify("Café tactics"), "cafe-tactics");
});

test("slugify collapses runs of punctuation and trims the edges", () => {
  assert.equal(slugify("  FAAB: bidding, budgets & you!  "), "faab-bidding-budgets-you");
  assert.equal(slugify("--already--hyphenated--"), "already-hyphenated");
});

test("slugify returns an empty string for input with nothing sluggable in it", () => {
  assert.equal(slugify("!!!"), "");
  assert.equal(slugify(""), "");
  assert.equal(slugify(null), "");
  assert.equal(slugify(undefined), "");
});

// -- learnPageSlug / learnPages ---------------------------------------------------

test("learnPageSlug prefers the title over the tutorial's terse route slug", () => {
  assert.equal(learnPageSlug({ slug: "waivers", title: "How waivers work" }), "how-waivers-work");
});

test("learnPageSlug falls back to the route slug when the title slugifies to nothing", () => {
  assert.equal(learnPageSlug({ slug: "waivers", title: "???" }), "waivers");
});

test("learnPages derives a page per tutorial from the array it is given", () => {
  const pages = learnPages([
    { slug: "waivers", title: "How waivers work" },
    { slug: "first-league", title: "Running your first league" },
  ]);
  assert.deepEqual(
    pages.map((page) => page.path),
    ["/learn/how-waivers-work/", "/learn/running-your-first-league/"],
  );
  assert.equal(pages[0].tutorial.slug, "waivers");
});

test("learnPages resolves a title collision via the tutorial's own route slug", () => {
  const pages = learnPages([
    { slug: "a", title: "How waivers work" },
    { slug: "waivers-deep", title: "How waivers work" },
  ]);
  assert.deepEqual(
    pages.map((page) => page.slug),
    ["how-waivers-work", "waivers-deep"],
  );
});

test("learnPages falls back to a numeric suffix when the route slug is taken too", () => {
  const pages = learnPages([
    { slug: "dupe", title: "How waivers work" },
    { slug: "dupe", title: "How waivers work" },
    { slug: "dupe", title: "How waivers work" },
  ]);
  const slugs = pages.map((page) => page.slug);
  assert.equal(new Set(slugs).size, 3, `expected unique slugs, got ${slugs.join(", ")}`);
  assert.deepEqual(slugs, ["how-waivers-work", "dupe", "how-waivers-work-2"]);
});

test("learnPages drops a tutorial with no usable slug instead of emitting /learn//", () => {
  const pages = learnPages([{ slug: "", title: "!!!" }, { slug: "ok", title: "Fine" }]);
  assert.deepEqual(
    pages.map((page) => page.path),
    ["/learn/fine/"],
  );
});

test("learnPages handles an empty registry", () => {
  assert.deepEqual(learnPages([]), []);
  assert.deepEqual(learnPages(), []);
});

test("every real tutorial gets a page with a non-empty, unique slug", () => {
  const pages = learnPages(TUTORIALS);
  assert.equal(pages.length, TUTORIALS.length);
  const slugs = pages.map((page) => page.slug);
  assert.equal(new Set(slugs).size, slugs.length);
  for (const slug of slugs) assert.match(slug, /^[a-z0-9]+(-[a-z0-9]+)*$/);
});

// -- absoluteUrl ------------------------------------------------------------------

test("absoluteUrl joins origin and path without doubling the slash", () => {
  assert.equal(absoluteUrl("/learn/x/"), "https://kickoffdraft.com/learn/x/");
  assert.equal(absoluteUrl("/learn/x/", "https://example.com/"), "https://example.com/learn/x/");
  assert.equal(absoluteUrl("learn/x/", "https://example.com"), "https://example.com/learn/x/");
});

// -- buildSitemap -----------------------------------------------------------------

test("buildSitemap emits one url element per entry with its lastmod", () => {
  const xml = buildSitemap([
    { loc: "https://kickoffdraft.com/", lastmod: "2026-07-26" },
    { loc: "https://kickoffdraft.com/learn/", lastmod: "2026-07-28" },
  ]);
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  assert.equal(xml.match(/<url>/g).length, 2);
  assert.match(xml, /<loc>https:\/\/kickoffdraft\.com\/<\/loc>\s*<lastmod>2026-07-26<\/lastmod>/);
  assert.match(xml, /<\/urlset>\n$/);
});

test("buildSitemap omits lastmod when it is unknown rather than inventing one", () => {
  const xml = buildSitemap([{ loc: "https://kickoffdraft.com/" }]);
  assert.doesNotMatch(xml, /<lastmod>/);
});

test("buildSitemap skips entries with no loc and escapes XML in the ones it keeps", () => {
  const xml = buildSitemap([{ lastmod: "2026-07-28" }, { loc: "https://x.test/a?b=1&c=2" }]);
  assert.equal(xml.match(/<url>/g).length, 1);
  assert.match(xml, /a\?b=1&amp;c=2/);
});

test("buildSitemap handles no entries at all without producing invalid XML", () => {
  const xml = buildSitemap([]);
  assert.match(xml, /<urlset[^>]*>\n<\/urlset>/);
});

// -- sitemapEntries ---------------------------------------------------------------

test("sitemapEntries covers the home page, the learn hub and every tutorial", () => {
  const entries = sitemapEntries({
    tutorials: [
      { slug: "waivers", title: "How waivers work" },
      { slug: "first-league", title: "Running your first league" },
    ],
    homeLastmod: "2026-07-01",
    learnLastmod: "2026-07-20",
  });
  assert.deepEqual(
    entries.map((entry) => entry.loc),
    [
      "https://kickoffdraft.com/",
      "https://kickoffdraft.com/learn/",
      "https://kickoffdraft.com/learn/how-waivers-work/",
      "https://kickoffdraft.com/learn/running-your-first-league/",
    ],
  );
  assert.equal(entries[0].lastmod, "2026-07-01");
  assert.equal(entries[2].lastmod, "2026-07-20");
});

test("sitemapEntries grows with the registry, so a new tutorial cannot be left out", () => {
  const base = sitemapEntries({ tutorials: [{ slug: "a", title: "Alpha" }] });
  const grown = sitemapEntries({ tutorials: [{ slug: "a", title: "Alpha" }, { slug: "b", title: "Bravo" }] });
  assert.equal(grown.length, base.length + 1);
  assert.ok(grown.some((entry) => entry.loc.endsWith("/learn/bravo/")));
});

test("sitemapEntries honours a non-default origin throughout", () => {
  const entries = sitemapEntries({ tutorials: [{ slug: "a", title: "Alpha" }], origin: "https://staging.test" });
  for (const entry of entries) assert.ok(entry.loc.startsWith("https://staging.test/"));
});

test("the site origin and learn hub path are the ones robots.txt and CNAME assume", () => {
  assert.equal(SITE_ORIGIN, "https://kickoffdraft.com");
  assert.equal(LEARN_INDEX_PATH, "/learn/");
});

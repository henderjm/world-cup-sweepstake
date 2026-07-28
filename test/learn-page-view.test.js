import assert from "node:assert/strict";
import test from "node:test";

import { learnPages } from "../src/learnSeo.js";
import {
  metaDescription,
  pageTitle,
  renderLearnArticlePage,
  renderLearnIndexPage,
  renderNoscriptLearnLinks,
  renderStaticSections,
} from "../src/learnPageView.js";
import { TUTORIALS, tutorialBySlug } from "../src/tutorials.js";

const CSS = "assets/index-abc123.css";
const PAGES = learnPages(TUTORIALS);

function articleFor(routeSlug) {
  const page = PAGES.find((candidate) => candidate.tutorial.slug === routeSlug);
  assert.ok(page, `no generated page for tutorial "${routeSlug}"`);
  return { page, html: renderLearnArticlePage({ page, pages: PAGES, cssFile: CSS, lastmod: "2026-07-28" }) };
}

// -- Head metadata -----------------------------------------------------------------

test("pageTitle brands the tutorial title", () => {
  assert.equal(pageTitle({ title: "How waivers work" }), "How waivers work | Kickoff Draft");
});

test("metaDescription appends the keyword suffix when it still fits in 160 characters", () => {
  const description = metaDescription({ summary: "Short summary.", minutes: 6 });
  assert.match(description, /^Short summary\. A 6-minute Kickoff Draft guide/);
  assert.ok(description.length <= 160);
});

test("metaDescription keeps the bare summary rather than overflowing", () => {
  const summary = "x".repeat(150);
  assert.equal(metaDescription({ summary, minutes: 9 }), summary);
});

test("every real tutorial page has a unique title, description and canonical", () => {
  const titles = new Set();
  const canonicals = new Set();
  for (const page of PAGES) {
    const html = renderLearnArticlePage({ page, pages: PAGES, cssFile: CSS });
    const title = /<title>([^<]+)<\/title>/.exec(html)?.[1];
    const canonical = /<link rel="canonical" href="([^"]+)"/.exec(html)?.[1];
    const description = /<meta name="description" content="([^"]+)"/.exec(html)?.[1];
    assert.ok(title && description && canonical);
    assert.equal(canonical, `https://kickoffdraft.com${page.path}`);
    titles.add(title);
    canonicals.add(canonical);
  }
  assert.equal(titles.size, PAGES.length);
  assert.equal(canonicals.size, PAGES.length);
});

test("an article page carries the Open Graph and Twitter tags the home page does", () => {
  const { html } = articleFor("waivers");
  for (const tag of [
    /<meta property="og:type" content="article" \/>/,
    /<meta property="og:site_name" content="Kickoff Draft" \/>/,
    /<meta property="og:url" content="https:\/\/kickoffdraft\.com\/learn\/how-waivers-work\/" \/>/,
    /<meta property="og:image" content="https:\/\/kickoffdraft\.com\/assets\/og-image\.png" \/>/,
    /<meta name="twitter:card" content="summary_large_image" \/>/,
    /<meta name="twitter:image" content="https:\/\/kickoffdraft\.com\/assets\/og-image\.png" \/>/,
    /<meta name="theme-color" content="#0A0E14" \/>/,
  ]) {
    assert.match(html, tag);
  }
});

test("an article page links the hashed stylesheet relative to its own depth", () => {
  const { html } = articleFor("waivers");
  assert.match(html, /<link rel="stylesheet" href="\.\.\/\.\.\/assets\/index-abc123\.css" \/>/);
  assert.match(html, /<link rel="manifest" href="\.\.\/\.\.\/site\.webmanifest" \/>/);
  assert.doesNotMatch(html, /href="\/assets\//);
});

test("the learn index links assets one level up, not two", () => {
  const html = renderLearnIndexPage({ pages: PAGES, cssFile: CSS });
  assert.match(html, /<link rel="stylesheet" href="\.\.\/assets\/index-abc123\.css" \/>/);
  assert.match(html, /<link rel="canonical" href="https:\/\/kickoffdraft\.com\/learn\/" \/>/);
});

test("the hub is og:type website and an article page is og:type article", () => {
  assert.match(renderLearnIndexPage({ pages: PAGES, cssFile: CSS }), /<meta property="og:type" content="website" \/>/);
  assert.match(articleFor("waivers").html, /<meta property="og:type" content="article" \/>/);
});

// -- Structured data ----------------------------------------------------------------

function jsonLdBlocks(html) {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((match) =>
    JSON.parse(match[1]),
  );
}

test("an article page emits valid Article and BreadcrumbList JSON-LD", () => {
  const { html } = articleFor("waivers");
  const blocks = jsonLdBlocks(html);
  const article = blocks.find((block) => block["@type"] === "Article");
  const crumbs = blocks.find((block) => block["@type"] === "BreadcrumbList");
  assert.ok(article, "expected an Article block");
  assert.equal(article.headline, "How waivers work");
  assert.equal(article.url, "https://kickoffdraft.com/learn/how-waivers-work/");
  assert.equal(article.timeRequired, "PT6M");
  assert.equal(article.dateModified, "2026-07-28");
  assert.equal(article.inLanguage, "en-GB");
  assert.equal(article.publisher.name, "Kickoff Draft");
  assert.ok(crumbs, "expected a BreadcrumbList block");
  assert.deepEqual(
    crumbs.itemListElement.map((item) => item.name),
    ["Home", "Learn", "How waivers work"],
  );
  assert.deepEqual(
    crumbs.itemListElement.map((item) => item.position),
    [1, 2, 3],
  );
});

test("the learn index emits a CollectionPage listing every tutorial page", () => {
  const html = renderLearnIndexPage({ pages: PAGES, cssFile: CSS });
  const collection = jsonLdBlocks(html).find((block) => block["@type"] === "CollectionPage");
  assert.ok(collection);
  assert.equal(collection.mainEntity["@type"], "ItemList");
  assert.deepEqual(
    collection.mainEntity.itemListElement.map((item) => item.url),
    PAGES.map((page) => `https://kickoffdraft.com${page.path}`),
  );
});

test("JSON-LD escapes < so content data can never close the script block early", () => {
  const page = {
    tutorial: { slug: "x", title: "</script><script>alert(1)</script>", summary: "s", minutes: 3, sections: [] },
    slug: "x",
    path: "/learn/x/",
  };
  const html = renderLearnArticlePage({ page, pages: [page], cssFile: CSS });
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /\\u003c\/script>/);
});

// -- Content is in the initial HTML ---------------------------------------------------

test("a tutorial's prose is present in the raw HTML, not injected later", () => {
  const { html } = articleFor("first-league");
  const tutorial = tutorialBySlug("first-league");
  const prose = tutorial.sections.filter((section) => section.type === "prose");
  for (const section of prose) {
    assert.ok(html.includes(section.heading), `missing heading: ${section.heading}`);
    for (const paragraph of section.body) {
      // The renderer escapes content, so compare against the escaped form.
      const escaped = paragraph.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
      assert.ok(html.includes(escaped), `missing paragraph: ${paragraph.slice(0, 48)}…`);
    }
  }
});

test("an article page loads no application JavaScript", () => {
  const { html } = articleFor("waivers");
  const scripts = [...html.matchAll(/<script([^>]*)>/g)].map((match) => match[1]);
  for (const attributes of scripts) {
    assert.match(attributes, /type="application\/ld\+json"/, `unexpected script tag: <script${attributes}>`);
  }
});

test("the static resolver stacks every waiver mode instead of hiding two behind a toggle", () => {
  const { html } = articleFor("waivers");
  const tutorial = tutorialBySlug("waivers");
  const resolver = tutorial.sections.find((section) => section.type === "resolver");
  for (const [, mode] of Object.entries(resolver.modes)) {
    assert.ok(html.includes(mode.label), `missing mode label: ${mode.label}`);
    assert.ok(html.includes(mode.winner), `missing winner: ${mode.winner}`);
    assert.ok(html.includes(mode.aftermath.slice(0, 40)), `missing aftermath for ${mode.label}`);
  }
  // No interactive controls survive onto the static page.
  assert.doesNotMatch(html, /data-tutorial-resolver-mode/);
  assert.doesNotMatch(html, /data-tutorial-open/);
  assert.doesNotMatch(html, /data-tutorial-back/);
});

test("renderStaticSections skips a block type it does not recognise rather than throwing", () => {
  const html = renderStaticSections({
    sections: [{ type: "nonsense" }, { type: "prose", heading: "Kept", body: ["Still here."] }],
  });
  assert.match(html, /Kept/);
  assert.match(html, /Still here\./);
});

// -- Internal linking -------------------------------------------------------------------

test("an article page links back into the app and out to its siblings and the hub", () => {
  const { page, html } = articleFor("waivers");
  assert.match(html, /href="\.\.\/\.\.\/#demo"/);
  assert.match(html, /href="\.\.\/\.\.\/#fantasy"/);
  assert.match(html, /href="\.\.\/\.\.\/#learn\/waivers"/);
  assert.match(html, /href="\.\.\/learn\/"|href="\.\.\/\.\.\/learn\/"/);
  for (const other of PAGES.filter((candidate) => candidate.slug !== page.slug)) {
    assert.ok(html.includes(`href="../${other.slug}/"`), `missing sibling link to ${other.slug}`);
  }
});

test("the learn index links every tutorial page relatively", () => {
  const html = renderLearnIndexPage({ pages: PAGES, cssFile: CSS });
  for (const page of PAGES) {
    assert.ok(html.includes(`href="${page.slug}/"`), `missing index link to ${page.slug}`);
    assert.ok(html.includes(page.tutorial.title));
  }
});

test("the learn index copes with an empty registry", () => {
  const html = renderLearnIndexPage({ pages: [], cssFile: CSS });
  assert.match(html, /No guides yet\./);
});

test("renderNoscriptLearnLinks lists every page and stays empty when there are none", () => {
  const links = renderNoscriptLearnLinks(PAGES);
  for (const page of PAGES) {
    assert.ok(links.includes(`href="learn/${page.slug}/"`), `missing noscript link to ${page.slug}`);
    assert.ok(links.includes(page.tutorial.title));
  }
  assert.equal(renderNoscriptLearnLinks([]), "");
});

// -- Document integrity -------------------------------------------------------------------

test("every generated document is a single well-formed HTML page", () => {
  const docs = [renderLearnIndexPage({ pages: PAGES, cssFile: CSS })].concat(
    PAGES.map((page) => renderLearnArticlePage({ page, pages: PAGES, cssFile: CSS })),
  );
  for (const html of docs) {
    assert.match(html, /^<!doctype html>\n<html lang="en">/);
    assert.match(html, /<\/html>\n$/);
    assert.equal(html.match(/<h1 /g).length, 1, "expected exactly one h1");
    assert.doesNotMatch(html, /undefined/);
    assert.doesNotMatch(html, /\[object Object\]/);
  }
});

// Build-time renderers for the standalone /learn/ pages: a complete HTML
// document per tutorial plus the /learn/ hub that links them together.
//
// These are NOT the in-app Learn section (src/tutorialsView.js is). They exist
// because the app is hash-routed and client-rendered, so a crawler sees one
// URL with almost no indexable text. Everything a crawler needs here is in the
// initial HTML: no app bundle is loaded and nothing on the page depends on
// JavaScript running.
//
// Content correctness is inherited, not forked. The prose comes from
// src/tutorials.js (the same registry the in-app reader uses, and the one
// test/tutorials.test.js cross-checks against the real waiver engine) and every
// section block is rendered by tutorialsView.js's own SECTION_RENDERERS. Only
// the resolver block is overridden: in the app it is a three-way toggle, and a
// toggle is useless to a crawler and to a reader with no JavaScript, so the
// static page stacks all three modes instead. That is strictly more indexable
// text for the same data.
//
// Chrome (nav, breadcrumbs, calls to action, footer) is styled with the app's
// own stylesheet plus the small "Static Learn pages" block at the bottom of
// src/styles.css, so these pages look like the product rather than a bare
// document.

import { SITE_ORIGIN, LEARN_SEGMENT, absoluteUrl } from "./learnSeo.js";
import {
  esc,
  renderHeading,
  renderResolverClaimsTable,
  renderResolverOutcomes,
  RESOLVER_MODE_ORDER,
  SECTION_RENDERERS,
} from "./tutorialsView.js";

const SITE_NAME = "Kickoff Draft";
const OG_IMAGE_PATH = "/assets/og-image.png";
const OG_IMAGE_ALT = "Kickoff Draft wordmark on a navy background, with a lime accent line.";
const INDEX_TITLE = "Learn: fantasy Premier League draft guides";
const INDEX_DESCRIPTION =
  "Short, practical guides to running a head-to-head fantasy Premier League draft league: the snake draft itself, and how waivers, FAAB bidding and free agency actually resolve.";
const INDEX_LEDE = "Short walkthroughs of how Kickoff Draft features actually work.";

// A page one level deep (/learn/) and two levels deep (/learn/<slug>/) both
// reach the site root through these. Relative rather than root-absolute so the
// pages keep working under any base, the same reason vite.config.js sets
// base: "./".
const INDEX_PREFIX = "../";
const ARTICLE_PREFIX = "../../";

const MAX_META_DESCRIPTION = 160;

/**
 * Meta description for one tutorial: its own summary, with a keyword-carrying
 * suffix appended only when that still fits inside what a search result will
 * actually show. A truncated description reads worse than a short one.
 */
export function metaDescription(tutorial) {
  const summary = String(tutorial?.summary ?? "").trim();
  const suffix = `A ${tutorial?.minutes}-minute Kickoff Draft guide to head-to-head fantasy Premier League.`;
  if (!summary) return suffix;
  const joined = `${summary} ${suffix}`;
  return joined.length <= MAX_META_DESCRIPTION ? joined : summary;
}

export function pageTitle(tutorial) {
  return `${tutorial?.title ?? "Learn"} | ${SITE_NAME}`;
}

// JSON-LD is emitted with "<" escaped so a stray "</script>" inside content
// data can never close the block early.
function jsonLd(data) {
  return `<script type="application/ld+json">\n${JSON.stringify(data, null, 2).replace(/</g, "\\u003c")}\n    </script>`;
}

function organization(origin) {
  return {
    "@type": "Organization",
    name: SITE_NAME,
    url: absoluteUrl("/", origin),
    logo: absoluteUrl(OG_IMAGE_PATH, origin),
  };
}

function breadcrumbs(items) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: item.url,
    })),
  };
}

// -- Document shell -------------------------------------------------------------

/**
 * A complete HTML document. `prefix` is how this page reaches the site root
 * ("../" or "../../"); every asset and internal link is built from it, so the
 * pages carry no assumption about being served from a domain root.
 */
function renderDocument({ title, description, canonical, prefix, cssFile, structuredData, body, origin }) {
  const ogImage = absoluteUrl(OG_IMAGE_PATH, origin);
  const blocks = structuredData.map(jsonLd).join("\n    ");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${esc(title)}</title>
    <meta name="description" content="${esc(description)}" />
    <link rel="canonical" href="${esc(canonical)}" />
    <meta name="theme-color" content="#0A0E14" />

    <!-- Open Graph -->
    <meta property="og:type" content="article" />
    <meta property="og:site_name" content="${esc(SITE_NAME)}" />
    <meta property="og:title" content="${esc(title)}" />
    <meta property="og:description" content="${esc(description)}" />
    <meta property="og:url" content="${esc(canonical)}" />
    <meta property="og:image" content="${esc(ogImage)}" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta property="og:image:alt" content="${esc(OG_IMAGE_ALT)}" />
    <meta property="og:locale" content="en_GB" />

    <!-- Twitter card -->
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${esc(title)}" />
    <meta name="twitter:description" content="${esc(description)}" />
    <meta name="twitter:image" content="${esc(ogImage)}" />
    <meta name="twitter:image:alt" content="${esc(OG_IMAGE_ALT)}" />

    <!-- Icons and web app manifest -->
    <link rel="icon" href="${prefix}assets/favicon.svg" type="image/svg+xml" />
    <link rel="icon" href="${prefix}assets/favicon-32.png" type="image/png" sizes="32x32" />
    <link rel="apple-touch-icon" href="${prefix}assets/apple-touch-icon.png" sizes="180x180" />
    <link rel="manifest" href="${prefix}site.webmanifest" />

    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Archivo:ital,wght@0,400..900;1,400..900&display=swap" rel="stylesheet" />
    <link rel="stylesheet" href="${prefix}${cssFile}" />

    ${blocks}
  </head>
  <body>
${body}
  </body>
</html>
`;
}

function renderTopnav(prefix, learnHref) {
  return `    <header class="topnav">
      <a class="brand" href="${prefix}">
        <span class="brand__mark">KD</span>
        <span class="brand__stack">
          <strong class="brand__name">Kickoff Draft</strong>
          <span class="brand__sub">Draft · Waivers · Head-to-Head</span>
        </span>
      </a>
      <nav class="learnpage-nav" aria-label="Sections">
        <a class="navbtn" href="${prefix}">Scores</a>
        <a class="navbtn" href="${prefix}#fantasy">Fantasy</a>
        <a class="navbtn is-active" href="${learnHref}">Learn</a>
      </nav>
      <span class="topnav__spacer"></span>
      <a class="learnpage-cta learnpage-cta--nav" href="${prefix}#demo">Try a draft</a>
    </header>`;
}

function renderFooter(prefix) {
  return `    <footer class="footer learnpage-footer">
      <p><a href="${prefix}">Kickoff Draft</a> is a Goon Squad production · Not affiliated with the Premier League or UEFA.</p>
    </footer>`;
}

function renderCrumbs(trail) {
  const items = trail
    .map((item, index) => {
      const last = index === trail.length - 1;
      const label = last
        ? `<span aria-current="page">${esc(item.name)}</span>`
        : `<a href="${item.href}">${esc(item.name)}</a>`;
      return `${index > 0 ? `<span class="learnpage-crumbs__sep" aria-hidden="true">/</span>` : ""}${label}`;
    })
    .join("");
  return `<nav class="learnpage-crumbs" aria-label="Breadcrumb">${items}</nav>`;
}

// -- The static resolver block ---------------------------------------------------

// The app's version of this block is a three-way toggle driven by
// state.learn.resolverMode. Nothing here can hold state, and hiding two thirds
// of the block's content behind JavaScript would throw away exactly the text
// this page exists to expose, so all three modes are stacked instead. The
// claims table is shared by all three and is rendered once above them.
function renderStaticResolverSection(section) {
  const modes = section.modes ?? {};
  const keys = RESOLVER_MODE_ORDER.filter((key) => modes[key]);
  if (!keys.length) return "";
  const blocks = keys
    .map((key) => {
      const mode = modes[key];
      return `<div class="card tutorial-resolver learnpage-resolver">
          <h3 class="learnpage-resolver__label">${esc(mode.label)}</h3>
          <p class="note tutorial-resolver__desc">${esc(mode.description)}</p>
          <div class="tutorial-resolver__winner">
            <span class="tutorial-resolver__winnertag">Wins ${esc(section.target)}</span>
            <span class="tutorial-resolver__winnername">${esc(mode.winner)}</span>
          </div>
          ${renderResolverOutcomes(mode.outcomes)}
          <dl class="tutorial-resolver__aftermath">
            <dt>What changes afterwards</dt>
            <dd>${esc(mode.aftermath)}</dd>
          </dl>
        </div>`;
    })
    .join("");
  return `<section class="tutorial-section">
      ${renderHeading(section.heading)}
      ${section.intro ? `<p class="tutorial-p">${esc(section.intro)}</p>` : ""}
      <div class="card tutorial-table-card">${renderResolverClaimsTable(section.target, section.claims)}</div>
      ${blocks}
    </section>`;
}

const STATIC_SECTION_RENDERERS = { ...SECTION_RENDERERS, resolver: renderStaticResolverSection };

/** Every section of a tutorial as static HTML, with no interactive blocks. */
export function renderStaticSections(tutorial) {
  return (tutorial?.sections ?? [])
    .map((section) => (STATIC_SECTION_RENDERERS[section.type] ? STATIC_SECTION_RENDERERS[section.type](section) : ""))
    .join("");
}

// -- Calls to action and cross-links ---------------------------------------------

// An orphan page does not rank and a page with no way into the product does not
// convert, so every tutorial page ends with both: a route into the app, and
// links to its siblings and the hub.
function renderCtaCard(prefix, appHash) {
  return `<aside class="card learnpage-cta-card">
        <h2 class="learnpage-cta-card__title">Try it before you organise anyone</h2>
        <p class="note">Draft a squad against bots and watch a whole season play out in about five minutes. No sign-in, nothing to install.</p>
        <div class="learnpage-cta-card__row">
          <a class="learnpage-cta" href="${prefix}#demo">Try a 5-minute draft</a>
          <a class="learnpage-cta learnpage-cta--ghost" href="${prefix}#fantasy">Create a real league</a>
        </div>
        <p class="note--dim learnpage-cta-card__note"><a href="${prefix}#${appHash}">Open this guide inside the app</a> to use the interactive version.</p>
      </aside>`;
}

function renderMoreTutorials(pages, currentSlug, learnHref) {
  const others = pages.filter((page) => page.slug !== currentSlug);
  const links = others
    .map(
      (page) =>
        `<a class="card learnpage-more__card" href="../${page.slug}/">
            <span class="learnpage-more__title">${esc(page.tutorial.title)}</span>
            <span class="note">${esc(page.tutorial.summary)}</span>
          </a>`,
    )
    .join("");
  return `<nav class="learnpage-more" aria-label="More guides">
        <h2 class="tutorial-heading">More guides</h2>
        ${links || `<p class="note">More guides are on the way.</p>`}
        <p class="note--dim learnpage-more__all"><a href="${learnHref}">All guides</a></p>
      </nav>`;
}

// -- Pages ------------------------------------------------------------------------

/**
 * One tutorial as a complete static page.
 *
 * schema.org type: Article, deliberately not HowTo. HowTo describes a sequence
 * of steps producing one concrete result, and these are explainers: "How
 * waivers work" spends most of its length on the same week resolving three
 * different ways under three different rule sets, which is not a step list and
 * has no single outcome. Google also dropped HowTo rich results, so choosing it
 * would be inaccurate markup bought for nothing.
 */
export function renderLearnArticlePage({ page, pages = [], origin = SITE_ORIGIN, cssFile, lastmod } = {}) {
  const { tutorial, slug, path } = page;
  const canonical = absoluteUrl(path, origin);
  const title = pageTitle(tutorial);
  const description = metaDescription(tutorial);
  const prefix = ARTICLE_PREFIX;
  const learnHref = `${prefix}${LEARN_SEGMENT}/`;

  const article = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: tutorial.title,
    description: tutorial.summary,
    url: canonical,
    mainEntityOfPage: { "@type": "WebPage", "@id": canonical },
    inLanguage: "en-GB",
    timeRequired: `PT${tutorial.minutes}M`,
    image: absoluteUrl(OG_IMAGE_PATH, origin),
    author: organization(origin),
    publisher: organization(origin),
    isPartOf: { "@type": "WebSite", name: SITE_NAME, url: absoluteUrl("/", origin) },
    ...(lastmod ? { dateModified: lastmod } : {}),
  };

  const trail = breadcrumbs([
    { name: "Home", url: absoluteUrl("/", origin) },
    { name: "Learn", url: absoluteUrl(`/${LEARN_SEGMENT}/`, origin) },
    { name: tutorial.title, url: canonical },
  ]);

  const body = `    <div class="shell shell--learnpage">
${renderTopnav(prefix, learnHref)}
      <main class="main">
        ${renderCrumbs([
          { name: "Home", href: prefix },
          { name: "Learn", href: learnHref },
          { name: tutorial.title },
        ])}
        <article class="tutorial learnpage-article">
          <div class="hero__head">
            <div class="hero__lead">
              <p class="hero__eyebrow">Learn · ${esc(tutorial.minutes)} min read</p>
              <h1 class="hero__title">${esc(tutorial.title)}</h1>
            </div>
          </div>
          <p class="note tutorial-index__lede">${esc(tutorial.summary)}</p>
          ${renderStaticSections(tutorial)}
          ${renderCtaCard(prefix, `${LEARN_SEGMENT}/${tutorial.slug}`)}
          ${renderMoreTutorials(pages, slug, learnHref)}
        </article>
      </main>
${renderFooter(prefix)}
    </div>`;

  return renderDocument({
    title,
    description,
    canonical,
    prefix,
    cssFile,
    structuredData: [article, trail],
    body,
    origin,
  });
}

/** The /learn/ hub: the crawl path from the home page to every tutorial. */
export function renderLearnIndexPage({ pages = [], origin = SITE_ORIGIN, cssFile, lastmod } = {}) {
  const path = `/${LEARN_SEGMENT}/`;
  const canonical = absoluteUrl(path, origin);
  const title = `${INDEX_TITLE} | ${SITE_NAME}`;
  const prefix = INDEX_PREFIX;

  const collection = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: INDEX_TITLE,
    description: INDEX_DESCRIPTION,
    url: canonical,
    inLanguage: "en-GB",
    isPartOf: { "@type": "WebSite", name: SITE_NAME, url: absoluteUrl("/", origin) },
    ...(lastmod ? { dateModified: lastmod } : {}),
    mainEntity: {
      "@type": "ItemList",
      itemListElement: pages.map((page, index) => ({
        "@type": "ListItem",
        position: index + 1,
        name: page.tutorial.title,
        url: absoluteUrl(page.path, origin),
      })),
    },
  };

  const trail = breadcrumbs([
    { name: "Home", url: absoluteUrl("/", origin) },
    { name: "Learn", url: canonical },
  ]);

  const cards = pages
    .map(
      (page) => `<a class="card tutorial-card learnpage-card" href="${page.slug}/">
            <span class="tutorial-card__head">
              <span class="card__title">${esc(page.tutorial.title)}</span>
              <span class="chip tutorial-card__minutes">${esc(page.tutorial.minutes)} min</span>
            </span>
            <span class="note">${esc(page.tutorial.summary)}</span>
          </a>`,
    )
    .join("");

  const body = `    <div class="shell shell--learnpage">
${renderTopnav(prefix, "./")}
      <main class="main">
        ${renderCrumbs([{ name: "Home", href: prefix }, { name: "Learn" }])}
        <div class="tutorial learnpage-article">
          <div class="hero__head">
            <div class="hero__lead">
              <p class="hero__eyebrow">Learn</p>
              <h1 class="hero__title">Guides</h1>
            </div>
          </div>
          <p class="note tutorial-index__lede">${esc(INDEX_LEDE)}</p>
          <a class="card tutorial-card tutorial-card--demo learnpage-card" href="${prefix}#demo">
            <span class="tutorial-card__head">
              <span class="card__title">Try a 5-minute draft</span>
              <span class="chip tutorial-card__minutes">No sign-in</span>
            </span>
            <span class="note">The fastest way to learn the format: draft a squad against bots and watch a season play out.</span>
          </a>
          <div class="tutorial-grid">${cards || `<p class="note">No guides yet.</p>`}</div>
        </div>
      </main>
${renderFooter(prefix)}
    </div>`;

  return renderDocument({
    title,
    description: INDEX_DESCRIPTION,
    canonical,
    prefix,
    cssFile,
    structuredData: [collection, trail],
    body,
    origin,
  });
}

/**
 * The Learn links injected into index.html's <noscript> block at build time.
 *
 * Generated rather than hand-written for the same reason the pages are: adding
 * a tutorial must not require remembering to edit index.html. This is the
 * crawl path that needs no JavaScript at all; the app footer carries the same
 * links for clients that do render.
 */
export function renderNoscriptLearnLinks(pages = []) {
  if (!pages.length) return "";
  const items = pages
    .map((page) => `<li><a href="${LEARN_SEGMENT}/${page.slug}/">${esc(page.tutorial.title)}</a></li>`)
    .join("\n            ");
  return `<p>Guides you can read without JavaScript:</p>
          <ul>
            ${items}
          </ul>`;
}

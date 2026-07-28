// URL derivation and sitemap generation for the pre-rendered Learn pages.
//
// The app itself is hash-routed and client-rendered, so it has exactly one
// crawlable URL. The tutorials in src/tutorials.js are the only content on the
// site with real organic search demand, so they are also emitted at build time
// as standalone static pages under /learn/, one per tutorial, whose prose is
// in the initial HTML rather than injected by JavaScript.
//
// Everything here is pure: given TUTORIALS it produces paths, absolute URLs and
// sitemap XML. scripts/build-seo-pages.mjs is the only thing that touches disk,
// so slug and sitemap behaviour is unit-testable without a build.
//
// URL slug vs tutorial slug: a tutorial's own `slug` field is its in-app route
// id (`#learn/<slug>`, `data-tutorial-open="<slug>"`) and is deliberately
// terse ("waivers"). The public page slug is derived from the TITLE instead,
// because that is the string carrying the search terms ("how-waivers-work").
// Consequence worth knowing: renaming a tutorial's title changes its public
// URL, so a retitle wants a redirect or a deliberate acceptance of the churn.

export const SITE_ORIGIN = "https://kickoffdraft.com";

// Path segment the tutorial pages live under. One place, since the sitemap,
// the page renderers, the in-app footer links and the dev middleware all have
// to agree on it.
export const LEARN_SEGMENT = "learn";

/**
 * Lowercase hyphenated slug: strips diacritics, drops apostrophes rather than
 * turning "manager's" into "manager-s", and collapses everything else that is
 * not a letter or a digit into single hyphens.
 */
export function slugify(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u0027\u2018\u2019]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Page slug for one tutorial: the title, falling back to the tutorial's own
 * route slug when the title slugifies to nothing (an emoji-only title, say).
 */
export function learnPageSlug(tutorial) {
  return slugify(tutorial?.title) || slugify(tutorial?.slug) || "";
}

export const LEARN_INDEX_PATH = `/${LEARN_SEGMENT}/`;

/**
 * Every tutorial as a page descriptor: `{ tutorial, slug, path }`.
 *
 * Derived from the array it is handed, never a hardcoded list, so adding an
 * entry to TUTORIALS adds a page, a sitemap URL and a set of cross-links with
 * no further edits. Two tutorials whose titles slugify identically would
 * otherwise silently overwrite each other's HTML file, so a collision falls
 * back to the tutorial's route slug and then to a numeric suffix.
 * A tutorial with no usable slug at all is dropped rather than emitted at
 * "/learn//".
 */
export function learnPages(tutorials = []) {
  const taken = new Set();
  const pages = [];
  for (const tutorial of tutorials) {
    const base = learnPageSlug(tutorial);
    if (!base) continue;
    let slug = base;
    if (taken.has(slug)) {
      const routeSlug = slugify(tutorial?.slug);
      slug = routeSlug && !taken.has(routeSlug) ? routeSlug : "";
      for (let n = 2; !slug; n += 1) {
        if (!taken.has(`${base}-${n}`)) slug = `${base}-${n}`;
      }
    }
    taken.add(slug);
    pages.push({ tutorial, slug, path: `/${LEARN_SEGMENT}/${slug}/` });
  }
  return pages;
}

/** Absolute URL for a root-relative path, for canonical/Open Graph/sitemap use. */
export function absoluteUrl(path, origin = SITE_ORIGIN) {
  return `${String(origin).replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

function escapeXml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&apos;",
  })[char]);
}

/**
 * Sitemap XML from `[{ loc, lastmod? }]`. A missing lastmod is omitted rather
 * than faked, since a wrong lastmod is worse than none: crawlers that learn a
 * date is meaningless start ignoring it.
 */
export function buildSitemap(entries = []) {
  const urls = entries
    .filter((entry) => entry && entry.loc)
    .map((entry) => {
      const lastmod = entry.lastmod ? `\n    <lastmod>${escapeXml(entry.lastmod)}</lastmod>` : "";
      return `  <url>\n    <loc>${escapeXml(entry.loc)}</loc>${lastmod}\n  </url>`;
    })
    .join("\n");
  const body = urls ? `${urls}\n` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}</urlset>\n`;
}

/**
 * Every URL the built site actually serves as a page: the app itself, the
 * Learn hub, and one entry per tutorial. `lastmod` values are supplied by the
 * caller (the build script resolves them from git) so this stays pure.
 */
export function sitemapEntries({ tutorials = [], origin = SITE_ORIGIN, homeLastmod, learnLastmod } = {}) {
  const entries = [{ loc: absoluteUrl("/", origin), lastmod: homeLastmod }];
  entries.push({ loc: absoluteUrl(LEARN_INDEX_PATH, origin), lastmod: learnLastmod });
  for (const page of learnPages(tutorials)) {
    entries.push({ loc: absoluteUrl(page.path, origin), lastmod: learnLastmod });
  }
  return entries;
}

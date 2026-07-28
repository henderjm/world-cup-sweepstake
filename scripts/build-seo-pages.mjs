// Build-time generator for the crawlable /learn/ pages and sitemap.xml.
//
// Runs from vite.config.js's `seo-learn-pages` plugin at closeBundle, so it is
// part of `npm run build` and a deploy cannot ship a stale sitemap or a
// tutorial with no page. The only source of content is src/tutorials.js: adding
// an entry there adds a page, a sitemap URL, cross-links from its sibling
// pages, and the noscript link on the home page, with no edit here.
//
// This module is the only part of the Learn-page pipeline that touches disk or
// shells out. The slug, URL, sitemap and HTML logic all live in the pure
// src/learnSeo.js and src/learnPageView.js, which is what test/learn-seo.test.js
// and test/learn-page-view.test.js exercise.

import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { TUTORIALS } from "../src/tutorials.js";
import { SITE_ORIGIN, LEARN_SEGMENT, buildSitemap, learnPages, sitemapEntries } from "../src/learnSeo.js";
import { renderLearnArticlePage, renderLearnIndexPage } from "../src/learnPageView.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function todayIso(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/**
 * The date a tracked file last changed, as YYYY-MM-DD, from git.
 *
 * A lastmod is only worth publishing if it means something, so it comes from
 * the commit that last touched the content rather than from the clock. Two
 * ways this legitimately returns nothing: git is unavailable, or the checkout
 * is shallow enough that the file's last commit is not in it (GitHub Actions
 * checks out at depth 1 by default). Both fall back to the build date, which
 * is the honest answer when the real one is unknown.
 */
export function lastModified(file, { cwd = REPO_ROOT, now = new Date() } = {}) {
  try {
    const out = execFileSync("git", ["log", "-1", "--format=%cs", "--", file], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(out)) return out;
  } catch {
    // Not a git checkout, or git is not installed. Fall through.
  }
  return todayIso(now);
}

/**
 * Writes /learn/index.html, /learn/<slug>/index.html per tutorial and
 * sitemap.xml into `outDir`.
 *
 * `cssFile` is the built stylesheet's path relative to the site root (Vite
 * hashes it, so the plugin reads the real name out of the bundle and hands it
 * over). The page renderers prefix it with each page's own way back to the
 * root, so nothing here assumes a domain root.
 */
export async function buildSeoPages({
  outDir,
  cssFile,
  tutorials = TUTORIALS,
  origin = SITE_ORIGIN,
  now = new Date(),
} = {}) {
  if (!cssFile) throw new Error("buildSeoPages needs the built stylesheet path (cssFile)");

  const pages = learnPages(tutorials);
  const learnLastmod = lastModified("src/tutorials.js", { now });
  const homeLastmod = lastModified("index.html", { now });

  const written = [];
  const learnDir = path.join(outDir, LEARN_SEGMENT);
  await mkdir(learnDir, { recursive: true });

  const indexHtml = renderLearnIndexPage({ pages, origin, cssFile, lastmod: learnLastmod });
  const indexPath = path.join(learnDir, "index.html");
  await writeFile(indexPath, indexHtml, "utf8");
  written.push(indexPath);

  for (const page of pages) {
    const dir = path.join(learnDir, page.slug);
    await mkdir(dir, { recursive: true });
    const html = renderLearnArticlePage({ page, pages, origin, cssFile, lastmod: learnLastmod });
    const file = path.join(dir, "index.html");
    await writeFile(file, html, "utf8");
    written.push(file);
  }

  const sitemap = buildSitemap(sitemapEntries({ tutorials, origin, homeLastmod, learnLastmod }));
  const sitemapPath = path.join(outDir, "sitemap.xml");
  await writeFile(sitemapPath, sitemap, "utf8");
  written.push(sitemapPath);

  return { pages, written, sitemap };
}

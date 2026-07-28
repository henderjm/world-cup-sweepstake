import { cp, mkdir } from "node:fs/promises";

import { defineConfig, loadEnv } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

import { TUTORIALS } from "./src/tutorials.js";
import { learnPages } from "./src/learnSeo.js";
import { renderLearnArticlePage, renderLearnIndexPage, renderNoscriptLearnLinks } from "./src/learnPageView.js";

// Pre-rendered Learn pages. The app is hash-routed and client-rendered, so
// without this the whole site is one crawlable URL with almost no indexable
// text, while the tutorials are the only content on it with real organic search
// demand. See src/learnSeo.js for the URL scheme and scripts/build-seo-pages.mjs
// for the generation itself.
//
// In dev the same renderers are served from middleware, so /learn/ links are
// live under `npm run dev` rather than 404ing until someone runs a build. Dev
// points the stylesheet at the source file; ?direct makes Vite serve real CSS
// rather than the JS module an `import "./styles.css"` would get.
const DEV_CSS_FILE = "src/styles.css?direct";

function seoLearnPages(analytics) {
  let cssFile = "";
  return {
    name: "seo-learn-pages",

    // The home page's crawl path into /learn/ for clients that run no
    // JavaScript at all. Injected rather than hand-written into index.html so
    // adding a tutorial can never leave the home page linking to a stale set.
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        return html.replace("<!--seo:learn-links-->", () => renderNoscriptLearnLinks(learnPages(TUTORIALS)));
      },
    },

    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const pathname = (req.url ?? "").split("?")[0];
        const match = /^\/learn\/(?:([^/]+)\/)?$/.exec(pathname);
        if (!match) return next();
        const pages = learnPages(TUTORIALS);
        const page = match[1] ? pages.find((candidate) => candidate.slug === match[1]) : null;
        if (match[1] && !page) return next();
        const html = page
          ? renderLearnArticlePage({ page, pages, cssFile: DEV_CSS_FILE, analytics })
          : renderLearnIndexPage({ pages, cssFile: DEV_CSS_FILE, analytics });
        res.setHeader("Content-Type", "text/html");
        res.end(await server.transformIndexHtml(pathname, html));
      });
    },

    // Vite hashes the stylesheet, so its real emitted name is only knowable
    // from the bundle. Captured here and used by closeBundle below.
    generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type === "asset" && file.fileName.endsWith(".css")) cssFile = file.fileName;
      }
    },

    async closeBundle() {
      const { buildSeoPages } = await import("./scripts/build-seo-pages.mjs");
      const { written } = await buildSeoPages({ outDir: "dist", cssFile, analytics });
      this.info?.(`wrote ${written.length} files (learn pages + sitemap)`);
    },
  };
}

export default defineConfig(({ mode }) => {
  // The Learn pages are generated in Node, outside the client bundle, so
  // import.meta.env is not available to them; the same two public client
  // tokens the app uses are read explicitly here and handed to the renderers.
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const analytics = { key: env.VITE_POSTHOG_KEY, host: env.VITE_POSTHOG_HOST };

  return {
    base: "./",
    plugins: [
      svelte(),
      seoLearnPages(analytics),
      {
        name: "copy-runtime-assets",
        async closeBundle() {
          await mkdir("dist", { recursive: true });
          await Promise.all([
            cp("assets", "dist/assets", { recursive: true }),
            cp("data", "dist/data", { recursive: true }),
            cp("sw.js", "dist/sw.js"),
            cp("site.webmanifest", "dist/site.webmanifest"),
            cp("robots.txt", "dist/robots.txt"),
            // sitemap.xml is deliberately NOT in this list, and no longer exists
            // at the repo root: it is generated straight into dist by the
            // seo-learn-pages plugin above, from the same TUTORIALS array the
            // pages come from, so it cannot fall out of date with them.
            // GitHub Pages custom domain: this file must ship in every deploy or
            // the custom domain setting unsets itself on the next Pages publish.
            cp("CNAME", "dist/CNAME"),
          ]);
        },
      },
    ],
  };
});

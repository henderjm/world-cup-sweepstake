import { cp, mkdir } from "node:fs/promises";

import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  base: "./",
  plugins: [
    svelte(),
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
          cp("sitemap.xml", "dist/sitemap.xml"),
          // GitHub Pages custom domain: this file must ship in every deploy or
          // the custom domain setting unsets itself on the next Pages publish.
          cp("CNAME", "dist/CNAME"),
        ]);
      },
    },
  ],
});

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
        ]);
      },
    },
  ],
});

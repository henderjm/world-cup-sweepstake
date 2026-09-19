import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInThisContext } from 'node:vm';

const files = process.argv.slice(2);
if (!files.length) throw new Error('Usage: node scripts/qa/run-headless.mjs <qa-script.js> [...]');

const modulePath = process.env.PLAYWRIGHT_MODULE_PATH;
const { chromium } = await import(modulePath ? pathToFileURL(resolve(modulePath)).href : 'playwright');
const browser = await chromium.launch({ headless: true });
try {
  for (const file of files) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    try {
      const source = await readFile(file, 'utf8');
      const run = runInThisContext(source, { filename: resolve(file) });
      if (typeof run !== 'function') throw new Error(`${file} must contain an async function accepting a page`);
      const result = await run(await context.newPage());
      console.log(JSON.stringify({ file, headless: true, result }, null, 2));
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
}

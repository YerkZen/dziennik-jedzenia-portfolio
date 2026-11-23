import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";

// Reuse the Lucide Leaf already used by AppShell (ISC, lucide.dev).
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#286846"/><g transform="translate(26 24) scale(2)" fill="none" stroke="#ffffff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z"/><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/></g></svg>`;
await mkdir("public/icons", { recursive: true });
await writeFile("public/icons/leaf.svg", svg);
await writeFile("public/icons/NOTICE.txt", await readFile("node_modules/lucide-react/LICENSE"));
const browser = await chromium.launch({ args: ["--no-sandbox"] });
try {
  const page = await browser.newPage();
  for (const [name, size] of [
    ["icon-192", 192],
    ["icon-512", 512],
    ["maskable-512", 512],
    ["apple-touch-180", 180],
  ]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<style>body{margin:0}svg{display:block;width:100vw;height:100vh}</style>${svg}`,
    );
    await page.screenshot({ path: `public/icons/${name}.png` });
  }
} finally {
  await browser.close();
}

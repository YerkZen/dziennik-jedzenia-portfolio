import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve, relative } from "node:path";
import type { Plugin } from "vite";

/** Version the exact public build; never discover URLs from user/API responses. */
export function publicPwa(): Plugin {
  let directory = "";
  let root = "";
  return {
    name: "public-only-pwa",
    apply: "build",
    configResolved(config) {
      root = config.root;
      directory = resolve(root, config.build.outDir);
    },
    closeBundle() {
      const walk = (folder: string): string[] =>
        readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
          const filename = resolve(folder, entry.name);
          return entry.isDirectory() ? walk(filename) : [filename];
        });
      const files = walk(directory)
        .filter(
          (file) =>
            /\.(?:js|css|woff2|png|ico|html|webmanifest)$/.test(file) &&
            relative(directory, file) !== "sw.js",
        )
        .sort();
      const template = readFileSync(resolve(root, "scripts/pwa/service-worker.js"), "utf8");
      const hash = createHash("sha256").update(template);
      for (const file of files)
        hash.update(relative(directory, file)).update("\0").update(readFileSync(file));
      const urls = files.map((file) => `/${relative(directory, file).replaceAll("\\", "/")}`);
      writeFileSync(
        resolve(directory, "sw.js"),
        template
          .replace("__PUBLIC_CACHE_VERSION__", hash.digest("hex").slice(0, 20))
          .replace("/* __PUBLIC_ASSETS__ */ []", JSON.stringify(urls)),
      );
    },
  };
}

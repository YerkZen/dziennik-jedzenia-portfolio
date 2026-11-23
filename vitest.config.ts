import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { fileURLToPath } from "node:url";
export default defineConfig({
  test: {
    projects: [
      {
        plugins: [react()],
        resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
        test: {
          name: "app",
          environment: "jsdom",
          globals: true,
          setupFiles: ["./src/test/setup.ts"],
          include: ["src/**/*.{test,spec}.{ts,tsx}", "tests/unit/**/*.test.ts"],
        },
      },
      {
        plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.test.jsonc" } })],
        test: { name: "workerd", include: ["tests/worker/**/*.test.ts"] },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}", "worker/**/*.ts"],
      exclude: ["src/**/*.test.*", "src/test/**", "src/routeTree.gen.ts"],
    },
  },
});

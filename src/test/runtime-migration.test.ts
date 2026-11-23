import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
const root = process.env["MIGRATION_ROOT"] || process.cwd();
const read = (file: string) => readFileSync(resolve(root, file), "utf8");
describe("SPA runtime migration (technical, no domain AC)", () => {
  it("provides a static HTML entry and createRoot bootstrap", () => {
    expect(existsSync(resolve(root, "index.html"))).toBe(true);
    expect(read("index.html")).toContain("/src/main.tsx");
    expect(read("src/main.tsx")).toContain("createRoot");
    expect(read("src/main.tsx")).toContain("RouterProvider");
  });
  it("does not install SSR or Lovable runtime", () => {
    const pkg = JSON.parse(read("package.json"));
    const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(names.filter((name) => /lovable|react-start|^nitro$/.test(name))).toEqual([]);
  });
  it("keeps document metadata in HTML and uses local font files", () => {
    expect(existsSync(resolve(root, "index.html"))).toBe(true);
    expect(read("index.html")).toContain('lang="pl"');
    expect(read("index.html")).toContain("viewport-fit=cover");
    expect(read("src/routes/__root.tsx")).not.toMatch(
      /HeadContent|Scripts|shellComponent|reportLovableError/,
    );
    expect(read("public/fonts/fonts.css")).toContain("@font-face");
    expect(read("public/fonts/fonts.css")).not.toMatch(/https?:\/\//);
  });
});

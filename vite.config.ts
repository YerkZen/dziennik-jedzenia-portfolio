import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { publicPwa } from "./scripts/pwa/build-plugin";
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const cert = env["DEV_TLS_CERT"];
  const key = env["DEV_TLS_KEY"];
  const appOrigin = env["APP_ORIGIN"];
  const containerOrigin = appOrigin?.startsWith("https://localhost:")
    ? appOrigin.replace("https://localhost:", "https://frontend:")
    : undefined;
  return {
    plugins: [
      tanstackRouter({
        target: "react",
        autoCodeSplitting: true,
        // Logout must show the public login screen even if this tab never loaded it online.
        codeSplittingOptions: {
          splitBehavior: ({ routeId }) => (routeId === "/logowanie" ? [] : undefined),
        },
      }),
      react(),
      tailwindcss(),
      publicPwa(),
    ],
    resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
    server: {
      host: "0.0.0.0",
      port: 5173,
      strictPort: true,
      allowedHosts: ["frontend"],
      ...(cert && key ? { https: { cert: readFileSync(cert), key: readFileSync(key) } } : {}),
      proxy: {
        "/api": {
          target: env["WORKER_PROXY_URL"] || "http://127.0.0.1:8787",
          changeOrigin: false,
          configure: (proxy) => {
            proxy.on("proxyReq", (proxyRequest, request) => {
              const origin = request.headers.origin;
              if (typeof origin !== "string") return;
              if (origin === appOrigin) {
                proxyRequest.setHeader("Origin", origin);
                proxyRequest.setHeader("X-Dev-Verified-HTTPS", "1");
                return;
              }
              if (origin !== containerOrigin || !appOrigin) return;
              // The browser uses the Compose DNS alias; Worker still validates its configured local origin.
              proxyRequest.setHeader("Origin", `http://${new URL(appOrigin).host}`);
              proxyRequest.setHeader("X-Dev-Verified-HTTPS", "1");
            });
          },
        },
      },
    },
  };
});

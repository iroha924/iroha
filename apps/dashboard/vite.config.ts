import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "src"),
    },
  },
  // Dev HMR proxies /api to the local API (run `pnpm dashboard:api`), keeping
  // the browser same-origin so the real cookie + anti-CSRF auth works
  // unchanged. `changeOrigin: false` preserves the Host so `Origin === Host`.
  server: {
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${process.env.IROHA_DEV_API_PORT ?? "5178"}`,
        changeOrigin: false,
      },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
  },
});

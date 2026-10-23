import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));

// In development the API runs separately (npm run dev:server, port 3200);
// Vite serves the web app on 5174 and forwards /api to it. In production the
// API serves the built files itself, so there is one origin and no proxy.
export default defineConfig({
  root: here,
  plugins: [react(), tailwindcss()],
  build: { outDir: path.join(here, "dist"), emptyOutDir: true },
  server: {
    port: 5174,
    strictPort: true,
    proxy: { "/api": { target: process.env["API_URL"] ?? "http://127.0.0.1:3200", changeOrigin: false } },
  },
});

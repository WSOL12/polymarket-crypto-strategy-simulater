import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiProxy = "http://localhost:3000";
const wsProxy = "http://localhost:3001";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": apiProxy,
      "/ws": { target: wsProxy, ws: true, changeOrigin: true },
      "/assets": apiProxy,
    },
  },
  /** Without this, `vite preview` serves index.html for `/api/*` → JSON parse errors. */
  preview: {
    port: 4173,
    strictPort: true,
    proxy: {
      "/api": apiProxy,
      "/ws": { target: wsProxy, ws: true, changeOrigin: true },
      "/assets": apiProxy,
    },
  },
});

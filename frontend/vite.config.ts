import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": "http://localhost:3000",
      "/ws": { target: "http://localhost:3001", ws: true, changeOrigin: true },
      "/assets": "http://localhost:3000"
    }
  }
});

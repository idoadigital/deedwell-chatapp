import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: "0.0.0.0",
    allowedHosts: true,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
      "/sites": {
        target: "http://localhost:8788",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/sites/, ""),
      },
    },
  },
  preview: {
    port: 5173,
    strictPort: true,
    host: "0.0.0.0",
    allowedHosts: true,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
      "/sites": {
        target: "http://localhost:8788",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/sites/, ""),
      },
    },
  },
  build: {
    target: "es2022",
    outDir: "dist",
  },
});

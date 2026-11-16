import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: resolve(__dirname, "dist"),
    emptyOutDir: true,
    sourcemap: false,
    cssCodeSplit: false,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:4190",
    },
  },
});

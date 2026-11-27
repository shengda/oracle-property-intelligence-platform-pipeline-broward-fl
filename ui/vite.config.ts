import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const api = process.env.ORACLE_API ?? "http://127.0.0.1:4317";

export default defineConfig({
  root: path.resolve(import.meta.dirname),
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 1500 },
  server: {
    port: 5317,
    fs: { allow: [path.resolve(import.meta.dirname, "..")] },
    proxy: { "/api": api, "/mcp": api, "/files": api },
  },
  optimizeDeps: { exclude: ["@duckdb/duckdb-wasm"] },
});

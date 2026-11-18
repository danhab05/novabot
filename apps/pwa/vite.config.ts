import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@novabot/shared": fileURLToPath(new URL("../../packages/shared/src/index.ts", import.meta.url)) } },
  build: { target: "es2020", outDir: "dist", emptyOutDir: true, reportCompressedSize: true, sourcemap: false },
  server: { proxy: { "/api": { target: "http://127.0.0.1:8797", ws: true }, "/auth": "http://127.0.0.1:8797", "/internal": "http://127.0.0.1:8797" } },
});

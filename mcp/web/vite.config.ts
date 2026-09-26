import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Builds the OAuth connect page into dist/connect/, served by the Worker's
// static assets at /connect/.
export default defineConfig({
  root: __dirname,
  base: "/connect/",
  plugins: [react()],
  build: { outDir: "dist/connect", emptyOutDir: true },
});

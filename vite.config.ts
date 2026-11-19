import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cp, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Plugin } from "vite";

const EXCALIDRAW_FONTS = fileURLToPath(
  new URL("./node_modules/@excalidraw/excalidraw/dist/prod/fonts", import.meta.url),
);

/**
 * Self-host Excalidraw's fonts under `/fonts/` so the editor never falls
 * back to fetching them from esm.sh (see src/lib/excalidrawAssets.ts).
 * Dev: served straight from node_modules. Build: copied into outDir.
 */
function excalidrawFonts(): Plugin {
  let outDir = "dist";
  return {
    name: "excalidraw-fonts",
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use("/fonts", async (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? "").split("?")[0]);
        const file = path.join(EXCALIDRAW_FONTS, rel);
        if (!file.startsWith(EXCALIDRAW_FONTS + path.sep)) return next();
        try {
          if (!(await stat(file)).isFile()) return next();
        } catch {
          return next();
        }
        res.setHeader(
          "Content-Type",
          file.endsWith(".woff2") ? "font/woff2" : "application/octet-stream",
        );
        createReadStream(file).pipe(res);
      });
    },
    async writeBundle() {
      await cp(EXCALIDRAW_FONTS, path.join(outDir, "fonts"), { recursive: true });
    },
  };
}

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), excalidrawFonts()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));

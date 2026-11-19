// Point Excalidraw at the self-hosted fonts (copied to /fonts/ by the
// `excalidraw-fonts` plugin in vite.config.ts). Must run before the
// Excalidraw module evaluates, so it's a classic script in index.html rather
// than an import. Without it Excalidraw fetches fonts from esm.sh, which
// breaks offline use and the privacy promise (and is blocked by the CSP).
globalThis.EXCALIDRAW_ASSET_PATH = "/";

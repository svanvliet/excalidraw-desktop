/**
 * Validation for the `add_image` canvas tool (docs/ai-integration.md § Agent tool set).
 *
 * Image bytes always arrive inline (base64 + mimeType): a `path` argument is resolved and read by
 * the Rust MCP server (src-tauri/src/agent/mcp/images.rs), which only allows files inside the
 * conversation's folders. This module re-checks everything it receives: the size cap, that the
 * bytes match the declared type, and that SVG carries no script or external references.
 */
import { base64ToBytes } from "../../lib/fileFormat";
import { ToolError } from "./draft";

/** Mirrors `MAX_IMAGE_BYTES` in src-tauri/src/agent/mcp/images.rs. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export const IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
] as const;
export type ImageMime = (typeof IMAGE_MIME_TYPES)[number];

export interface PreparedImage {
  mimeType: ImageMime;
  dataURL: string;
  fileId: string;
  /** Intrinsic size, when the header declares one. */
  natural?: { width: number; height: number };
}

const ALIASES: Record<string, ImageMime> = {
  "image/jpg": "image/jpeg",
  "image/svg": "image/svg+xml",
  png: "image/png",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

export function normalizeMime(raw: unknown): ImageMime {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new ToolError(
      `"mimeType" is required with "data" (one of ${IMAGE_MIME_TYPES.join(", ")})`,
    );
  }
  const m = raw.trim().toLowerCase();
  const mime = (IMAGE_MIME_TYPES as readonly string[]).includes(m) ? (m as ImageMime) : ALIASES[m];
  if (!mime) {
    throw new ToolError(
      `Unsupported image type "${raw}"; use one of ${IMAGE_MIME_TYPES.join(", ")}`,
    );
  }
  return mime;
}

const startsWith = (b: Uint8Array, sig: readonly number[], at = 0) =>
  sig.every((v, i) => b[at + i] === v);
const ascii = (b: Uint8Array, from: number, to: number) =>
  String.fromCharCode(...b.subarray(from, to));

/** Detect the image type from magic bytes (SVG: markup whose root is `<svg`). */
export function sniffImage(b: Uint8Array): ImageMime | undefined {
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(b, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a") return "image/gif";
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") return "image/webp";
  const head = new TextDecoder()
    .decode(b.subarray(0, 4096))
    .replace(/^\uFEFF/, "")
    .trimStart();
  if (head.startsWith("<") && /<svg[\s>/]/i.test(head)) return "image/svg+xml";
  return undefined;
}

const u16be = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!;
const u16le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8);
const u24le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
const u32be = (b: Uint8Array, i: number) =>
  ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;

/** Intrinsic pixel size from the raster header, if it can be read. */
export function rasterSize(
  b: Uint8Array,
  mime: ImageMime,
): { width: number; height: number } | undefined {
  try {
    let size: { width: number; height: number } | undefined;
    if (mime === "image/png" && b.length >= 24) {
      size = { width: u32be(b, 16), height: u32be(b, 20) };
    } else if (mime === "image/gif" && b.length >= 10) {
      size = { width: u16le(b, 6), height: u16le(b, 8) };
    } else if (mime === "image/jpeg") {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) return undefined;
        const marker = b[i + 1]!;
        const len = u16be(b, i + 2);
        const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
        if (isSof) {
          size = { width: u16be(b, i + 7), height: u16be(b, i + 5) };
          break;
        }
        i += 2 + len;
      }
    } else if (mime === "image/webp" && b.length >= 30) {
      const chunk = ascii(b, 12, 16);
      if (chunk === "VP8 ") size = { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
      else if (chunk === "VP8L") {
        const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
        size = { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
      } else if (chunk === "VP8X") size = { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
    }
    return size && size.width > 0 && size.height > 0 ? size : undefined;
  } catch {
    return undefined;
  }
}

const SAFE_HREF = /^(#|data:image\/(png|jpe?g|gif|webp);)/i;

/**
 * Reject SVG that could run script or reach the network. Excalidraw renders images through
 * `<img>` (which never runs SVG script), but the file is also saved and exported, so we refuse
 * rather than silently strip.
 */
export function checkSvg(text: string): { width: number; height: number } | undefined {
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  const root = doc.documentElement;
  if (doc.getElementsByTagName("parsererror").length || root?.localName !== "svg") {
    throw new ToolError(`The SVG could not be parsed (its root must be <svg>)`);
  }
  for (const el of [root, ...Array.from(root.getElementsByTagName("*"))]) {
    const name = el.localName.toLowerCase();
    if (name === "script" || name === "foreignobject") {
      throw new ToolError(`SVG with <${el.localName}> is not allowed`);
    }
    for (const attr of Array.from(el.attributes)) {
      const a = attr.name.toLowerCase();
      if (a.startsWith("on"))
        throw new ToolError(`SVG event handler "${attr.name}" is not allowed`);
      if ((a === "href" || a.endsWith(":href")) && !SAFE_HREF.test(attr.value.trim())) {
        throw new ToolError(
          `SVG link "${attr.value.slice(0, 60)}" is not allowed (only #fragment or embedded data:image)`,
        );
      }
      if (/url\(\s*['"]?(?!#)/i.test(attr.value) && a !== "xmlns") {
        throw new ToolError(`SVG external url() reference in "${attr.name}" is not allowed`);
      }
    }
    if (name === "style" && /@import|url\(\s*['"]?(?!#|data:image\/)/i.test(el.textContent ?? "")) {
      throw new ToolError(`SVG <style> with @import or external url() is not allowed`);
    }
  }
  const num = (v: string | null) => {
    const n = v && /^\s*[\d.]+\s*(px)?\s*$/.test(v) ? parseFloat(v) : NaN;
    return n > 0 ? n : undefined;
  };
  const w = num(root.getAttribute("width"));
  const h = num(root.getAttribute("height"));
  if (w && h) return { width: w, height: h };
  const vb = (root.getAttribute("viewBox") ?? "")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (vb.length === 4 && vb[2]! > 0 && vb[3]! > 0) return { width: vb[2]!, height: vb[3]! };
  return undefined;
}

async function sha1Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (x) => x.toString(16).padStart(2, "0")).join("");
}

/** Validate `data` + `mimeType` and build the Excalidraw file payload. */
export async function prepareImage(args: Record<string, unknown>): Promise<PreparedImage> {
  if (args.path !== undefined) {
    throw new ToolError(
      `"path" must be resolved by the app before it reaches the canvas; retry the call, or pass "data" + "mimeType"`,
    );
  }
  if (typeof args.data !== "string" || !args.data.trim()) {
    throw new ToolError(
      `Pass "path" (a file in your working or attached folder) or "data" + "mimeType"`,
    );
  }
  const declared = normalizeMime(args.mimeType);
  let b64 = args.data.trim();
  const prefix = /^data:([^;,]+);base64,/i.exec(b64);
  if (prefix) b64 = b64.slice(prefix[0].length);
  b64 = b64.replace(/\s+/g, "");
  if (Math.floor((b64.length * 3) / 4) > MAX_IMAGE_BYTES + 3) {
    throw new ToolError(`Image is larger than the 10 MB limit`);
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) throw new ToolError(`"data" is not valid base64`);
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(b64);
  } catch {
    throw new ToolError(`"data" is not valid base64`);
  }
  if (!bytes.length) throw new ToolError(`"data" is empty`);
  if (bytes.length > MAX_IMAGE_BYTES) throw new ToolError(`Image is larger than the 10 MB limit`);
  const actual = sniffImage(bytes);
  if (!actual) {
    throw new ToolError(
      `The data is not a supported image (expected ${IMAGE_MIME_TYPES.join(", ")})`,
    );
  }
  if (actual !== declared) {
    throw new ToolError(`mimeType says ${declared} but the data is ${actual}`);
  }
  const natural =
    actual === "image/svg+xml"
      ? checkSvg(new TextDecoder().decode(bytes))
      : rasterSize(bytes, actual);
  const dataURL = `data:${actual};base64,${b64}`;
  return { mimeType: actual, dataURL, fileId: await sha1Hex(dataURL), natural };
}

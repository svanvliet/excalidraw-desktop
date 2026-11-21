/**
 * WebKit (WKWebView on macOS, Safari) has no `CanvasRenderingContext2D.filter`.
 * Excalidraw's dark mode inverts the whole canvas with a CSS filter and then
 * re-inverts raster images with `ctx.filter = "invert(100%) hue-rotate(180deg)
 * saturate(1.25)"` before `drawImage`. Without native support that second step
 * is a no-op, so photos render as negatives. This polyfill tracks `filter` as
 * context state (honouring save/restore) and applies the supported color
 * functions to `drawImage` sources via a cached pixel transform. Shapes, fills
 * and text are unaffected, matching the previous behavior on WebKit.
 */

export type FilterOp =
  | { kind: "invert"; amount: number }
  | { kind: "hue-rotate"; degrees: number }
  | { kind: "saturate"; amount: number }
  | { kind: "grayscale"; amount: number }
  | { kind: "brightness"; amount: number };

const FN_RE = /([a-z-]+)\(\s*([^)]*)\s*\)/g;

function parseAmount(raw: string): number | null {
  const m = /^(-?[\d.]+)(%?)$/.exec(raw.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return m[2] === "%" ? n / 100 : n;
}

function parseAngle(raw: string): number | null {
  const m = /^(-?[\d.]+)(deg|rad|turn)?$/.exec(raw.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  if (m[2] === "rad") return (n * 180) / Math.PI;
  if (m[2] === "turn") return n * 360;
  return n;
}

/** Parses a CSS filter list. Returns null for `none`, empty, or anything unsupported. */
export function parseFilter(value: string): FilterOp[] | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "none") return null;
  const ops: FilterOp[] = [];
  let consumed = "";
  for (const m of trimmed.matchAll(FN_RE)) {
    consumed += m[0];
    const [, name, arg] = m;
    if (name === "hue-rotate") {
      const deg = parseAngle(arg);
      if (deg === null) return null;
      ops.push({ kind: "hue-rotate", degrees: deg });
      continue;
    }
    const amount = parseAmount(arg);
    if (amount === null) return null;
    if (name === "invert" || name === "grayscale") {
      ops.push({ kind: name, amount: Math.min(1, Math.max(0, amount)) });
    } else if (name === "saturate" || name === "brightness") {
      ops.push({ kind: name, amount: Math.max(0, amount) });
    } else {
      return null;
    }
  }
  if (consumed.replace(/\s+/g, "") !== trimmed.replace(/\s+/g, "")) return null;
  return ops.length ? ops : null;
}

type Mat3 = [number, number, number, number, number, number, number, number, number];

function hueRotateMatrix(degrees: number): Mat3 {
  const r = (degrees * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [
    0.213 + c * 0.787 - s * 0.213,
    0.715 - c * 0.715 - s * 0.715,
    0.072 - c * 0.072 + s * 0.928,
    0.213 - c * 0.213 + s * 0.143,
    0.715 + c * 0.285 + s * 0.14,
    0.072 - c * 0.072 - s * 0.283,
    0.213 - c * 0.213 - s * 0.787,
    0.715 - c * 0.715 + s * 0.715,
    0.072 + c * 0.928 + s * 0.072,
  ];
}

function saturateMatrix(s: number): Mat3 {
  return [
    0.213 + 0.787 * s,
    0.715 - 0.715 * s,
    0.072 - 0.072 * s,
    0.213 - 0.213 * s,
    0.715 + 0.285 * s,
    0.072 - 0.072 * s,
    0.213 - 0.213 * s,
    0.715 - 0.715 * s,
    0.072 + 0.928 * s,
  ];
}

function grayscaleMatrix(a: number): Mat3 {
  const k = 1 - a;
  return [
    0.2126 + 0.7874 * k,
    0.7152 - 0.7152 * k,
    0.0722 - 0.0722 * k,
    0.2126 - 0.2126 * k,
    0.7152 + 0.2848 * k,
    0.0722 - 0.0722 * k,
    0.2126 - 0.2126 * k,
    0.7152 - 0.7152 * k,
    0.0722 + 0.9278 * k,
  ];
}

const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

/** Applies the filter ops in place to non-premultiplied RGBA bytes (sRGB, clamped per step). */
export function applyFilterToPixels(data: Uint8ClampedArray, ops: FilterOp[]): void {
  for (let i = 0; i < data.length; i += 4) {
    let r = data[i];
    let g = data[i + 1];
    let b = data[i + 2];
    for (const op of ops) {
      if (op.kind === "invert") {
        const a = op.amount;
        r = r * (1 - a) + (255 - r) * a;
        g = g * (1 - a) + (255 - g) * a;
        b = b * (1 - a) + (255 - b) * a;
      } else if (op.kind === "brightness") {
        r = clamp255(r * op.amount);
        g = clamp255(g * op.amount);
        b = clamp255(b * op.amount);
      } else {
        const m =
          op.kind === "hue-rotate"
            ? hueRotateMatrix(op.degrees)
            : op.kind === "saturate"
              ? saturateMatrix(op.amount)
              : grayscaleMatrix(op.amount);
        const nr = clamp255(m[0] * r + m[1] * g + m[2] * b);
        const ng = clamp255(m[3] * r + m[4] * g + m[5] * b);
        const nb = clamp255(m[6] * r + m[7] * g + m[8] * b);
        r = nr;
        g = ng;
        b = nb;
      }
    }
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
  }
}

type Source = CanvasImageSource;

function sourceSize(src: Source): { w: number; h: number } | null {
  if (typeof HTMLImageElement !== "undefined" && src instanceof HTMLImageElement) {
    return { w: src.naturalWidth, h: src.naturalHeight };
  }
  if (typeof HTMLVideoElement !== "undefined" && src instanceof HTMLVideoElement) return null;
  const s = src as { width?: unknown; height?: unknown };
  if (typeof s.width === "number" && typeof s.height === "number") {
    return { w: s.width, h: s.height };
  }
  return null;
}

export interface PolyfillDeps {
  /** Creates a scratch canvas. Defaults to `document.createElement("canvas")`. */
  createCanvas?: () => HTMLCanvasElement;
}

const INSTALLED = Symbol.for("excalidrawDesktop.canvasFilterPolyfill");

/**
 * Installs the polyfill on `proto` when it lacks a native `filter`. Returns
 * true when installed. Safe to call more than once.
 */
export function installCanvasFilterPolyfill(
  proto: CanvasRenderingContext2D | undefined = typeof CanvasRenderingContext2D !== "undefined"
    ? CanvasRenderingContext2D.prototype
    : undefined,
  deps: PolyfillDeps = {},
): boolean {
  if (!proto) return false;
  const p = proto as CanvasRenderingContext2D & { [INSTALLED]?: true };
  if (p[INSTALLED]) return true;
  if (Reflect.has(proto, "filter")) return false;

  const createCanvas = deps.createCanvas ?? (() => document.createElement("canvas"));
  const state = new WeakMap<object, { current: string; stack: string[] }>();
  const cache = new WeakMap<object, Map<string, { canvas: HTMLCanvasElement; key: string }>>();
  const stateOf = (ctx: object) => {
    let s = state.get(ctx);
    if (!s) {
      s = { current: "none", stack: [] };
      state.set(ctx, s);
    }
    return s;
  };

  const filtered = (src: Source, filter: string, ops: FilterOp[]): Source => {
    const size = sourceSize(src);
    if (!size || size.w <= 0 || size.h <= 0) return src;
    const key = `${size.w}x${size.h}`;
    let perSource = cache.get(src as object);
    const hit = perSource?.get(filter);
    // Canvas sources can be redrawn; only cache immutable image sources.
    const cacheable = typeof HTMLImageElement !== "undefined" && src instanceof HTMLImageElement;
    if (cacheable && hit && hit.key === key) return hit.canvas;
    try {
      const canvas = createCanvas();
      canvas.width = size.w;
      canvas.height = size.h;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return src;
      ctx.drawImage(src, 0, 0);
      const img = ctx.getImageData(0, 0, size.w, size.h);
      applyFilterToPixels(img.data, ops);
      ctx.putImageData(img, 0, 0);
      if (cacheable) {
        if (!perSource) {
          perSource = new Map();
          cache.set(src as object, perSource);
        }
        perSource.set(filter, { canvas, key });
      }
      return canvas;
    } catch {
      // Tainted or undecodable sources fall back to an unfiltered draw.
      return src;
    }
  };

  const origSave = proto.save;
  const origRestore = proto.restore;
  const origDrawImage = proto.drawImage as (
    this: CanvasRenderingContext2D,
    ...a: unknown[]
  ) => void;

  Object.defineProperty(proto, "filter", {
    configurable: true,
    enumerable: true,
    get(this: CanvasRenderingContext2D) {
      return stateOf(this).current;
    },
    set(this: CanvasRenderingContext2D, v: string) {
      stateOf(this).current = String(v);
    },
  });
  proto.save = function save(this: CanvasRenderingContext2D) {
    const s = stateOf(this);
    s.stack.push(s.current);
    origSave.call(this);
  };
  proto.restore = function restore(this: CanvasRenderingContext2D) {
    const s = stateOf(this);
    if (s.stack.length) s.current = s.stack.pop() as string;
    origRestore.call(this);
  };
  proto.drawImage = function drawImage(this: CanvasRenderingContext2D, ...args: unknown[]) {
    const f = stateOf(this).current;
    const ops = f === "none" ? null : parseFilter(f);
    if (ops) args[0] = filtered(args[0] as Source, f, ops);
    return origDrawImage.apply(this, args);
  } as CanvasRenderingContext2D["drawImage"];
  p[INSTALLED] = true;
  return true;
}

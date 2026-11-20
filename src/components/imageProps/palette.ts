/**
 * Excalidraw 0.18's stroke colour palette (open-color shades 0/2/4/6/8, MIT), copied so the image
 * stroke picker offers exactly what the native one does. Excalidraw does not export its
 * ColorPicker or palette.
 */

export const TRANSPARENT = "transparent";

/** Shades per colour, lightest first; the picker shows index 3 (`DEFAULT_SHADE`) by default. */
export const STROKE_PALETTE: Record<string, string | readonly string[]> = {
  transparent: TRANSPARENT,
  white: "#ffffff",
  gray: ["#f8f9fa", "#e9ecef", "#ced4da", "#868e96", "#343a40"],
  black: "#1e1e1e",
  bronze: ["#f8f1ee", "#eaddd7", "#d2bab0", "#a18072", "#846358"],
  cyan: ["#e3fafc", "#99e9f2", "#3bc9db", "#15aabf", "#0c8599"],
  blue: ["#e7f5ff", "#a5d8ff", "#4dabf7", "#228be6", "#1971c2"],
  violet: ["#f3f0ff", "#d0bfff", "#9775fa", "#7950f2", "#6741d9"],
  grape: ["#f8f0fc", "#eebefa", "#da77f2", "#be4bdb", "#9c36b5"],
  pink: ["#fff0f6", "#fcc2d7", "#f783ac", "#e64980", "#c2255c"],
  green: ["#ebfbee", "#b2f2bb", "#69db7c", "#40c057", "#2f9e44"],
  teal: ["#e6fcf5", "#96f2d7", "#38d9a9", "#12b886", "#099268"],
  yellow: ["#fff9db", "#ffec99", "#ffd43b", "#fab005", "#f08c00"],
  orange: ["#fff4e6", "#ffd8a8", "#ffa94d", "#fd7e14", "#e8590c"],
  red: ["#fff5f5", "#ffc9c9", "#ff8787", "#fa5252", "#e03131"],
};

/** Excalidraw's DEFAULT_ELEMENT_STROKE_PICKS. */
export const STROKE_TOP_PICKS = ["#1e1e1e", "#e03131", "#2f9e44", "#1971c2", "#f08c00"] as const;

export const DEFAULT_SHADE = 4;
export const PALETTE_HOTKEYS = "qwertasdfgzxcvb";

export interface PaletteHit {
  name: string;
  /** Index into the colour's shades, or null for single-colour entries. */
  shade: number | null;
}

/** Where a colour sits in the palette (case-insensitive), if anywhere. */
export function findInPalette(color: string): PaletteHit | null {
  const c = color.toLowerCase();
  for (const [name, value] of Object.entries(STROKE_PALETTE)) {
    if (typeof value === "string") {
      if (value === c) return { name, shade: null };
    } else {
      const shade = value.indexOf(c);
      if (shade >= 0) return { name, shade };
    }
  }
  return null;
}

/** The swatch shown for a palette entry: its shade at `shade` (Excalidraw keeps it in sync). */
export function swatchOf(name: string, shade: number): string {
  const value = STROKE_PALETTE[name]!;
  return typeof value === "string" ? value : value[shade]!;
}

/** Excalidraw's hotkey label contrast (YIQ): dark text on light swatches. */
export function contrastText(color: string): string {
  if (color === TRANSPARENT) return "#1e1e1e";
  const n = parseInt(color.slice(1), 16);
  const yiq = (((n >> 16) & 255) * 299 + ((n >> 8) & 255) * 587 + (n & 255) * 114) / 1000;
  return yiq >= 160 ? "#1e1e1e" : "#ffffff";
}

/** `#abc` / `abc` / `#aabbcc` → `#aabbcc`; anything else → null. */
export function parseHex(input: string): string | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(input.trim());
  if (!m) return null;
  const hex = m[1]!.toLowerCase();
  return `#${hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex}`;
}

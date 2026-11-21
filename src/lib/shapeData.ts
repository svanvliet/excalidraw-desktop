/**
 * Shape data: ordered key/value string pairs on any element (docs/plan.md D-DX2), stored as
 * `customData["excalidrawDesktop.data"] = { v: 1, entries: [[key, value], ...] }`. It rides
 * along with the element through save, reload and collab like any other element field.
 *
 * Data written by a newer version (or hand-edited into an unknown shape) is shown read-only and
 * never rewritten, so nothing is lost on a round-trip through an older build.
 */
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

export const DATA_KEY = "excalidrawDesktop.data";
export const DATA_VERSION = 1;
export const MAX_KEY_LENGTH = 100;
export const MAX_VALUE_LENGTH = 10_000;
export const MAX_ENTRIES = 200;

export type DataEntry = [key: string, value: string];

export interface ElementData {
  entries: DataEntry[];
  /** Present but not understood by this build: don't write it. */
  readOnly: boolean;
}

type WithCustomData = Pick<ExcalidrawElement, "customData">;

function isEntryList(v: unknown): v is DataEntry[] {
  return (
    Array.isArray(v) &&
    v.every(
      (e) =>
        Array.isArray(e) && e.length === 2 && typeof e[0] === "string" && typeof e[1] === "string",
    )
  );
}

export function readData(el: WithCustomData): ElementData {
  const raw: unknown = el.customData?.[DATA_KEY];
  if (raw === undefined) return { entries: [], readOnly: false };
  if (typeof raw === "object" && raw !== null) {
    const { v, entries } = raw as { v?: unknown; entries?: unknown };
    if (v === DATA_VERSION && isEntryList(entries)) return { entries, readOnly: false };
    return { entries: isEntryList(entries) ? entries : [], readOnly: true };
  }
  return { entries: [], readOnly: true };
}

/** The element's data as an object, or undefined when it has none. */
export function dataRecord(el: WithCustomData): Record<string, string> | undefined {
  const { entries } = readData(el);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

export function normaliseKey(key: string): string {
  const k = key.trim();
  if (!k) throw new Error("Data keys can't be empty");
  if (k.length > MAX_KEY_LENGTH)
    throw new Error(`Data keys are at most ${MAX_KEY_LENGTH} characters`);
  return k;
}

export function normaliseValue(value: unknown): string {
  const v =
    typeof value === "string"
      ? value
      : typeof value === "number" || typeof value === "boolean"
        ? String(value)
        : null;
  if (v === null) throw new Error("Data values must be strings, numbers or booleans");
  if (v.length > MAX_VALUE_LENGTH) {
    throw new Error(`Data values are at most ${MAX_VALUE_LENGTH} characters`);
  }
  return v;
}

/**
 * Applies `set` (null removes a key) to the entries; existing keys keep their position, new ones
 * are appended. With `replace`, the result holds only the keys in `set`.
 */
export function patchEntries(
  entries: readonly DataEntry[],
  set: Readonly<Record<string, string | null>>,
  replace = false,
): DataEntry[] {
  const out = new Map<string, string>(replace ? [] : entries);
  for (const [k, v] of Object.entries(set)) {
    if (v === null) out.delete(k);
    else out.set(k, v);
  }
  if (out.size > MAX_ENTRIES) throw new Error(`At most ${MAX_ENTRIES} data keys per element`);
  return [...out];
}

/** Renames `from` in place; an existing `to` entry is replaced. */
export function renameKey(entries: readonly DataEntry[], from: string, to: string): DataEntry[] {
  if (from === to) return [...entries];
  return entries
    .filter(([k]) => k !== to)
    .map(([k, v]): DataEntry => (k === from ? [to, v] : [k, v]));
}

/**
 * The element's customData with `entries` stored (removed when empty), or the same object when
 * nothing changes. Throws for read-only data. Never `undefined` for a change: Excalidraw's
 * `newElementWith` / `mutateElement` skip undefined updates, which would drop the removal.
 */
export function customDataWith(
  el: WithCustomData,
  entries: readonly DataEntry[],
): ExcalidrawElement["customData"] {
  const cur = readData(el);
  if (cur.readOnly) throw new Error("This element's data was written by a newer version");
  if (JSON.stringify(cur.entries) === JSON.stringify(entries)) return el.customData;
  const { [DATA_KEY]: _old, ...rest } = el.customData ?? {};
  if (!entries.length) return rest;
  return { ...rest, [DATA_KEY]: { v: DATA_VERSION, entries: entries.map(([k, v]) => [k, v]) } };
}

type Targetable = Pick<ExcalidrawElement, "id" | "type" | "isDeleted"> & {
  containerId?: string | null;
};

/** The elements data edits apply to: a container's label goes with its selected container. */
export function dataTargets<T extends Targetable>(selected: readonly T[]): T[] {
  const ids = new Set(selected.map((e) => e.id));
  return selected.filter((e) => !e.isDeleted && !(e.containerId && ids.has(e.containerId)));
}

/** A label for CSV: the text itself, or a container's bound text. */
export function labelOf(
  el: ExcalidrawElement,
  byId: ReadonlyMap<string, ExcalidrawElement>,
): string | undefined {
  if (el.type === "text") return el.text;
  const ref = el.boundElements?.find((b) => b.type === "text");
  const text = ref && byId.get(ref.id);
  return text && text.type === "text" && !text.isDeleted ? text.text : undefined;
}

export interface SharedRow {
  key: string;
  /** null when the elements disagree. */
  value: string | null;
}

export interface SharedData {
  /** Keys every element has, in the first element's order. */
  rows: SharedRow[];
  /** Keys only some elements have. */
  partial: number;
  readOnly: boolean;
}

export function sharedData(elements: readonly WithCustomData[]): SharedData {
  const all = elements.map(readData);
  const maps = all.map((d) => new Map(d.entries));
  const keys = new Set(all.flatMap((d) => d.entries.map(([k]) => k)));
  const rows: SharedRow[] = [];
  for (const [key] of all[0]?.entries ?? []) {
    if (!maps.every((m) => m.has(key))) continue;
    const first = maps[0]!.get(key)!;
    rows.push({ key, value: maps.every((m) => m.get(key) === first) ? first : null });
  }
  return { rows, partial: keys.size - rows.length, readOnly: all.some((d) => d.readOnly) };
}

/**
 * Quotes when needed; a leading `'` defuses cells a spreadsheet would run as a formula (values
 * can come from collab peers or the agent), except plain numbers like "-5".
 */
function csvCell(raw: string): string {
  const s = /^[=+\-@\t\r]/.test(raw) && !/^[+-]?\d+(\.\d+)?$/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export interface CsvRow {
  id: string;
  type: string;
  label?: string;
  data: readonly DataEntry[];
}

/** RFC 4180 CSV: id, type, label, then the union of data keys in first-seen order. */
export function toCsv(rows: readonly CsvRow[]): string {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const r of rows)
    for (const [k] of r.data)
      if (!seen.has(k)) {
        seen.add(k);
        keys.push(k);
      }
  const lines = [["id", "type", "label", ...keys]];
  for (const r of rows) {
    const m = new Map(r.data);
    lines.push([r.id, r.type, r.label ?? "", ...keys.map((k) => m.get(k) ?? "")]);
  }
  return lines.map((l) => l.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

/**
 * Components v1 data model (plan D-DX2/D-DX3, docs/components.md).
 *
 * Every child of a component carries `customData["excalidrawDesktop.component"]`:
 *  - `role`: "master" (the source on the canvas) or "instance" (a live copy).
 *  - `componentId`: shared by the master and all its instances.
 *  - `slot`: stable key of the master child this element mirrors (the master child's id when it
 *    joined the component). Instance children map 1:1 onto master slots.
 *  - `gi`: index in `groupIds` of the component's group. The master's / an instance's identity
 *    is `groupIds[gi]` (D-DX3): inner groups come before it, user groups around it after it.
 *  - `base` (instances): the master child's geometry relative to the master origin at the last
 *    sync. Comparing it with the instance child's own geometry yields the instance transform.
 *  - `overrides` (instances): per-slot values that win over the master (text, colours, …).
 *  - `promoted` (masters): this master was an instance promoted when the master was deleted;
 *    keeps the overrides it had so it can be demoted again if the old master comes back.
 */
import type { El } from "../reactor/reactor";

export const COMPONENT_NS = "excalidrawDesktop.component";
export const COMPONENT_MODEL_VERSION = 1;

export interface Base {
  /** Centre relative to the master origin. */
  cx: number;
  cy: number;
  w: number;
  h: number;
  angle: number;
}

/** Keys an instance may override per slot. `fileId` is the image. */
export const OVERRIDE_KEYS = [
  "text",
  "backgroundColor",
  "strokeColor",
  "opacity",
  "link",
  "fileId",
] as const;
export type OverrideKey = (typeof OVERRIDE_KEYS)[number];
export type Overrides = Partial<Record<OverrideKey, unknown>>;

export interface ComponentTag {
  v: 1;
  role: "master" | "instance";
  componentId: string;
  slot: string;
  gi: number;
  name?: string;
  base?: Base;
  overrides?: Overrides;
  promoted?: { overrides?: Overrides; base?: Base };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The element's component tag, or null if it has none (or one this version can't read). */
export function tagOf(el: El | undefined | null): ComponentTag | null {
  const raw = el?.customData?.[COMPONENT_NS];
  if (!isRecord(raw) || raw.v !== COMPONENT_MODEL_VERSION) return null;
  if (raw.role !== "master" && raw.role !== "instance") return null;
  if (typeof raw.componentId !== "string" || typeof raw.slot !== "string") return null;
  if (typeof raw.gi !== "number" || !Number.isInteger(raw.gi) || raw.gi < 0) return null;
  return raw as unknown as ComponentTag;
}

/** True when the element has a component tag of any version (so we must leave it alone). */
export function hasAnyTag(el: El): boolean {
  return el.customData?.[COMPONENT_NS] !== undefined;
}

/** The component group id (master or instance identity), or null if the group is gone. */
export function groupOf(el: El, tag: ComponentTag | null = tagOf(el)): string | null {
  if (!tag) return null;
  return el.groupIds[tag.gi] ?? null;
}

/** `customData` with the tag replaced (or removed when `tag` is null). */
export function withTag(el: El, tag: ComponentTag | null): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(el.customData ?? {}) };
  if (tag) next[COMPONENT_NS] = cleanTag(tag);
  else delete next[COMPONENT_NS];
  return next;
}

function cleanTag(tag: ComponentTag): ComponentTag {
  const out: ComponentTag = {
    v: 1,
    role: tag.role,
    componentId: tag.componentId,
    slot: tag.slot,
    gi: tag.gi,
  };
  if (tag.name) out.name = tag.name;
  if (tag.base) out.base = tag.base;
  if (tag.overrides && Object.keys(tag.overrides).length) out.overrides = tag.overrides;
  if (tag.promoted) out.promoted = tag.promoted;
  return out;
}

/** Deterministic id so peers creating the same instance child converge. */
export function stableId(...parts: string[]): string {
  const s = parts.join("\u0000");
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return `cmp${h1.toString(36)}${h2.toString(36)}`;
}

/** Public summary of one component (UI + agent). */
export interface ComponentInfo {
  componentId: string;
  name: string | null;
  /** Master group id (select it to select the master), or null when there is no live master. */
  masterGroupId: string | null;
  /** Live master child ids. */
  masterIds: string[];
  instances: Array<{ groupId: string; ids: string[]; overriddenSlots: number }>;
}

/** Info about the component an element belongs to, as seen from that element. */
export interface ElementComponentInfo {
  componentId: string;
  role: "master" | "instance";
  slot: string;
  groupId: string | null;
  name?: string;
  overrides?: Overrides;
}

export function elementComponentInfo(el: El): ElementComponentInfo | null {
  const tag = tagOf(el);
  if (!tag) return null;
  const out: ElementComponentInfo = {
    componentId: tag.componentId,
    role: tag.role,
    slot: tag.slot,
    groupId: groupOf(el, tag),
  };
  if (tag.name) out.name = tag.name;
  if (tag.overrides && Object.keys(tag.overrides).length) out.overrides = tag.overrides;
  return out;
}

/** Every component in a scene (live elements only). */
export function listComponents(elements: readonly El[]): ComponentInfo[] {
  const byId = new Map<string, ComponentInfo>();
  const instanceIdx = new Map<string, Map<string, { ids: string[]; overriddenSlots: number }>>();
  for (const el of elements) {
    if (el.isDeleted) continue;
    const tag = tagOf(el);
    const group = tag && groupOf(el, tag);
    if (!tag || !group) continue;
    let info = byId.get(tag.componentId);
    if (!info) {
      info = {
        componentId: tag.componentId,
        name: null,
        masterGroupId: null,
        masterIds: [],
        instances: [],
      };
      byId.set(tag.componentId, info);
      instanceIdx.set(tag.componentId, new Map());
    }
    if (tag.name && (tag.role === "master" || !info.name)) info.name = tag.name;
    if (tag.role === "master") {
      info.masterGroupId ??= group;
      if (info.masterGroupId === group) info.masterIds.push(el.id);
    } else {
      const idx = instanceIdx.get(tag.componentId)!;
      let inst = idx.get(group);
      if (!inst) idx.set(group, (inst = { ids: [], overriddenSlots: 0 }));
      inst.ids.push(el.id);
      if (tag.overrides && Object.keys(tag.overrides).length) inst.overriddenSlots++;
    }
  }
  for (const [cid, info] of byId) {
    for (const [groupId, inst] of instanceIdx.get(cid)!) info.instances.push({ groupId, ...inst });
    info.instances.sort((a, b) => (a.groupId < b.groupId ? -1 : 1));
  }
  return [...byId.values()];
}

/**
 * Components v1 actions on a scene `Draft` (agent tools and UI share them). Each action leaves
 * the draft fully synced, so committing it (`commitDraft` / `commitUndoable`) is one consistent
 * undo step and the live reactor has nothing left to do.
 */
import { Draft, newId, ToolError, type El } from "../../agent/scene/draft";
import { effectivePatch } from "../reactor/reactor";
import { baseOf, isBoundText, originOf, placeGeometry, type Transform } from "./geometry";
import {
  groupOf,
  hasAnyTag,
  listComponents,
  OVERRIDE_KEYS,
  isOwned,
  tagOf,
  tagsOf,
  withTag,
  type ComponentInfo,
  type ComponentTag,
  type OverrideKey,
  type Overrides,
} from "./model";
import {
  cleanOverrides,
  componentMembers,
  overridable,
  syncCascade,
  type SyncAccess,
} from "./sync";

export function draftAccess(draft: Draft): SyncAccess {
  return {
    get: (id) => draft.peek(id),
    members: (cid) => componentMembers(draft.toArray(), cid),
    patch: (id, p) => {
      const cur = draft.peek(id);
      const eff = cur && effectivePatch(cur, p);
      if (eff) draft.update(id, eff);
    },
    add: (el, afterId) => draft.add(el, afterId),
  };
}

/** Bring every instance of `componentIds` (default: all) in line with its master. */
export function syncDraft(draft: Draft, componentIds?: Iterable<string>): void {
  const ids = componentIds
    ? new Set(componentIds)
    : new Set(draft.toArray().flatMap((e) => tagsOf(e).map((t) => t.componentId)));
  syncCascade(ids, draftAccess(draft));
}

/**
 * After generic edits (agent `update_elements`, `delete_elements`, …): bring the components
 * those edits touched in line, adopting direct edits to instance children as overrides — the
 * same thing the live sync does for UI edits, but inside the draft so the result commits as one
 * consistent step.
 */
export function syncEdited(draft: Draft): void {
  if (!draft.changed.size) return;
  const masterGroups = new Map<string, string>();
  for (const el of draft.toArray())
    for (const t of tagsOf(el)) {
      const g = t.role === "master" ? groupOf(el, t) : null;
      if (g && !el.isDeleted) masterGroups.set(g, t.componentId);
    }
  const cids = new Set<string>();
  for (const id of draft.changed) {
    for (const el of [draft.original.get(id), draft.peek(id)]) {
      if (!el) continue;
      for (const t of tagsOf(el)) cids.add(t.componentId);
      for (const g of el.groupIds) if (masterGroups.has(g)) cids.add(masterGroups.get(g)!);
    }
  }
  if (!cids.size) return;
  syncCascade(cids, draftAccess(draft), { changed: new Set(draft.changed) });
}

export function componentsOf(draft: Draft): ComponentInfo[] {
  return listComponents(draft.toArray());
}

function mustComponent(draft: Draft, componentId: unknown): ComponentInfo {
  if (typeof componentId !== "string") throw new ToolError("componentId must be a string");
  const info = componentsOf(draft).find((c) => c.componentId === componentId);
  if (!info) throw new ToolError(`No component "${componentId}" on this canvas`);
  if (!info.masterGroupId) throw new ToolError(`Component "${componentId}" has no master`);
  return info;
}

/** Selection → the ids that will form the component (bound text and arrow labels included). */
function expandSelection(draft: Draft, ids: readonly string[]): El[] {
  const out = new Map<string, El>();
  for (const id of ids) {
    const el = draft.mustGet(id);
    const container = el.type === "text" && "containerId" in el && el.containerId;
    const owner = container ? draft.get(container) : undefined;
    for (const e of owner ? [owner] : [el]) {
      out.set(e.id, e);
      const text = draft.boundTextOf(e);
      if (text) out.set(text.id, text);
    }
  }
  return [...out.values()];
}

export interface CreatedComponent {
  componentId: string;
  masterGroupId: string;
  ids: string[];
}

/**
 * Turn `ids` (plus their bound text) into the master of a new component. Existing groups that
 * lie fully inside the selection stay inner groups; the component group goes just inside the
 * first group that reaches outside it. When the selection is exactly one existing group, that
 * group becomes the component group.
 */
export function createComponent(
  draft: Draft,
  ids: readonly string[],
  name?: string,
): CreatedComponent {
  if (!ids.length) throw new ToolError("Select at least one element to make a component");
  const els = expandSelection(draft, ids);
  for (const el of els) {
    if (hasAnyTag(el))
      throw new ToolError(
        `Element "${el.id}" is already part of a component (nesting is not supported)`,
      );
    if (el.frameId !== els[0].frameId)
      throw new ToolError("A component's elements must all be in the same frame (or none)");
  }
  const selected = new Set(els.map((e) => e.id));
  const live = draft.live();
  const membersOf = new Map<string, string[]>();
  for (const el of live)
    for (const g of el.groupIds) {
      const l = membersOf.get(g);
      if (l) l.push(el.id);
      else membersOf.set(g, [el.id]);
    }
  const inside = (g: string) => membersOf.get(g)!.every((id) => selected.has(id));
  const covers = (g: string) => inside(g) && membersOf.get(g)!.length === selected.size;

  // Reuse an existing group that is exactly the selection, if every element has it.
  const shared = els[0].groupIds.find((g) => covers(g) && els.every((e) => e.groupIds.includes(g)));
  const group = shared ?? newId();
  const componentId = newId();
  const label = typeof name === "string" && name.trim() ? name.trim().slice(0, 80) : undefined;
  for (const el of els) {
    let groupIds = el.groupIds;
    let gi = groupIds.indexOf(group);
    if (gi < 0) {
      gi = groupIds.findIndex((g) => !inside(g));
      if (gi < 0) gi = groupIds.length;
      groupIds = [...groupIds.slice(0, gi), group, ...groupIds.slice(gi)];
    }
    const tag: ComponentTag = { v: 1, role: "master", componentId, slot: el.id, gi };
    if (label) tag.name = label;
    draft.update(el.id, { groupIds, customData: withTag(el, tag) });
  }
  return { componentId, masterGroupId: group, ids: els.map((e) => e.id) };
}

export interface InsertOptions {
  /** Top-left of the (unrotated) instance. Default: right of the master. */
  x?: number;
  y?: number;
  scale?: number;
  /** Radians. */
  angle?: number;
}

/** Add an instance of `componentId`. Returns its group id and child ids. */
export function insertInstance(
  draft: Draft,
  componentId: string,
  opts: InsertOptions = {},
): { groupId: string; ids: string[] } {
  const info = mustComponent(draft, componentId);
  const master = info.masterIds.map((id) => draft.get(id)!);
  const origin = originOf(master);
  const right = Math.max(...master.map((m) => m.x + m.width));
  const scale = opts.scale ?? 1;
  if (!(Number.isFinite(scale) && scale > 0))
    throw new ToolError("scale must be a positive number");
  const t: Transform = {
    ox: opts.x ?? right + 40,
    oy: opts.y ?? origin.y,
    sx: scale,
    sy: scale,
    angle: opts.angle ?? 0,
  };
  const group = newId();
  const inner = new Map<string, string>();
  const ids: string[] = [];
  for (const m of master) {
    const tag = tagOf(m)!;
    const base = baseOf(m, origin);
    const id = newId();
    ids.push(id);
    const groupIds = m.groupIds.map((g, i) => {
      if (i === tag.gi) return group;
      if (i > tag.gi) return g;
      let mapped = inner.get(g);
      if (!mapped) inner.set(g, (mapped = newId()));
      return mapped;
    });
    const itag: ComponentTag = {
      v: 1,
      role: "instance",
      componentId,
      slot: tag.slot,
      gi: tag.gi,
      base,
    };
    if (tag.name) itag.name = tag.name;
    draft.add({
      ...m,
      ...placeGeometry(m, base, t),
      id,
      groupIds,
      index: null,
      locked: false,
      boundElements: null,
      ...(m.type === "arrow" ? { startBinding: null, endBinding: null } : {}),
      customData: withTag(m, itag),
      version: 1,
      versionNonce: Math.floor(Math.random() * 2 ** 31),
      updated: Date.now(),
    } as unknown as El);
  }
  syncDraft(draft, [componentId]);
  return { groupId: group, ids };
}

export interface InstanceRef {
  componentId: string;
  groupId: string;
  children: El[];
}

/**
 * An instance by its group id or the id of any of its children. For an element in several
 * components (nested), the outermost instance that isn't owned by another instance wins.
 */
export function resolveInstance(draft: Draft, ref: unknown): InstanceRef {
  if (typeof ref !== "string") throw new ToolError("instance must be a group id or element id");
  const el = draft.get(ref);
  let groupId: string | null = ref;
  let componentId: string | undefined;
  if (el) {
    const tags = tagsOf(el);
    const free = tags.filter((t) => t.role === "instance" && !isOwned(el, t.componentId));
    const tag = free[free.length - 1];
    if (!tag) {
      if (tags.length) throw new ToolError(`"${ref}" is part of a master, not an instance`);
      throw new ToolError(`"${ref}" is not a component instance (or one of its elements)`);
    }
    groupId = groupOf(el, tag);
    componentId = tag.componentId;
  }
  const children = draft
    .live()
    .filter((e) =>
      tagsOf(e).some(
        (t) =>
          t.role === "instance" &&
          groupOf(e, t) === groupId &&
          (!componentId || t.componentId === componentId),
      ),
    );
  if (!groupId || !children.length) {
    const master = draft
      .live()
      .some((e) => tagsOf(e).some((t) => t.role === "master" && groupOf(e, t) === ref));
    if (master) throw new ToolError(`"${ref}" is a master, not an instance`);
    throw new ToolError(`"${ref}" is not a component instance (or one of its elements)`);
  }
  componentId ??= tagsOf(children[0]).find((t) => groupOf(children[0], t) === groupId)!.componentId;
  if (isOwned(children[0], componentId))
    throw new ToolError(
      `"${ref}" is a nested instance inside another instance; edit it through that instance`,
    );
  return { componentId, groupId, children };
}

export interface OverrideEntry {
  /** Instance child id, or the master slot key. */
  elementId?: string;
  slot?: string;
  /** Values to override; `null` clears that key. */
  values: Partial<Record<OverrideKey, unknown>>;
}

function childFor(inst: InstanceRef, entry: { elementId?: string; slot?: string }): El {
  const c = inst.children.find((e) =>
    entry.elementId ? e.id === entry.elementId : tagOf(e)!.slot === entry.slot,
  );
  if (!c)
    throw new ToolError(
      `No child ${entry.elementId ? `"${entry.elementId}"` : `with slot "${entry.slot}"`} in instance ${inst.groupId}`,
    );
  return c;
}

function masterFor(draft: Draft, c: El): El | undefined {
  const tag = tagOf(c)!;
  return draft.live().find((m) => {
    const t = tagOf(m);
    return t?.role === "master" && t.componentId === tag.componentId && t.slot === tag.slot;
  });
}

const VALIDATORS: Record<OverrideKey, (v: unknown) => boolean> = {
  text: (v) => typeof v === "string",
  backgroundColor: (v) => typeof v === "string",
  strokeColor: (v) => typeof v === "string",
  opacity: (v) => typeof v === "number" && v >= 0 && v <= 100,
  link: (v) => typeof v === "string",
  fileId: (v) => typeof v === "string",
  visible: (v) => typeof v === "boolean",
};

export function setOverrides(
  draft: Draft,
  instance: unknown,
  entries: readonly OverrideEntry[],
): void {
  const inst = resolveInstance(draft, instance);
  for (const entry of entries) {
    const c = childFor(inst, entry);
    const m = masterFor(draft, c) ?? c;
    const tag = tagOf(c)!;
    const ov: Overrides = { ...(tag.overrides ?? {}) };
    for (const [k, v] of Object.entries(entry.values ?? {})) {
      if (!(OVERRIDE_KEYS as readonly string[]).includes(k))
        throw new ToolError(`"${k}" can't be overridden (allowed: ${OVERRIDE_KEYS.join(", ")})`);
      const key = k as OverrideKey;
      if (!overridable(m, key)) throw new ToolError(`"${key}" doesn't apply to a ${m.type}`);
      if (v === null || v === undefined) delete ov[key];
      else if (!VALIDATORS[key](v)) throw new ToolError(`Invalid value for "${key}"`);
      else ov[key] = v;
    }
    draft.update(c.id, { customData: withTag(c, { ...tag, overrides: cleanOverrides(m, ov) }) });
  }
  syncDraft(draft, [inst.componentId]);
}

/** Clear overrides on an instance: all, or only some slots / keys. */
export function resetOverrides(
  draft: Draft,
  instance: unknown,
  opts: {
    slots?: readonly string[];
    elementIds?: readonly string[];
    keys?: readonly string[];
  } = {},
): void {
  const inst = resolveInstance(draft, instance);
  for (const c of inst.children) {
    const tag = tagOf(c)!;
    if (opts.slots?.length && !opts.slots.includes(tag.slot)) continue;
    if (opts.elementIds?.length && !opts.elementIds.includes(c.id)) continue;
    if (!tag.overrides) continue;
    const ov: Overrides = { ...tag.overrides };
    for (const k of OVERRIDE_KEYS) if (!opts.keys?.length || opts.keys.includes(k)) delete ov[k];
    draft.update(c.id, { customData: withTag(c, { ...tag, overrides: ov }) });
  }
  syncDraft(draft, [inst.componentId]);
}

/** Turn an instance into ordinary elements (they keep their group and current look). */
export function detachInstance(
  draft: Draft,
  instance: unknown,
): { groupId: string; ids: string[] } {
  const inst = resolveInstance(draft, instance);
  for (const c of inst.children) draft.update(c.id, { customData: withTag(c, null) });
  return { groupId: inst.groupId, ids: inst.children.map((c) => c.id) };
}

/** Component ids touched by a set of elements (selection → component actions). */
export function componentIdsOf(els: readonly El[]): string[] {
  return [...new Set(els.flatMap((e) => (tagOf(e) ? [tagOf(e)!.componentId] : [])))];
}

export { isBoundText };

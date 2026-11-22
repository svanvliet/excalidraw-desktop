/**
 * Components v1 actions on a scene `Draft` (agent tools and UI share them). Each action leaves
 * the draft fully synced, so committing it (`commitDraft` / `commitUndoable`) is one consistent
 * undo step and the live reactor has nothing left to do.
 */
import { Draft, newId, ToolError, type El } from "../../agent/scene/draft";
import { effectivePatch } from "../reactor/reactor";
import { baseOf, isBoundText, originOf, placeGeometry, type Transform } from "./geometry";
import {
  canonicalInner,
  groupOf,
  innerTags,
  isReadable,
  listComponents,
  CONTENT_KEYS,
  OVERRIDE_KEYS,
  isOwned,
  PROP_TYPES,
  tagFor,
  tagOf,
  tagsOf,
  withTag,
  withoutTag,
  type ComponentInfo,
  type ComponentTag,
  type OverrideKey,
  type Overrides,
  type PropBinding,
  type PropDef,
  type PropValues,
} from "./model";
import {
  cleanOverrides,
  componentMembers,
  nests,
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
  // A component instance joins whole (it becomes a nested instance of the new component).
  for (const el of [...out.values()]) {
    const tag = tagOf(el);
    const g = tag && groupOf(el, tag);
    if (!g) continue;
    for (const e of draft.live())
      if (e.groupIds.includes(g) && tagFor(e, tag.componentId)) out.set(e.id, e);
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
    if (!isReadable(el))
      throw new ToolError(`Element "${el.id}" has component data this version can't read`);
    for (const t of tagsOf(el)) {
      if (t.role === "master")
        throw new ToolError(
          `Element "${el.id}" is part of a master; only instances can be nested in a component`,
        );
    }
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
  // A group that already is a (nested) component's can't be reused: wrapping exactly one
  // instance nests it in a fresh outer group.
  const componentGroups = new Set(els.flatMap((e) => tagsOf(e).map((t) => e.groupIds[t.gi])));
  const shared = els[0].groupIds.find(
    (g) => covers(g) && !componentGroups.has(g) && els.every((e) => e.groupIds.includes(g)),
  );
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
    if (tagsOf(el).some((t) => t.gi >= gi))
      throw new ToolError("Select whole component instances to nest them in a new component");
    const tag: ComponentTag = { v: 1, role: "master", componentId, slot: el.id, gi };
    if (label) tag.name = label;
    draft.update(el.id, { groupIds, customData: withTag(el, tag) });
  }
  syncDraft(draft, [componentId]);
  return { componentId, masterGroupId: group, ids: els.map((e) => e.id) };
}

export interface InsertOptions {
  /** Top-left of the (unrotated) instance. Default: right of the master. */
  x?: number;
  y?: number;
  scale?: number;
  /** Radians. */
  angle?: number;
  /** Master group id (or a master element id) of another component to nest the instance in. */
  into?: string;
}

/** The master `{ componentId, groupId, el }` a ref (group id or element id) points at. */
function resolveMaster(
  draft: Draft,
  ref: unknown,
): { componentId: string; groupId: string; el: El } {
  if (typeof ref !== "string") throw new ToolError("into must be a master group id or element id");
  const byEl = draft.get(ref);
  for (const e of byEl ? [byEl] : draft.live()) {
    const tag = tagsOf(e).find((t) => t.role === "master" && (byEl || groupOf(e, t) === ref));
    const g = tag && groupOf(e, tag);
    if (tag && g && !e.isDeleted) return { componentId: tag.componentId, groupId: g, el: e };
  }
  throw new ToolError(`"${ref}" is not a component master (or one of its elements)`);
}

/** Add an instance of `componentId`. Returns its group id and child ids. */
export function insertInstance(
  draft: Draft,
  componentId: string,
  opts: InsertOptions = {},
): { groupId: string; ids: string[] } {
  const info = mustComponent(draft, componentId);
  const into = opts.into === undefined ? null : resolveMaster(draft, opts.into);
  if (into && nests(draftAccess(draft), componentId, into.componentId))
    throw new ToolError(
      into.componentId === componentId
        ? "A component can't contain an instance of itself"
        : "That would make a cycle: the component already contains the target component",
    );
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
  const intoTag = into && tagFor(into.el, into.componentId)!;
  const intoOuter = into ? into.el.groupIds.slice(intoTag!.gi) : null;
  for (const m of master) {
    const tag = tagFor(m, componentId)!;
    const base = baseOf(m, origin);
    const id = newId();
    ids.push(id);
    const own = m.groupIds.slice(0, tag.gi).map((g) => {
      let mapped = inner.get(g);
      if (!mapped) inner.set(g, (mapped = newId()));
      return mapped;
    });
    const groupIds = [...own, group, ...(intoOuter ?? m.groupIds.slice(tag.gi + 1))];
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
      ...(into ? { frameId: into.el.frameId } : {}),
      version: 1,
      versionNonce: Math.floor(Math.random() * 2 ** 31),
      updated: Date.now(),
    } as unknown as El);
  }
  syncDraft(draft, into ? [componentId, into.componentId] : [componentId]);
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
    entry.elementId ? e.id === entry.elementId : tagFor(e, inst.componentId)!.slot === entry.slot,
  );
  if (!c)
    throw new ToolError(
      `No child ${entry.elementId ? `"${entry.elementId}"` : `with slot "${entry.slot}"`} in instance ${inst.groupId}`,
    );
  return c;
}

function masterFor(draft: Draft, c: El, componentId: string): El | undefined {
  const tag = tagFor(c, componentId)!;
  return draft.live().find((m) => {
    const t = tagFor(m, componentId);
    return t?.role === "master" && t.slot === tag.slot;
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
    const m = masterFor(draft, c, inst.componentId) ?? c;
    const tag = tagFor(c, inst.componentId)!;
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

/**
 * Clear overrides on an instance: all, or only some slots / keys. A full reset (no filters) also
 * clears property values (`props` defaults to true then). `content: false` keeps the instance's
 * content — property values, nested values and the `CONTENT_KEYS` overrides (text, image, link) —
 * and resets only its look: style overrides, hidden slots and text sizes ("Reset overrides" in
 * the UI, FR-67). `keys` may include "fontSize" for a text's own size (`fs`).
 */
export function resetOverrides(
  draft: Draft,
  instance: unknown,
  opts: {
    slots?: readonly string[];
    elementIds?: readonly string[];
    keys?: readonly string[];
    props?: boolean;
    content?: boolean;
  } = {},
): void {
  const inst = resolveInstance(draft, instance);
  const filtered = !!(opts.slots?.length || opts.elementIds?.length || opts.keys?.length);
  const keepContent = opts.content === false;
  const clearProps = !keepContent && (opts.props ?? !filtered);
  const picked = (k: string) =>
    (!opts.keys?.length || opts.keys.includes(k)) && !(keepContent && CONTENT_KEYS.includes(k));
  for (const c of inst.children) {
    const tag = tagFor(c, inst.componentId)!;
    const next: ComponentTag = { ...tag };
    if (clearProps) {
      next.pv = undefined;
      next.npv = undefined;
    }
    const match =
      (!opts.slots?.length || opts.slots.includes(tag.slot)) &&
      (!opts.elementIds?.length || opts.elementIds.includes(c.id));
    if (match && (filtered || keepContent || opts.props !== true)) {
      if (tag.overrides) {
        const ov: Overrides = { ...tag.overrides };
        for (const k of OVERRIDE_KEYS) if (picked(k)) delete ov[k];
        next.overrides = ov;
      }
      if (picked("fontSize")) next.fs = undefined;
    }
    draft.update(c.id, { customData: withTag(c, next) });
  }
  syncDraft(draft, [inst.componentId]);
}

/** Turn an instance into ordinary elements (they keep their group and current look). */
export function detachInstance(
  draft: Draft,
  instance: unknown,
): { groupId: string; ids: string[] } {
  const inst = resolveInstance(draft, instance);
  // Only this membership goes: nested instances inside it become free instances again, and an
  // instance inside a master stays a child of that master.
  const affected = new Set<string>();
  for (const c of inst.children) {
    for (const t of tagsOf(c)) if (t.componentId !== inst.componentId) affected.add(t.componentId);
    draft.update(c.id, { customData: withoutTag(c, inst.componentId) });
  }
  if (affected.size) syncDraft(draft, affected);
  return { groupId: inst.groupId, ids: inst.children.map((c) => c.id) };
}

// --- Properties --------------------------------------------------------------------------------

export interface PropertyInput {
  /** Stable id; generated when absent. Redefining an existing id replaces that property. */
  id?: string;
  name: string;
  type: string;
  default?: string | boolean;
  options?: string[];
  bindings: Array<{
    /** Master element id or slot key. */
    elementId?: string;
    slot?: string;
    key?: string;
    map?: Record<string, unknown>;
  }>;
}

function masterOf(draft: Draft, componentId: unknown): { info: ComponentInfo; els: El[] } {
  const info = mustComponent(draft, componentId);
  return { info, els: info.masterIds.map((id) => draft.get(id)!).filter((e) => !e.isDeleted) };
}

function propsOf(els: readonly El[], componentId: string): PropDef[] {
  return els.map((e) => tagFor(e, componentId)?.props).find((p) => p?.length) ?? [];
}

function writeProps(draft: Draft, els: readonly El[], componentId: string, props: PropDef[]) {
  for (const el of els) {
    const tag = tagFor(el, componentId)!;
    draft.update(el.id, {
      customData: withTag(el, { ...tag, props: props.length ? props : undefined }),
    });
  }
}

const DEFAULT_KEY: Record<string, OverrideKey> = {
  text: "text",
  color: "backgroundColor",
  boolean: "visible",
};

/** Declare (or redefine) a typed property on a component's master. Returns its id. */
export function defineProperty(draft: Draft, componentId: unknown, input: PropertyInput): string {
  const { info, els } = masterOf(draft, componentId);
  const cid = info.componentId;
  if (!input || typeof input !== "object") throw new ToolError("property must be an object");
  const name = typeof input.name === "string" ? input.name.trim().slice(0, 60) : "";
  if (!name) throw new ToolError("property name is required");
  if (!(PROP_TYPES as readonly string[]).includes(input.type))
    throw new ToolError(`property type must be one of ${PROP_TYPES.join(", ")}`);
  const type = input.type as PropDef["type"];
  const props = propsOf(els, cid);
  const id = typeof input.id === "string" && input.id ? input.id : newId();
  if (props.some((p) => p.id !== id && p.name.toLowerCase() === name.toLowerCase()))
    throw new ToolError(`Component already has a property named "${name}"`);
  const def: PropDef = { id, name, type, bindings: [] };
  if (type === "choice") {
    const options = [...new Set((input.options ?? []).map(String).filter(Boolean))];
    if (options.length < 2) throw new ToolError("a choice property needs at least 2 options");
    def.options = options;
    if (input.default !== undefined) {
      if (!options.includes(String(input.default)))
        throw new ToolError(`default must be one of: ${options.join(", ")}`);
      def.default = String(input.default);
    }
  } else if (type === "boolean") {
    if (input.default !== undefined && typeof input.default !== "boolean")
      throw new ToolError("a boolean property's default must be true or false");
    if (input.default === false) def.default = false;
  }
  if (!Array.isArray(input.bindings) || !input.bindings.length)
    throw new ToolError("property needs at least one binding (elementId/slot + key)");
  for (const b of input.bindings) {
    // An instance child's id names its slot (the master may only exist while this runs).
    const viaInstance = b.elementId ? tagFor(draft.get(b.elementId), cid) : null;
    const bySlot =
      viaInstance?.role === "instance" ? viaInstance.slot : b.elementId ? null : b.slot;
    let el = els.find((e) =>
      bySlot === null ? e.id === b.elementId : tagFor(e, cid)!.slot === bySlot,
    );
    if (!el) throw new ToolError(`No master element ${b.elementId ?? b.slot} in this component`);
    const key = (b.key ?? DEFAULT_KEY[type]) as OverrideKey;
    if (!key) throw new ToolError("a choice binding needs a key");
    if (!(OVERRIDE_KEYS as readonly string[]).includes(key))
      throw new ToolError(`"${key}" can't be bound (allowed: ${OVERRIDE_KEYS.join(", ")})`);
    // A text binding on a labelled container drives its label.
    if (key === "text" && el.type !== "text") {
      const label = draft.boundTextOf(el);
      if (label) el = label;
    }
    if (!overridable(el, key)) throw new ToolError(`"${key}" doesn't apply to a ${el.type}`);
    if (type === "text" && key !== "text") throw new ToolError("a text property binds key text");
    if (type === "color" && key !== "backgroundColor" && key !== "strokeColor")
      throw new ToolError("a color property binds backgroundColor or strokeColor");
    if (type === "boolean" && key !== "visible")
      throw new ToolError("a boolean property binds key visible");
    const binding: PropBinding = { slot: tagFor(el, cid)!.slot, key };
    if (type === "choice") {
      const map: Record<string, unknown> = {};
      for (const [opt, v] of Object.entries(b.map ?? {})) {
        if (!def.options!.includes(opt)) throw new ToolError(`"${opt}" is not an option`);
        if (v !== null && v !== undefined && !VALIDATORS[key](v))
          throw new ToolError(`Invalid value for "${key}" in option "${opt}"`);
        if (v !== null && v !== undefined) map[opt] = v;
      }
      binding.map = map;
    }
    if (def.bindings.some((x) => x.slot === binding.slot && x.key === binding.key))
      throw new ToolError(`Duplicate binding ${binding.slot}.${binding.key}`);
    def.bindings.push(binding);
  }
  const next = props.some((p) => p.id === id)
    ? props.map((p) => (p.id === id ? def : p))
    : [...props, def];
  writeProps(draft, els, cid, next);
  syncDraft(draft, [cid]);
  return id;
}

/** Remove a property (by id or name) from a component. Instances drop their values for it. */
export function removeProperty(draft: Draft, componentId: unknown, prop: unknown): void {
  const { info, els } = masterOf(draft, componentId);
  const props = propsOf(els, info.componentId);
  const def = findProp(props, prop);
  writeProps(
    draft,
    els,
    info.componentId,
    props.filter((p) => p !== def),
  );
  for (const e of componentMembers(draft.toArray(), info.componentId)) {
    const tag = tagFor(e, info.componentId);
    if (tag?.role !== "instance" || !tag.pv || !(def.id in tag.pv)) continue;
    const pv = { ...tag.pv };
    delete pv[def.id];
    draft.update(e.id, { customData: withTag(e, { ...tag, pv }) });
  }
  syncDraft(draft, [info.componentId]);
}

function findProp(props: readonly PropDef[], ref: unknown): PropDef {
  const def =
    props.find((p) => p.id === ref) ??
    props.find((p) => typeof ref === "string" && p.name.toLowerCase() === ref.toLowerCase());
  if (!def)
    throw new ToolError(
      `No property "${String(ref)}"${props.length ? ` (has: ${props.map((p) => p.name).join(", ")})` : ""}`,
    );
  return def;
}

function checkValue(def: PropDef, v: unknown): void {
  const ok =
    def.type === "boolean"
      ? typeof v === "boolean"
      : def.type === "choice"
        ? typeof v === "string" && def.options!.includes(v)
        : typeof v === "string";
  if (!ok)
    throw new ToolError(
      `Invalid value for property "${def.name}" (${def.type}${def.type === "choice" ? `: ${def.options!.join(" | ")}` : ""})`,
    );
}

export interface PropertyTarget {
  /** The properties apply to this instance's component (default) … */
  componentId: string;
  props: PropDef[];
  values: PropValues;
  /** … or to a nested instance, keyed by its group id inside the outer master. */
  nestedKey?: string;
}

/**
 * The properties an instance exposes: its own, then one entry per nested instance of its
 * master that declares properties (values set from the outer instance land in `npv`).
 */
export function instanceProperties(draft: Draft, instance: unknown): PropertyTarget[] {
  const inst = resolveInstance(draft, instance);
  const cid = inst.componentId;
  const first = inst.children[0];
  const own = tagFor(first, cid)!;
  const out: PropertyTarget[] = [
    { componentId: cid, props: own.props ?? [], values: { ...(own.pv ?? {}) } },
  ];
  const master = componentsOf(draft).find((c) => c.componentId === cid);
  const seen = new Set<string>();
  // Without a master on the canvas, nested instances are keyed by their content-addressed id.
  const masterIds = master?.masterIds ?? [];
  const canon = masterIds.length ? null : canonicalInner(inst.children, cid);
  const sources = masterIds.length ? masterIds.map((id) => draft.get(id)!) : inst.children;
  for (const m of sources) {
    const mt = tagFor(m, cid)!;
    const d = innerTags(m, mt).pop();
    const h = d && groupOf(m, d);
    const g = h && canon ? canon.get(h) : h;
    if (!d || !g || seen.has(g) || !d.props?.length) continue;
    seen.add(g);
    out.push({
      componentId: d.componentId,
      props: d.props,
      values: { ...(own.npv?.[g] ?? {}) },
      nestedKey: g,
    });
  }
  return out;
}

/**
 * Set property values on an instance (`null` clears one back to the default). With `nested`
 * (a key from `instanceProperties`), the values apply to that nested instance. Explicit
 * overrides on the keys a property drives are cleared so the new value shows.
 */
export function setProperties(
  draft: Draft,
  instance: unknown,
  values: Record<string, unknown>,
  opts: { nested?: string } = {},
): void {
  if (!values || typeof values !== "object") throw new ToolError("values must be an object");
  const inst = resolveInstance(draft, instance);
  const targets = instanceProperties(draft, inst.groupId);
  const target = opts.nested ? targets.find((t) => t.nestedKey === opts.nested) : targets[0];
  if (!target)
    throw new ToolError(`No nested instance "${opts.nested}" with properties in this instance`);
  const next = { ...target.values };
  const touched: PropDef[] = [];
  for (const [ref, v] of Object.entries(values)) {
    const def = findProp(target.props, ref);
    touched.push(def);
    if (v === null || v === undefined) delete next[def.id];
    else {
      checkValue(def, v);
      next[def.id] = v as string | boolean;
    }
  }
  // Slot keys whose explicit override would hide the new value (own properties only).
  const clear = new Map<string, Set<string>>();
  if (!opts.nested)
    for (const def of touched)
      for (const b of def.bindings) {
        if (!clear.has(b.slot)) clear.set(b.slot, new Set());
        clear.get(b.slot)!.add(b.key);
      }
  for (const c of inst.children) {
    const tag = tagFor(c, inst.componentId)!;
    const t: ComponentTag = { ...tag };
    if (opts.nested) t.npv = { ...(tag.npv ?? {}), [opts.nested]: next };
    else t.pv = next;
    const keys = clear.get(tag.slot);
    if (keys && tag.overrides) {
      const ov = { ...tag.overrides };
      for (const k of keys) delete ov[k as OverrideKey];
      t.overrides = ov;
    }
    draft.update(c.id, { customData: withTag(c, t) });
  }
  syncDraft(draft, [inst.componentId]);
}

/** Component ids touched by a set of elements (selection → component actions). */
export function componentIdsOf(els: readonly El[]): string[] {
  return [...new Set(els.flatMap((e) => (tagOf(e) ? [tagOf(e)!.componentId] : [])))];
}

export { isBoundText };

/**
 * Library-backed component masters (D-DX11). A component tagged `source: "library"` keeps its
 * master off-canvas (in the user's library); its instances are self-contained copies that are
 * never promoted when the master is absent. The master can be put back on the canvas to edit it
 * (`materializeMaster`) and taken off again (`dematerializeMaster`); `adoptInstanceAsMaster`
 * rebuilds a missing definition from an instance (another machine without that library item).
 *
 * Each action runs on a `Draft` and leaves it synced, so the host commits it as one undo step.
 */
import { newElementWith } from "@excalidraw/excalidraw";
import type { ExcalidrawTextElement } from "@excalidraw/excalidraw/element/types";
import { Draft, unionBounds, newId, ToolError, type El } from "../../agent/scene/draft";
import {
  baseOf,
  inferTransform,
  isBoundText,
  isPointy,
  originOf,
  placeGeometry,
  translation,
} from "./geometry";
import {
  canonicalInner,
  groupOf,
  innerTags,
  isOwned,
  lookOf,
  OVERRIDE_KEYS,
  stableId,
  tagFor,
  tagsOf,
  writeTags,
  type ComponentTag,
  type OverrideKey,
} from "./model";
import { resolveInstance, syncDraft } from "./actions";
import { currentValue, masterValue, overridable, propOverrides } from "./sync";
import { layoutBoundText, measureFreeText, wrapFixedText } from "./text";

type TextEl = ExcalidrawTextElement;

/** A component definition the UI saves to the library (serialisable). */
export interface ComponentDefinition {
  componentId: string;
  libraryId: string;
  name?: string;
  /** The master's elements as they were on the canvas (tags included). */
  elements: El[];
  /** Image file ids the elements use (their binary data lives in the scene's files). */
  files: string[];
}

const GAP = 40;

function masterGroupElements(draft: Draft, masterGroupId: unknown): { cid: string; els: El[] } {
  if (typeof masterGroupId !== "string") throw new ToolError("master must be a group id");
  let cid: string | undefined;
  const els: El[] = [];
  for (const el of draft.live()) {
    const t = tagsOf(el).find((x) => x.role === "master" && groupOf(el, x) === masterGroupId);
    if (!t) continue;
    cid ??= t.componentId;
    if (t.componentId === cid) els.push(el);
  }
  if (!cid || !els.length) throw new ToolError(`"${masterGroupId}" is not a component master`);
  return { cid, els };
}

/** Put `source: "library"` + `libraryId` on every tag of `cid` (master, instances, nested). */
function markLibrary(draft: Draft, cid: string, libraryId: string): void {
  for (const el of draft.toArray()) {
    const tags = tagsOf(el);
    const i = tags.findIndex((t) => t.componentId === cid);
    if (i < 0) continue;
    const t = tags[i];
    if (t.source === "library" && t.libraryId === libraryId) continue;
    const next = [...tags];
    next[i] = { ...t, source: "library", libraryId };
    draft.update(el.id, { customData: writeTags(el, next) });
  }
}

/**
 * Take a master off the canvas: every element of the component is tagged as library-backed
 * (so no instance is promoted), instances are synced once more (they record the master values
 * they override, `mv`), and the master is soft-deleted. Returns the definition to save.
 */
export function dematerialize(draft: Draft, masterGroupId: unknown): ComponentDefinition {
  const { cid } = masterGroupElements(draft, masterGroupId);
  const prev = masterGroupElements(draft, masterGroupId).els.map((e) => tagFor(e, cid)!);
  const libraryId = prev.find((t) => t.libraryId)?.libraryId ?? cid;
  markLibrary(draft, cid, libraryId);
  syncDraft(draft, [cid]);
  const { els } = masterGroupElements(draft, masterGroupId);
  rekeyNested(draft, cid, canonicalInner(els, cid));
  const def: ComponentDefinition = {
    componentId: cid,
    libraryId,
    elements: els.map((e) => structuredClone(e)),
    files: [
      ...new Set(
        els.flatMap((e) =>
          e.type === "image" && (e as { fileId?: string | null }).fileId
            ? [(e as { fileId: string }).fileId]
            : [],
        ),
      ),
    ],
  };
  const name = els.map((e) => tagFor(e, cid)?.name).find(Boolean);
  if (name) def.name = name;
  const ids = new Set(els.map((e) => e.id));
  for (const el of els) draft.update(el.id, { isDeleted: true });
  // Drop references external elements keep to the removed master.
  for (const el of draft.live()) {
    if (ids.has(el.id)) continue;
    const be = el.boundElements?.filter((b) => !ids.has(b.id));
    if (be && be.length !== el.boundElements!.length)
      draft.update(el.id, { boundElements: be.length ? be : null });
    const r = el as unknown as Record<string, { elementId?: string } | null | undefined>;
    for (const end of ["startBinding", "endBinding"])
      if (r[end]?.elementId && ids.has(r[end]!.elementId!)) draft.update(el.id, { [end]: null });
  }
  syncDraft(draft, [cid]);
  return def;
}

/** Every child of an instance, hidden (soft-deleted) slots included. */
function instanceChildren(draft: Draft, cid: string, group: string): El[] {
  return draft.toArray().filter((e) => {
    const t = tagFor(e, cid);
    return t?.role === "instance" && groupOf(e, t) === group;
  });
}

/**
 * The master's values for the overridable keys of instance child `c`: recorded `mv`, else
 * the value of the same slot in another instance that doesn't override it, else `c`'s own.
 */
function masterValues(draft: Draft, c: El, cid: string): Partial<Record<OverrideKey, unknown>> {
  const tag = tagFor(c, cid)!;
  const overridden = new Set<string>([
    ...Object.keys(tag.overrides ?? {}),
    ...Object.keys(propOverrides(tag.props, tag.pv, tag.slot)),
  ]);
  for (const t of innerTags(c, tag)) {
    const g = groupOf(c, t);
    if (g && tag.npv?.[g])
      for (const k of Object.keys(propOverrides(t.props, tag.npv[g], t.slot, true)))
        overridden.add(k);
  }
  const out: Partial<Record<OverrideKey, unknown>> = {};
  for (const k of OVERRIDE_KEYS) {
    if (k === "visible" || !overridable(c, k)) continue;
    if (tag.mv && k in tag.mv) out[k] = tag.mv[k];
    else if (!overridden.has(k)) out[k] = currentValue(c, k);
    else {
      const other = draft.toArray().find((o) => {
        const ot = tagFor(o, cid);
        if (!ot || ot.role !== "instance" || ot.slot !== tag.slot || o.id === c.id) return false;
        return !(k in (ot.overrides ?? {})) && !(k in propOverrides(ot.props, ot.pv, ot.slot));
      });
      out[k] = other ? currentValue(other, k) : currentValue(c, k);
    }
  }
  return out;
}

/** Patch that applies master values to an element (text keeps `text`/`originalText` in step). */
function valuesPatch(
  el: El,
  values: Partial<Record<OverrideKey, unknown>>,
): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    if (k === "text") {
      if (typeof v === "string" && v !== (el as TextEl).originalText) {
        p.text = v;
        p.originalText = v;
      }
    } else if ((el as unknown as Record<string, unknown>)[k] !== v) p[k] = v;
  }
  return p;
}

/** Re-measure text elements after their text changed (bound text needs its container first). */
function relayoutText(draft: Draft, ids: readonly string[]): void {
  for (const id of ids) {
    const t = draft.get(id) as TextEl | undefined;
    if (!t || t.type !== "text") continue;
    const container = t.containerId ? draft.get(t.containerId) : undefined;
    if (container) {
      const laid = layoutBoundText(container, t, t.originalText);
      if (laid) draft.update(id, laid.text);
      continue;
    }
    if (t.autoResize === false) {
      const w = wrapFixedText(t, t.originalText, t.width);
      draft.update(id, { text: w.text, height: w.height });
      continue;
    }
    const m = measureFreeText(t, t.originalText);
    const cx = t.x + t.width / 2;
    const cy = t.y + t.height / 2;
    draft.update(id, {
      text: m.text,
      width: m.width,
      height: m.height,
      x:
        t.textAlign === "center"
          ? cx - m.width / 2
          : t.textAlign === "right"
            ? t.x + t.width - m.width
            : t.x,
      y: cy - m.height / 2,
    });
  }
}

function mustHaveNoMaster(draft: Draft, cid: string): void {
  if (draft.live().some((e) => tagFor(e, cid)?.role === "master"))
    throw new ToolError("This component's master is already on the canvas");
}

/** The tag a rebuilt master child gets: same slot / props / library source, no instance data. */
function masterTag(tag: ComponentTag): ComponentTag {
  return {
    ...tag,
    role: "master",
    base: undefined,
    overrides: undefined,
    pv: undefined,
    npv: undefined,
    mv: undefined,
    ms: undefined,
    promoted: undefined,
  };
}

/**
 * Put a library component's master back on the canvas, next to `instance`: rebuilt from the
 * instance's own children at the master's geometry (its base) without the instance's overrides
 * and property values. Returns the new master group id.
 */
export function materialize(draft: Draft, instance: unknown): string {
  const inst = resolveInstance(draft, instance);
  const cid = inst.componentId;
  mustHaveNoMaster(draft, cid);
  rekeyNested(draft, cid);
  const children = instanceChildren(draft, cid, inst.groupId);
  const canon = canonicalInner(children, cid);
  const live = children.filter((c) => !c.isDeleted);
  const ref = [...live]
    .filter((c) => !isBoundText(c) && tagFor(c, cid)?.base)
    .sort((a, b) => {
      const ba = tagFor(a, cid)!.base!;
      const bb = tagFor(b, cid)!.base!;
      return Math.abs(bb.w * bb.h) - Math.abs(ba.w * ba.h);
    })[0];
  const t = ref ? inferTransform(ref, tagFor(ref, cid)!.base!) : translation({ x: 0, y: 0 });
  const box = unionBounds(live)!;
  const place = translation({ x: box.maxX + GAP, y: box.minY });
  const scale = Math.min(t.sx, t.sy) || 1;

  const group = newId();
  const innerMap = new Map<string, string>();
  const idMap = new Map(children.map((c) => [c.id, newId()]));
  const added: string[] = [];
  for (const c of children) {
    const tag = tagFor(c, cid)!;
    const base = tag.base;
    if (!base) continue;
    const r = c as unknown as Record<string, unknown>;
    const unscaled = isPointy(c)
      ? ({
          ...c,
          points: c.points.map(([x, y]) => [x / (t.sx || 1), y / (t.sy || 1)]),
        } as unknown as El)
      : c;
    const groupIds = c.groupIds.slice(0, tag.gi).map((g) => {
      let m = innerMap.get(g);
      if (!m) innerMap.set(g, (m = canon.get(g) ?? newId()));
      return m;
    });
    groupIds.push(group);
    const tags = [
      ...innerTags(c, tag).map((it) => ({ ...it, role: "instance" as const })),
      masterTag(tag),
    ];
    const remap = (id: string | null | undefined) => (id ? idMap.get(id) : undefined);
    const bound = (c.boundElements ?? []).flatMap((b) => {
      const id = remap(b.id);
      return id ? [{ ...b, id }] : [];
    });
    const el = {
      ...c,
      ...placeGeometry(unscaled, base, place),
      ...valuesPatch(c, masterValues(draft, c, cid)),
      ...(tag.ms ?? {}),
      id: idMap.get(c.id)!,
      groupIds,
      isDeleted: false,
      locked: false,
      index: null,
      boundElements: bound.length ? bound : null,
      customData: writeTags(c, tags),
      version: 1,
      versionNonce: Math.floor(Math.random() * 2 ** 31),
      updated: Date.now(),
    } as unknown as Record<string, unknown>;
    if (c.type === "text") {
      el.fontSize = Math.round(((c as TextEl).fontSize / scale) * 1000) / 1000;
      el.containerId = remap((c as TextEl).containerId) ?? null;
    }
    for (const end of ["startBinding", "endBinding"]) {
      const b = r[end] as { elementId: string } | null | undefined;
      if (b === undefined) continue;
      const id = remap(b?.elementId);
      el[end] = b && id ? { ...b, elementId: id } : null;
    }
    draft.add(newElementWith(el as unknown as El, {}, true));
    added.push(el.id as string);
  }
  relayoutText(draft, added);
  syncDraft(draft, [cid]);
  return group;
}

/**
 * Make an instance the component's master in place (its library definition is missing here).
 * Overridden keys go back to the master values the instance recorded; hidden slots reappear.
 */
export function adoptAsMaster(draft: Draft, instance: unknown): string {
  const inst = resolveInstance(draft, instance);
  const cid = inst.componentId;
  mustHaveNoMaster(draft, cid);
  const children = instanceChildren(draft, cid, inst.groupId);
  const changed: string[] = [];
  for (const c of children) {
    const tag = tagFor(c, cid)!;
    const tags = tagsOf(c).map((t) => (t.componentId === cid ? masterTag(t) : t));
    draft.update(c.id, {
      ...valuesPatch(c, masterValues(draft, c, cid)),
      isDeleted: false,
      customData: writeTags(c, tags),
    });
    if (tag.base) changed.push(c.id);
  }
  relayoutText(draft, changed);
  syncDraft(draft, [cid]);
  return inst.groupId;
}

/**
 * Re-key nested property values (`npv`) of `cid`'s instances to the content-addressed inner
 * group ids (`canonicalInner`). `legacy` maps a master's own inner group ids to them; values
 * keyed by an instance's inner group (or the master group it was derived from) are mapped too.
 */
function rekeyNested(draft: Draft, cid: string, legacy?: ReadonlyMap<string, string>): void {
  const groups = new Map<string, El[]>();
  for (const el of draft.toArray()) {
    const t = tagFor(el, cid);
    const g = t?.role === "instance" ? groupOf(el, t) : null;
    if (!g || !t?.npv) continue;
    const list = groups.get(g);
    if (list) list.push(el);
    else groups.set(g, [el]);
  }
  for (const [group, els] of groups) {
    const canon = canonicalInner(instanceChildren(draft, cid, group), cid);
    const known = new Set(canon.values());
    const mapKey = (k: string) => {
      if (known.has(k)) return k;
      if (legacy?.has(k)) return legacy.get(k)!;
      for (const [h, m] of canon) if (h === k || stableId(group, k) === h) return m;
      return k;
    };
    for (const el of els) {
      const t = tagFor(el, cid)!;
      const npv = Object.fromEntries(Object.entries(t.npv!).map(([k, v]) => [mapKey(k), v]));
      if (JSON.stringify(npv) !== JSON.stringify(t.npv))
        draft.update(el.id, { customData: writeTags(el, swapTag(el, cid, { ...t, npv })) });
    }
  }
}

function swapTag(el: El, cid: string, tag: ComponentTag): ComponentTag[] {
  return tagsOf(el).map((t) => (t.componentId === cid ? tag : t));
}

/** The live master group of `cid`, if any. */
export function liveMasterGroup(draft: Draft, cid: string): string | null {
  for (const el of draft.live()) {
    const t = tagFor(el, cid);
    if (t?.role === "master") return groupOf(el, t);
  }
  return null;
}

/**
 * Turn a master into the component's first library-backed instance, in place (same ids, same
 * look): its tags become instance tags that record the master's geometry (`base`) and values
 * (`mv`), so the master can be rebuilt from it later. Returns the instance's group id.
 */
export function demoteMaster(draft: Draft, masterGroupId: unknown): string {
  const { cid, els } = masterGroupElements(draft, masterGroupId);
  const libraryId = els.map((e) => tagFor(e, cid)!.libraryId).find(Boolean) ?? cid;
  const legacy = canonicalInner(els, cid);
  markLibrary(draft, cid, libraryId);
  // Other instances record `mv` against this master before it goes.
  syncDraft(draft, [cid]);
  const live = masterGroupElements(draft, masterGroupId).els;
  const origin = originOf(live);
  for (const el of live) {
    const t = tagFor(el, cid)!;
    const mv = Object.fromEntries(
      OVERRIDE_KEYS.filter((k) => k !== "visible" && overridable(el, k)).map((k) => [
        k,
        masterValue(el, k) ?? null,
      ]),
    );
    const tag: ComponentTag = {
      ...t,
      role: "instance",
      base: baseOf(el, origin),
      mv,
      ms: lookOf(el),
      overrides: undefined,
      pv: undefined,
      npv: undefined,
      promoted: undefined,
    };
    draft.update(el.id, { customData: writeTags(el, swapTag(el, cid, tag)) });
  }
  rekeyNested(draft, cid, legacy);
  // The old master becomes an ordinary instance with no property values set, so it shows the
  // defaults (e.g. only the default branch of a choice) like a freshly inserted instance would.
  withMaster(draft, cid, () => syncDraft(draft, [cid]), masterGroupId as string);
  return masterGroupId as string;
}

/** A live instance group of `cid` that no other instance owns (the master can be rebuilt from it). */
function freeInstance(draft: Draft, cid: string, prefer?: string): string {
  let found: string | null = null;
  for (const el of draft.live()) {
    const t = tagFor(el, cid);
    if (t?.role !== "instance" || isOwned(el, cid)) continue;
    const g = groupOf(el, t);
    if (!g) continue;
    if (g === prefer) return g;
    found ??= g;
  }
  if (!found) throw new ToolError(`Component "${cid}" has no instance on this canvas`);
  return found;
}

/** Components whose masters or instances (transitively) contain `cid`, outermost first. */
function outerComponents(draft: Draft, cid: string): string[] {
  const outerOf = new Map<string, Set<string>>();
  for (const el of draft.live()) {
    const tags = tagsOf(el);
    for (const inner of tags)
      for (const outer of tags)
        if (outer.gi > inner.gi && outer.componentId !== inner.componentId) {
          let s = outerOf.get(inner.componentId);
          if (!s) outerOf.set(inner.componentId, (s = new Set()));
          s.add(outer.componentId);
        }
  }
  const depth = new Map<string, number>();
  const visit = (c: string, d: number, seen: Set<string>) => {
    for (const o of outerOf.get(c) ?? []) {
      if (seen.has(o)) continue;
      depth.set(o, Math.max(depth.get(o) ?? 0, d));
      visit(o, d + 1, new Set([...seen, o]));
    }
  };
  visit(cid, 1, new Set([cid]));
  return [...depth.keys()].sort((a, b) => depth.get(b)! - depth.get(a)! || (a < b ? -1 : 1));
}

/** Masters `openMaster` rebuilt (innermost last), to take off again with `closeMaster`. */
export interface OpenedMaster {
  componentId: string;
  masterGroupId: string;
  /** Masters rebuilt for this (outer components first, then the component itself). */
  rebuilt: Array<{ componentId: string; masterGroupId: string }>;
}

/**
 * Make sure `cid` has a master in the draft: when it has none, rebuild it (`materialize`) from
 * an instance, after rebuilding every outer component that holds copies of it, so a master edit
 * cascades into those copies. Pair with `closeMaster` in the same draft.
 */
export function openMaster(draft: Draft, cid: string, instance?: string): OpenedMaster {
  const rebuilt: OpenedMaster["rebuilt"] = [];
  const existing = liveMasterGroup(draft, cid);
  if (existing) return { componentId: cid, masterGroupId: existing, rebuilt };
  for (const o of outerComponents(draft, cid)) {
    if (liveMasterGroup(draft, o)) continue;
    if (!draft.live().some((e) => tagFor(e, o)?.source === "library")) continue;
    rebuilt.push({ componentId: o, masterGroupId: materialize(draft, freeInstance(draft, o)) });
  }
  const group = materialize(draft, freeInstance(draft, cid, instance));
  rebuilt.push({ componentId: cid, masterGroupId: group });
  return { componentId: cid, masterGroupId: group, rebuilt };
}

/**
 * Take the masters `openMaster` rebuilt off again (innermost first) and forget them: the
 * instances keep what the masters gave them, and nothing of the masters reaches the canvas.
 */
export function closeMaster(draft: Draft, opened: OpenedMaster): void {
  for (const { masterGroupId } of [...opened.rebuilt].reverse())
    dematerialize(draft, masterGroupId);
  if (!opened.rebuilt.length) return;
  for (const el of draft.toArray())
    if (el.isDeleted && !draft.original.has(el.id)) draft.discard(el.id);
}

/**
 * Run `fn` with `cid`'s master present (rebuilt for the duration when it lives off-canvas), so
 * actions that derive instances from the master work on masterless components too.
 */
export function withMaster<T>(
  draft: Draft,
  cid: string,
  fn: (masterGroupId: string) => T,
  instance?: string,
): T {
  const opened = openMaster(draft, cid, instance);
  const out = fn(opened.masterGroupId);
  closeMaster(draft, opened);
  return out;
}

/** The component of an instance ref (group id or child id), for `withMaster`. */
export function componentOfInstance(draft: Draft, instance: unknown): string {
  return resolveInstance(draft, instance).componentId;
}

/** Copy of a component's master: its elements and the image file ids they use. */
export interface MasterSnapshot {
  componentId: string;
  masterGroupId: string;
  name?: string;
  elements: El[];
  files: string[];
}

function fileIdsOf(els: readonly El[]): string[] {
  return [
    ...new Set(
      els.flatMap((e) =>
        e.type === "image" && (e as { fileId?: string | null }).fileId
          ? [(e as { fileId: string }).fileId]
          : [],
      ),
    ),
  ];
}

/**
 * The master of `cid` as it would be rebuilt (never committed): the live master's elements when
 * there is one, else rebuilt from `instance` (or any instance). For the master-edit overlay and
 * for saving a masterless component to My components.
 */
export function masterSnapshot(
  elements: readonly El[],
  cid: string,
  instance?: string,
): MasterSnapshot {
  const draft = new Draft(elements);
  const { masterGroupId } = openMaster(draft, cid, instance);
  const els = masterGroupElements(draft, masterGroupId).els.map((e) => structuredClone(e));
  const out: MasterSnapshot = {
    componentId: cid,
    masterGroupId,
    elements: els,
    files: fileIdsOf(els),
  };
  const name = els.map((e) => tagFor(e, cid)?.name).find(Boolean);
  if (name) out.name = name;
  return out;
}

/**
 * Replace `cid`'s master with `edited` (e.g. a `masterSnapshot` edited elsewhere) and update
 * every instance, nested copies included, in this draft. Elements without a tag for `cid` become
 * new master children; master children missing from `edited` are removed from the component.
 * When the master lives off-canvas it's rebuilt for the edit and taken off again, so only the
 * instances change. Returns the component's master group id (or null when it's off-canvas).
 */
export function applyMasterEdit(draft: Draft, cid: string, edited: readonly El[]): string | null {
  const els = edited.filter((e) => !e.isDeleted);
  if (!els.length) throw new ToolError("A component needs at least one element");
  const opened = openMaster(draft, cid);
  replaceMaster(draft, cid, opened.masterGroupId, els);
  closeMaster(draft, opened);
  return opened.rebuilt.length ? null : opened.masterGroupId;
}

function replaceMaster(draft: Draft, cid: string, group: string, edited: readonly El[]): void {
  const current = masterGroupElements(draft, group).els;
  const currentIds = new Set(current.map((e) => e.id));
  // The edited copy's own master group (from its tags), mapped onto the live one.
  const counts = new Map<string, number>();
  for (const e of edited) {
    const t = tagFor(e, cid);
    const g = t && groupOf(e, t);
    if (g) counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  const from = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  const idMap = new Map<string, string>();
  for (const e of edited)
    idMap.set(e.id, currentIds.has(e.id) || !draft.has(e.id) ? e.id : newId());
  const remap = (id: string | null | undefined) => (id ? (idMap.get(id) ?? id) : id);
  const keep = new Set<string>();
  for (const e of edited) {
    const id = idMap.get(e.id)!;
    let groupIds = e.groupIds.map((g) => (g === from ? group : g));
    if (!groupIds.includes(group)) groupIds = [...groupIds, group];
    const gi = groupIds.indexOf(group);
    // Only memberships inside the master group survive; this component's tag becomes the master's.
    const tags = tagsOf(e)
      .filter((t) => t.componentId !== cid && t.gi < gi)
      .map((t) => ({ ...t }));
    const own = tagFor(e, cid);
    if (own) tags.push({ ...masterTag(own), gi });
    const r = e as unknown as Record<string, unknown>;
    const patch: Record<string, unknown> = {
      ...r,
      id,
      groupIds,
      isDeleted: false,
      customData: writeTags(e, tags),
      boundElements: e.boundElements?.map((b) => ({ ...b, id: remap(b.id)! })) ?? null,
    };
    if (e.type === "text") patch.containerId = remap((e as TextEl).containerId) ?? null;
    for (const end of ["startBinding", "endBinding"]) {
      const b = r[end] as { elementId: string } | null | undefined;
      if (b) patch[end] = { ...b, elementId: remap(b.elementId) };
    }
    if (currentIds.has(id)) {
      const { id: _id, version: _v, versionNonce: _n, updated: _u, index: _i, ...rest } = patch;
      draft.update(id, rest);
    } else
      draft.add(
        newElementWith(
          { ...patch, index: null, version: 1, locked: false } as unknown as El,
          {},
          true,
        ),
      );
    keep.add(id);
  }
  for (const e of current) if (!keep.has(e.id)) draft.update(e.id, { isDeleted: true });
  syncDraft(draft, [cid]);
}

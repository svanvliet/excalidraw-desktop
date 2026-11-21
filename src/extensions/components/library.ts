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
import { inferTransform, isBoundText, isPointy, placeGeometry, translation } from "./geometry";
import {
  groupOf,
  innerTags,
  OVERRIDE_KEYS,
  tagFor,
  tagsOf,
  writeTags,
  type ComponentTag,
  type OverrideKey,
} from "./model";
import { resolveInstance, syncDraft } from "./actions";
import { currentValue, overridable, propOverrides } from "./sync";
import { layoutBoundText, measureFreeText } from "./text";

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
    if (t.autoResize === false) continue;
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
  const children = instanceChildren(draft, cid, inst.groupId);
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
      if (!m) innerMap.set(g, (m = newId()));
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

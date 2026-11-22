/**
 * Component properties view (FR-56, D-DX11): a component's typed properties, shown inside the
 * "Component" strip row (D-DX19 merged the former separate "Properties" row into it).
 *
 *  - An instance (or a whole outer instance): edit its property values, then those of each nested
 *    component inside it that declares properties.
 *  - A master: list the declared properties, remove them, declare new ones bound to a slot.
 *  - Anything else (plain shapes, mixed selections, an instance with no properties): hidden.
 */
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { Draft, type El } from "../../agent/scene/draft";
import { instanceProperties } from "../../extensions/components/actions";
import {
  groupOf,
  listComponents,
  tagFor,
  tagOf,
  type PropDef,
  type PropValues,
} from "../../extensions/components/model";

export interface PropTargetView {
  /** null: the instance's own component; else the nested instance's group in the outer master. */
  nested: string | null;
  title: string;
  props: PropDef[];
  values: PropValues;
}

export interface SlotChoice {
  id: string;
  label: string;
}

export type PropsView =
  | { kind: "instance"; componentId: string; groupId: string; targets: PropTargetView[] }
  | {
      kind: "master";
      componentId: string;
      name: string;
      props: PropDef[];
      /** Master elements a new property can bind to (bound labels come with their container). */
      slots: SlotChoice[];
    };

function slotLabel(el: El): string {
  const type = el.type.charAt(0).toUpperCase() + el.type.slice(1);
  if (el.type === "text") {
    const t = (el as { text?: string }).text?.trim().replace(/\s+/g, " ") ?? "";
    return t ? `Text "${t.length > 20 ? `${t.slice(0, 19)}…` : t}"` : type;
  }
  return type;
}

export function propsView(
  selected: readonly ExcalidrawElement[],
  scene: readonly ExcalidrawElement[],
): PropsView | null {
  const els = scene as readonly El[];
  const tags = selected.map((e) => tagOf(e as El));
  const first = tags[0];
  if (!first || tags.some((t) => !t || t.componentId !== first.componentId)) return null;
  if (tags.some((t) => t!.role !== first.role)) return null;
  const groupId = groupOf(selected[0] as El, first);
  if (!groupId || selected.some((e, i) => groupOf(e as El, tags[i]) !== groupId)) return null;
  const cid = first.componentId;
  const infos = listComponents(els);
  const info = infos.find((c) => c.componentId === cid);
  const nameOf = (id: string) => infos.find((c) => c.componentId === id)?.name ?? "Component";

  if (first.role === "master") {
    if (!info || info.masterGroupId !== groupId) return null;
    const slots = info.masterIds
      .map((id) => els.find((e) => e.id === id))
      .filter((e): e is El => !!e && !(e.type === "text" && e.containerId))
      .map((e) => ({ id: e.id, label: slotLabel(e) }));
    return {
      kind: "master",
      componentId: cid,
      name: info.name ?? "Component",
      props: info.props,
      slots,
    };
  }

  // Cheap gate before building a draft: no properties here and nothing nested.
  const kids = els.filter((e) => !e.isDeleted && groupOf(e, tagFor(e, cid)) === groupId);
  if (!kids.some((e) => tagFor(e, cid)?.props?.length) && !info?.uses.length) return null;
  let targets: PropTargetView[];
  try {
    targets = instanceProperties(new Draft(els), groupId).map((t) => ({
      nested: t.nestedKey ?? null,
      title: t.nestedKey ? nameOf(t.componentId) : (info?.name ?? "Component"),
      props: t.props,
      values: t.values,
    }));
  } catch {
    return null;
  }
  targets = targets.filter((t) => t.props.length);
  if (!targets.length) return null;
  return { kind: "instance", componentId: cid, groupId, targets };
}

/** "Primary=#228be6, Danger=#e03131" → options + map (opacity values become numbers). */
export function parseChoices(
  text: string,
  key: string,
): { options: string[]; map: Record<string, unknown> } {
  const options: string[] = [];
  const map: Record<string, unknown> = {};
  for (const part of text.split(/[,\n]/)) {
    const [rawName, ...rest] = part.split("=");
    const name = rawName.trim();
    if (!name || options.includes(name)) continue;
    options.push(name);
    const raw = rest.join("=").trim();
    if (raw) map[name] = key === "opacity" ? Number(raw) : raw;
    else if (key === "text") map[name] = name;
  }
  return { options, map };
}

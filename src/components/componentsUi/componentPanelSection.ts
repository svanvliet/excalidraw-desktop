/**
 * "Component" properties-panel section (FR-55): what the selection is in the component system and
 * what you can do with it.
 *
 *  - Plain shapes: Create component.
 *  - A master (only inside the master editor, or in drawings from older builds): name, instance
 *    count, Save to / Update in My components.
 *  - An instance: Edit master… (opens the master editor overlay, FR-66), Save, Reset all,
 *    Detach, and each overridden slot with its own reset.
 *  - Anything mixed (several components, or component + plain shapes): hidden.
 *
 * The row also carries the component's typed properties (FR-56): D-DX19 merged the former
 * "Properties" row into this one.
 */
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { El } from "../../agent/scene/draft";
import { CONTENT_KEYS, groupOf, listComponents, tagOf } from "../../extensions/components/model";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { createComponentFromSelection } from "../../extensions/components/host";
import { ComponentsIcon } from "../icons";
import type { PanelSection } from "../propertiesPanel/panel";
import { propsView, type PropsView } from "../componentProps/propsPanelSection";
import { ComponentRow } from "./ComponentRow";
import { librarySourceOf } from "./libraryCodec";

export interface SlotOverride {
  slot: string;
  label: string;
  keys: string[];
}

export type ComponentView =
  | { kind: "create"; count: number }
  | {
      kind: "master";
      componentId: string;
      name: string;
      groupId: string;
      instances: number;
    }
  | {
      kind: "instance";
      componentId: string;
      name: string;
      groupId: string;
      /** The master is on the canvas. */
      hasMaster: boolean;
      /** The master lives in My components (`libraryId` names the entry). */
      libraryBacked: boolean;
      libraryId: string | null;
      overrides: SlotOverride[];
    };

/**
 * The My components entry this component is linked to, or null when this machine's My components
 * doesn't have it. A created or demoted component carries a library link before it is ever saved,
 * so "from My components" and "Update in My components" must check the entry really exists (the
 * master editor's "Also update in My components" uses the same rule).
 */
export function linkedEntryId(view: ComponentView, entryIds: readonly string[]): string | null {
  if (view.kind === "create") return null;
  const id = (view.kind === "instance" && view.libraryId) || view.componentId;
  return entryIds.includes(id) ? id : null;
}

const KEY_LABELS: Record<string, string> = {
  text: "text",
  backgroundColor: "fill",
  strokeColor: "stroke",
  opacity: "opacity",
  link: "link",
  fileId: "image",
  fontSize: "font size",
};

/** Overrides "Reset overrides" clears: everything but content (text, image, link) — FR-67. */
export const hasStyleOverrides = (overrides: readonly SlotOverride[]) =>
  overrides.some((o) => o.keys.some((k) => !CONTENT_KEYS.includes(k)));

export const keyLabel = (k: string) => KEY_LABELS[k] ?? k;

function slotLabel(el: El): string {
  if (el.type === "text") {
    const t = (el as { text?: string }).text?.trim().replace(/\s+/g, " ") ?? "";
    return t ? `Text "${t.length > 24 ? `${t.slice(0, 23)}…` : t}"` : "Text";
  }
  return el.type.charAt(0).toUpperCase() + el.type.slice(1);
}

export function componentView(
  selected: readonly ExcalidrawElement[],
  scene: readonly ExcalidrawElement[],
): ComponentView | null {
  const tags = selected.map((e) => tagOf(e as El));
  if (tags.every((t) => !t)) {
    // Bound text comes along with its container; frames can't be components.
    if (selected.some((e) => e.type === "frame" || e.type === "magicframe")) return null;
    return { kind: "create", count: selected.length };
  }
  if (tags.some((t) => !t)) return null;
  const first = tags[0]!;
  const groupId = groupOf(selected[0] as El, first);
  if (
    !groupId ||
    tags.some((t) => t!.componentId !== first.componentId || t!.role !== first.role) ||
    selected.some((e, i) => groupOf(e as El, tags[i]) !== groupId)
  )
    return null;
  const info = listComponents(scene as readonly El[]).find(
    (c) => c.componentId === first.componentId,
  );
  const name = info?.name ?? first.name ?? "Component";
  if (first.role === "master") {
    return {
      kind: "master",
      componentId: first.componentId,
      name,
      groupId,
      instances: info?.instances.length ?? 0,
    };
  }
  const children = (scene as readonly El[]).filter((e) => {
    const t = tagOf(e);
    return t?.role === "instance" && groupOf(e, t) === groupId;
  });
  const overrides: SlotOverride[] = [];
  for (const c of children) {
    const tag = tagOf(c);
    const keys = Object.keys(tag?.overrides ?? {});
    if (typeof tag?.fs === "number") keys.push("fontSize");
    if (keys.length) overrides.push({ slot: tagOf(c)!.slot, label: slotLabel(c), keys });
  }
  const source = children.map(librarySourceOf).find(Boolean) ?? null;
  return {
    kind: "instance",
    componentId: first.componentId,
    name,
    groupId,
    hasMaster: !!info?.masterGroupId,
    libraryBacked: !!source,
    libraryId: source?.libraryId ?? null,
    overrides,
  };
}

/** The Component row's view: the component plus its properties (null when it has none). */
export type ComponentRowView = ComponentView & { props: PropsView | null };

export const componentPanelSection: PanelSection<ComponentRowView> = {
  id: "component",
  slot: "top",
  testId: "component-props",
  title: "Component",
  icon: ComponentsIcon,
  summary: (v) => {
    // The inline Create action says it all.
    if (v.kind === "create") return "";
    if (v.kind === "master") {
      return `${v.name} · master · ${v.instances} instance${v.instances === 1 ? "" : "s"}`;
    }
    const n = v.overrides.length;
    return n ? `${v.name} · ${n} override${n === 1 ? "" : "s"}` : v.name;
  },
  primary: (v) =>
    v.kind === "create"
      ? {
          label: "Create",
          title: "Create component (Alt/Option + Cmd/Ctrl + K)",
          run: (api) => createComponentFromSelection(api as ExcalidrawImperativeAPI),
        }
      : null,
  view: ({ api, selected }) => {
    const scene = api.getSceneElements();
    const view = componentView(selected, scene);
    if (!view) return null;
    return { ...view, props: view.kind === "create" ? null : propsView(selected, scene) };
  },
  Component: ComponentRow,
};

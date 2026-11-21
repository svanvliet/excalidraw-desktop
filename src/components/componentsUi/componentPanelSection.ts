/**
 * "Component" properties-panel section (FR-55): what the selection is in the component system and
 * what you can do with it.
 *
 *  - Plain shapes: Create component.
 *  - A master: name, instance count, Save to / Move to My components.
 *  - An instance: Go to master (or Edit master… when the master lives in My components), Save,
 *    Reset all, Detach, and each overridden slot with its own reset.
 *  - Anything mixed (several components, or component + plain shapes): hidden.
 */
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { El } from "../../agent/scene/draft";
import { groupOf, listComponents, tagOf } from "../../extensions/components/model";
import type { PanelSection } from "../propertiesPanel/panel";
import { ComponentSection } from "./ComponentSection";
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

const KEY_LABELS: Record<string, string> = {
  text: "text",
  backgroundColor: "fill",
  strokeColor: "stroke",
  opacity: "opacity",
  link: "link",
  fileId: "image",
};

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
    const keys = Object.keys(tagOf(c)?.overrides ?? {});
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

export const componentPanelSection: PanelSection<ComponentView> = {
  id: "component",
  slot: "bottom",
  testId: "component-props",
  view: ({ api, selected }) => componentView(selected, api.getSceneElements()),
  Component: ComponentSection,
};

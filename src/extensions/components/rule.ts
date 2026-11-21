/**
 * Reactor rule for Components (key = componentId). Master children (and elements drawn into a
 * master group) are sources, instance children are targets; every change runs `syncComponent`
 * for that component, then for the components nesting it (`syncCascade`). An element can be in
 * several components at once (nested components), so it links to each.
 */
import type { El, ReactorLink, ReactorRule } from "../reactor/reactor";
import { groupOf, readTags } from "./model";
import { syncCascade } from "./sync";

export interface ComponentRule extends ReactorRule {
  /** Component of a master group (index kept by `links`). */
  componentOfGroup(groupId: string): string | undefined;
}

export function createComponentRule(): ComponentRule {
  /** master group id → componentId */
  const masterGroups = new Map<string, string>();
  /** instance child id → last overridable values */
  const memory = new Map<string, Record<string, unknown>>();

  const links = (el: El): readonly ReactorLink[] => {
    const tags = readTags(el);
    if (!tags) return [];
    const out: ReactorLink[] = [];
    for (const tag of tags) {
      if (tag.role === "master" && !el.isDeleted) {
        const g = groupOf(el, tag);
        if (g) masterGroups.set(g, tag.componentId);
      }
      out.push({ role: tag.role === "master" ? "source" : "target", key: tag.componentId });
    }
    if (el.isDeleted) return out;
    for (const g of el.groupIds) {
      const cid = masterGroups.get(g);
      if (cid && !out.some((l) => l.key === cid)) out.push({ role: "source", key: cid });
    }
    return out;
  };

  return {
    name: "components",
    links,
    componentOfGroup: (g) => masterGroups.get(g),
    reset() {
      masterGroups.clear();
      memory.clear();
    },
    reconcile(key, change, ctx) {
      syncCascade([key], ctx, { changed: change.targets, memory });
    },
  };
}

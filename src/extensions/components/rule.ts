/**
 * Reactor rule for Components v1 (key = componentId). Master children (and untagged elements
 * drawn into a master group) are sources, instance children are targets; every change runs
 * `syncComponent` for that component.
 */
import type { El, ReactorLink, ReactorRule } from "../reactor/reactor";
import { groupOf, hasAnyTag, tagOf } from "./model";
import { syncComponent } from "./sync";

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
    const tag = tagOf(el);
    if (tag) {
      if (tag.role === "master" && !el.isDeleted) {
        const g = groupOf(el, tag);
        if (g) masterGroups.set(g, tag.componentId);
      }
      return [{ role: tag.role === "master" ? "source" : "target", key: tag.componentId }];
    }
    if (hasAnyTag(el) || el.isDeleted) return [];
    for (const g of el.groupIds) {
      const cid = masterGroups.get(g);
      if (cid) return [{ role: "source", key: cid }];
    }
    return [];
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
      syncComponent(key, ctx, { changed: change.targets, memory });
    },
  };
}

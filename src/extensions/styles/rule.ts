/**
 * Reactor rule for named styles (key = style id). Every linked element is a target of its style;
 * any change runs `syncStyle` for that style. Component instance children are not linked: they
 * follow their master through the components rule, which runs after this one (D-DX12).
 */
import type { El, ReactorLink, ReactorRule } from "../reactor/reactor";
import { isInstanceChild, styleTagOf, type StyleProps } from "./model";
import { syncStyle } from "./sync";

export function createStyleRule(): ReactorRule {
  /** element id → style values last seen */
  const memory = new Map<string, StyleProps>();
  return {
    name: "styles",
    links(el: El): readonly ReactorLink[] {
      const tag = styleTagOf(el);
      if (!tag || isInstanceChild(el)) return [];
      return [{ role: "target", key: tag.id }];
    },
    reset() {
      memory.clear();
    },
    reconcile(key, change, ctx) {
      syncStyle(key, ctx, { changed: change.targets, memory });
    },
  };
}

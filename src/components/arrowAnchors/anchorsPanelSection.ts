/**
 * "Anchors" properties-panel section: pin a bound elbow arrow's ends to a side of their shapes
 * (docs/plan.md D-DX8), or a straight / curved arrow's ends to a face midpoint or the centre
 * (D-DX15).
 */
import { isElbowArrow, type Anchor } from "../../lib/elbowAnchors";
import { endAnchors, isArrow } from "../../lib/lineAnchors";
import type { PanelSection } from "../propertiesPanel/panel";
import { AnchorsSection } from "./AnchorsSection";

export interface EndView {
  /** Whether this end is bound to a shape. */
  bound: boolean;
  /** The pinned anchor, or null when the end is free / at a custom point. */
  anchor: Anchor | null;
}

export interface AnchorsView {
  id: string;
  elbow: boolean;
  start: EndView;
  end: EndView;
}

export const anchorsPanelSection: PanelSection<AnchorsView> = {
  id: "anchors",
  slot: "bottom",
  testId: "arrow-anchors",
  view({ selected }) {
    if (selected.length !== 1) return null;
    const arrow = selected[0];
    if (!isArrow(arrow) || (!arrow.startBinding && !arrow.endBinding)) return null;
    const anchors = endAnchors(arrow);
    return {
      id: arrow.id,
      elbow: isElbowArrow(arrow),
      start: { bound: !!arrow.startBinding, anchor: anchors.start },
      end: { bound: !!arrow.endBinding, anchor: anchors.end },
    };
  },
  Component: AnchorsSection,
};

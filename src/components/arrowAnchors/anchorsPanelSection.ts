/**
 * "Anchors" properties-panel section (docs/plan.md D-DX7): pin a bound elbow arrow's ends to a
 * side of their shapes.
 */
import { isElbowArrow, sideOf, type Side } from "../../lib/elbowAnchors";
import type { PanelSection } from "../propertiesPanel/panel";
import { AnchorsSection } from "./AnchorsSection";

export interface EndView {
  /** null = this end isn't bound to a shape. */
  bound: boolean;
  /** The pinned side, or null when the end is free / at a custom point. */
  side: Side | null;
}

export interface AnchorsView {
  id: string;
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
    if (!isElbowArrow(arrow) || (!arrow.startBinding && !arrow.endBinding)) return null;
    return {
      id: arrow.id,
      start: { bound: !!arrow.startBinding, side: sideOf(arrow.startBinding?.fixedPoint) },
      end: { bound: !!arrow.endBinding, side: sideOf(arrow.endBinding?.fixedPoint) },
    };
  },
  Component: AnchorsSection,
};

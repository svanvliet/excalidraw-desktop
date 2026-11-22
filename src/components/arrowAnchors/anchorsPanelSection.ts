/**
 * "Anchors" properties-panel section: pin a bound elbow arrow's ends to a side of their shapes
 * (docs/plan.md D-DX8), or a straight / curved arrow's ends to a face midpoint or the centre
 * (D-DX15).
 */
import { isElbowArrow, type Anchor } from "../../lib/elbowAnchors";
import { endAnchors, isArrow } from "../../lib/lineAnchors";
import { AnchorCenterIcon } from "../icons";
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

const ANCHOR_NAMES: Record<Anchor | "free", string> = {
  n: "top",
  e: "right",
  s: "bottom",
  w: "left",
  center: "centre",
  free: "free",
};

export const anchorsPanelSection: PanelSection<AnchorsView> = {
  id: "anchors",
  slot: "top",
  testId: "arrow-anchors",
  title: "Anchors",
  icon: AnchorCenterIcon,
  summary: ({ start, end }) =>
    [
      start.bound && `start: ${ANCHOR_NAMES[start.anchor ?? "free"]}`,
      end.bound && `end: ${ANCHOR_NAMES[end.anchor ?? "free"]}`,
    ]
      .filter(Boolean)
      .join(" · "),
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

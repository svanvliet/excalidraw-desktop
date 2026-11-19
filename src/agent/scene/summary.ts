/** Compact, model-friendly rows for scene summaries (one row per element). */
import { type Draft, type El, isLinear, isText } from "./draft";

export interface SummaryRow {
  id: string;
  type: string;
  x: number;
  y: number;
  w: number;
  h: number;
  text?: string;
  label?: string;
  labelId?: string;
  stroke?: string;
  bg?: string;
  from?: string;
  to?: string;
  groups?: readonly string[];
  frame?: string;
  locked?: true;
  angle?: number;
  link?: string;
}

const r = (n: number) => Math.round(n);
const DEFAULT_STROKE = "#1e1e1e";

/** True for text that lives inside a live container — folded into the container's row. */
export function isFoldedText(draft: Draft, el: El): boolean {
  return isText(el) && !!el.containerId && !!draft.get(el.containerId);
}

export function rowOf(draft: Draft, el: El): SummaryRow {
  const row: SummaryRow = {
    id: el.id,
    type: el.type,
    x: r(el.x),
    y: r(el.y),
    w: r(el.width),
    h: r(el.height),
  };
  if (isText(el)) {
    row.text = el.text;
  } else {
    const label = draft.boundTextOf(el);
    if (label) {
      row.label = label.text;
      row.labelId = label.id;
    }
  }
  if (el.strokeColor && el.strokeColor !== DEFAULT_STROKE) row.stroke = el.strokeColor;
  if (el.backgroundColor && el.backgroundColor !== "transparent") row.bg = el.backgroundColor;
  if (isLinear(el)) {
    if (el.startBinding) row.from = el.startBinding.elementId;
    if (el.endBinding) row.to = el.endBinding.elementId;
  }
  if (el.groupIds.length) row.groups = el.groupIds;
  if (el.frameId) row.frame = el.frameId;
  if (el.locked) row.locked = true;
  if (el.angle) row.angle = Math.round(el.angle * 1000) / 1000;
  if (el.link) row.link = el.link;
  return row;
}

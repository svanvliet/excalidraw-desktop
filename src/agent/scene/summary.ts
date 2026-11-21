/** Compact, model-friendly rows for scene summaries (one row per element). */
import { elementStyleInfo } from "../../extensions/styles/model";
import { extensionStateOf } from "../../extensions/stack";
import { elementComponentInfo } from "../../extensions/components/model";
import { isElbowArrow, sideOf } from "../../lib/elbowAnchors";
import { dataRecord } from "../../lib/shapeData";
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
  /** Applied desktop extensions → params (docs/extensions.md). */
  ext?: Record<string, Record<string, unknown>>;
  /** Extensions whose stored intent no longer matches the element (edited elsewhere). */
  extStale?: string[];
  /** Shape data (docs/plan.md D-DX2). */
  data?: Record<string, string>;
  elbow?: true;
  startAnchor?: string;
  endAnchor?: string;
  /** Component membership (docs/components.md). */
  cmp?: {
    id: string;
    role: "master" | "instance";
    slot: string;
    group: string | null;
    overrides?: string[];
  };
  /** Named style link (docs/styles.md); ov: locally overridden style keys. */
  sty?: { id: string; ov?: string[]; fromMaster?: true };
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
  if (isElbowArrow(el)) {
    row.elbow = true;
    const start = sideOf(el.startBinding?.fixedPoint);
    const end = sideOf(el.endBinding?.fixedPoint);
    if (start) row.startAnchor = start;
    if (end) row.endAnchor = end;
  }
  if (el.groupIds.length) row.groups = el.groupIds;
  if (el.frameId) row.frame = el.frameId;
  if (el.locked) row.locked = true;
  if (el.angle) row.angle = Math.round(el.angle * 1000) / 1000;
  if (el.link) row.link = el.link;
  const ext = extensionStateOf(el);
  if (ext && Object.keys(ext.applied).length) row.ext = ext.applied;
  if (ext?.stale.length) row.extStale = ext.stale;
  const data = dataRecord(el);
  if (data) row.data = data;
  const cmp = elementComponentInfo(el);
  if (cmp) {
    row.cmp = { id: cmp.componentId, role: cmp.role, slot: cmp.slot, group: cmp.groupId };
    if (cmp.overrides) row.cmp.overrides = Object.keys(cmp.overrides);
  }
  const sty = elementStyleInfo(el, (id) => draft.peek(id));
  if (sty) {
    row.sty = { id: sty.styleId };
    if (sty.overrides) row.sty.ov = sty.overrides;
    if (sty.fromMaster) row.sty.fromMaster = true;
  }
  return row;
}

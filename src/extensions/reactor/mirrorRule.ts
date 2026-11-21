/**
 * EXPERIMENTAL (reactor spike). A "mirror" rule standing in for Components v1 instances: every
 * target copies its source's geometry (plus a fixed offset) and style; bound text copies the
 * source's text unless overridden, in which case it is re-measured inside the target container.
 *
 * Link data lives in `customData["excalidrawDesktop.reactorSpike"]`:
 * - source: `{ role: "source", key }`
 * - target: `{ role: "target", key, dx, dy, overrides?: { text?, backgroundColor? } }`
 *
 * Never derived: ids, groupIds, frameId, boundElements, containerId, customData, index, version
 * fields, isDeleted, link, locked — so instance identity, grouping and arrow bindings stay local.
 */
import type { ExcalidrawTextElement } from "@excalidraw/excalidraw/element/types";
import type { DeriveContext, El, Patch, ReactorLink, ReactorRule } from "./reactor";
import { measureBoundText } from "./textLayout";

export const MIRROR_KEY = "excalidrawDesktop.reactorSpike";

export interface MirrorOverrides {
  text?: string;
  backgroundColor?: string;
}

export type MirrorLink =
  | { role: "source"; key: string }
  | { role: "target"; key: string; dx: number; dy: number; overrides?: MirrorOverrides };

export function mirrorLinkOf(el: El): MirrorLink | undefined {
  const raw = (el.customData as Record<string, unknown> | undefined)?.[MIRROR_KEY];
  if (!raw || typeof raw !== "object") return undefined;
  const l = raw as MirrorLink;
  if ((l.role !== "source" && l.role !== "target") || typeof l.key !== "string") return undefined;
  return l;
}

export function withMirrorLink<T extends El>(el: T, link: MirrorLink): T {
  return { ...el, customData: { ...(el.customData ?? {}), [MIRROR_KEY]: link } };
}

const STYLE_KEYS = [
  "strokeColor",
  "backgroundColor",
  "fillStyle",
  "strokeWidth",
  "strokeStyle",
  "roughness",
  "opacity",
  "roundness",
] as const;

const TEXT_KEYS = [
  "fontSize",
  "fontFamily",
  "textAlign",
  "verticalAlign",
  "lineHeight",
  "autoResize",
] as const;

function deriveMirror(target: El, source: El, ctx: DeriveContext): Patch | null {
  const link = mirrorLinkOf(target);
  if (link?.role !== "target" || target.type !== source.type) return null;
  const src = source as unknown as Record<string, unknown>;
  const patch: Patch = {
    x: source.x + link.dx,
    y: source.y + link.dy,
    width: source.width,
    height: source.height,
    angle: source.angle,
  };
  for (const k of STYLE_KEYS) patch[k] = src[k];
  if (link.overrides?.backgroundColor !== undefined)
    patch.backgroundColor = link.overrides.backgroundColor;

  if (target.type === "text") {
    for (const k of TEXT_KEYS) if (k in src) patch[k] = src[k];
    const t = target as ExcalidrawTextElement;
    const override = link.overrides?.text;
    if (override === undefined) {
      patch.text = (source as ExcalidrawTextElement).text;
      patch.originalText = (source as ExcalidrawTextElement).originalText;
    } else {
      const container = t.containerId ? ctx.get(t.containerId) : undefined;
      const styled = { ...t, ...patch } as ExcalidrawTextElement;
      const measured = container && measureBoundText(container, styled, override);
      if (measured) {
        delete patch.width;
        delete patch.height;
        Object.assign(patch, measured.text);
      } else {
        patch.text = override;
        patch.originalText = override;
      }
    }
  }
  return patch;
}

export const mirrorRule: ReactorRule = {
  name: "mirror",
  links(el): readonly ReactorLink[] {
    const l = mirrorLinkOf(el);
    return l ? [{ role: l.role, key: l.key }] : [];
  },
  derive: deriveMirror,
};

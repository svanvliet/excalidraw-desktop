/**
 * Pure geometry for the mask extension: params validation and the plan step that turns the
 * image's base plan into a circle / rounded-rectangle plan. No DOM here (see ../pipeline.ts).
 */
import { clampPx, type ImagePlan } from "../pipeline";

export type MaskShape = "circle" | "roundedRect";

export type MaskParams = {
  shape: MaskShape;
  /** Corner radius for `roundedRect`, in % of the shorter side (0–50). */
  radius?: number;
};

export const DEFAULT_RADIUS = 15;
export const maskParamsSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["shape"],
  properties: {
    shape: { type: "string", enum: ["circle", "roundedRect"] },
    radius: {
      type: "number",
      minimum: 0,
      maximum: 50,
      default: DEFAULT_RADIUS,
      description: "roundedRect corner radius, % of the shorter side",
    },
  },
};

/** Validates unknown input and fills defaults. Throws a readable Error on bad input. */
export function normalizeMaskParams(input: unknown): MaskParams {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("mask: params must be an object");
  }
  const p = input as Record<string, unknown>;
  for (const k of Object.keys(p)) {
    if (k !== "shape" && k !== "radius") throw new Error(`mask: unknown param "${k}"`);
  }
  if (p.shape === "circle") {
    if (p.radius !== undefined) throw new Error("mask: radius only applies to roundedRect");
    return { shape: "circle" };
  }
  if (p.shape === "roundedRect") {
    const radius = p.radius === undefined ? DEFAULT_RADIUS : p.radius;
    if (typeof radius !== "number" || !Number.isFinite(radius) || radius < 0 || radius > 50) {
      throw new Error("mask: radius must be a number between 0 and 50");
    }
    return { shape: "roundedRect", radius };
  }
  throw new Error('mask: shape must be "circle" or "roundedRect"');
}

/**
 * Circle: the largest centred square of the element (and the matching source region), output at
 * square pixels, ellipse outline. Rounded rectangle: same bounds, rounded outline. Both shapes are
 * centred and symmetric, so flips (`element.scale`) don't need baking.
 */
export function maskStep(plan: ImagePlan, params: MaskParams): ImagePlan {
  const el = plan.element;
  const src = plan.sourceRect;
  if (params.shape === "circle") {
    const side = Math.min(el.width, el.height);
    const sw = side * (src.width / el.width);
    const sh = side * (src.height / el.height);
    const n = clampPx(side * plan.density);
    return {
      ...plan,
      sourceRect: {
        x: src.x + (src.width - sw) / 2,
        y: src.y + (src.height - sh) / 2,
        width: sw,
        height: sh,
      },
      element: {
        x: el.x + (el.width - side) / 2,
        y: el.y + (el.height - side) / 2,
        width: side,
        height: side,
      },
      outWidth: n,
      outHeight: n,
      outline: { kind: "ellipse" },
    };
  }
  const pct = params.radius ?? DEFAULT_RADIUS;
  const { outWidth: w, outHeight: h } = plan;
  return {
    ...plan,
    outline: {
      kind: "roundedRect",
      radiusPx: Math.min((pct / 100) * Math.min(w, h), w / 2, h / 2),
    },
  };
}

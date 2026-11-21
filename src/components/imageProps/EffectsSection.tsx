/**
 * Image effect sections (docs/extensions.md § "Grayscale", "Tint", "Shadow"): a grayscale amount,
 * a tint colour + strength and a drop shadow (colour, opacity, blur, offset). Self-contained so it
 * registers as one image section; its props match the panel host's `ImageSectionProps`.
 * Every commit is one `run` call, so one undo step.
 */
import type { ExtensionGroup } from "../../extensions/groups";
import { patchParams } from "../../extensions/groups";
import type { ExtensionAction } from "../../extensions/runner";
import { RangeControl } from "./RangeControl";
import { StrokeColorPicker } from "./StrokeColorPicker";
import { TRANSPARENT } from "./palette";

/** The extensions this section drives, in display order. */
const EFFECT_IDS = ["grayscale", "tint", "shadow"] as const;

export interface EffectsSectionProps {
  /** The selection's extension groups, by extension id. */
  groups: ReadonlyMap<string, ExtensionGroup>;
  /** Every selected element is an image (labels can drop the "Image" prefix). */
  onlyImages: boolean;
  busy: boolean;
  label(name: string): string;
  /** Runs one extension action: one undo step. */
  run(group: ExtensionGroup, action: ExtensionAction): void;
}

const num = (v: unknown) => (typeof v === "number" ? v : null);
const str = (v: unknown) => (typeof v === "string" ? v : null);

/** Grayscale, tint and shadow: sliders at 0 (or a transparent colour) remove the effect. */
export function EffectsSection({ groups, busy, label, run }: EffectsSectionProps) {
  const [grayscale, tint, shadow] = EFFECT_IDS.map((id) => groups.get(id));
  const apply = (g: ExtensionGroup, patch: Record<string, unknown>) =>
    run(g, { kind: "apply", params: patchParams(g, patch) });
  /** Applies `patch`, or removes the effect when `off`. */
  const set = (g: ExtensionGroup, off: boolean, patch: Record<string, unknown>) =>
    off ? g.removable && run(g, { kind: "remove" }) : apply(g, patch);
  /** The shared value; null when mixed; `off` when no target has the effect. */
  const shared = (g: ExtensionGroup, key: string, off: number) =>
    g.removable ? num(g.common[key]) : off;
  const color = (g: ExtensionGroup) => (g.removable ? str(g.common.color) : TRANSPARENT);
  const slider = (
    g: ExtensionGroup,
    name: string,
    key: string,
    testId: string,
    range: { min: number; max: number; step: number; off?: number },
  ) => (
    <RangeControl
      label={label(name)}
      value={shared(g, key, range.off ?? range.min)}
      fallback={num(g.base[key]) ?? range.min}
      min={range.min}
      max={range.max}
      step={range.step}
      testId={testId}
      disabled={busy}
      onCommit={(v) => set(g, range.off !== undefined && v === range.off, { [key]: v })}
    />
  );
  const PCT = { min: 0, max: 100, step: 5, off: 0 };
  const OFFSET = { min: -100, max: 100, step: 1 };

  return (
    <>
      {grayscale && slider(grayscale, "Grayscale", "amount", "image-grayscale", PCT)}
      {tint && (
        <>
          <StrokeColorPicker
            label={label("Tint")}
            value={color(tint)}
            disabled={busy}
            testIdPrefix="image-tint"
            onChange={(c) => set(tint, c === TRANSPARENT, { color: c })}
          />
          {tint.removable && slider(tint, "Tint strength", "strength", "image-tint-strength", PCT)}
        </>
      )}
      {shadow && (
        <>
          <StrokeColorPicker
            label={label("Shadow")}
            value={color(shadow)}
            disabled={busy}
            testIdPrefix="image-shadow"
            onChange={(c) => set(shadow, c === TRANSPARENT, { color: c })}
          />
          {shadow.removable && (
            <>
              {slider(shadow, "Shadow opacity", "opacity", "image-shadow-opacity", PCT)}
              {slider(shadow, "Shadow blur", "blur", "image-shadow-blur", {
                min: 0,
                max: 50,
                step: 1,
              })}
              {slider(shadow, "Shadow offset X", "offsetX", "image-shadow-x", OFFSET)}
              {slider(shadow, "Shadow offset Y", "offsetY", "image-shadow-y", OFFSET)}
            </>
          )}
        </>
      )}
    </>
  );
}

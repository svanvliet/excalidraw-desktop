import { BORDER_WIDTHS, type BorderRoughness, type BorderStyle } from "../../extensions/border";
import { patchParams } from "../../extensions/groups";
import {
  SloppinessArchitectIcon,
  SloppinessArtistIcon,
  SloppinessCartoonistIcon,
  StrokeStyleDashedIcon,
  StrokeStyleDottedIcon,
  StrokeStyleSolidIcon,
  StrokeWidthBoldIcon,
  StrokeWidthExtraBoldIcon,
  StrokeWidthThinIcon,
} from "../icons";
import { ButtonRow, IconButton, type Option } from "../propertiesPanel/controls";
import { StrokeColorPicker } from "./StrokeColorPicker";
import { TRANSPARENT } from "./palette";
import type { ImageSectionProps } from "./types";

const WIDTHS: Option<number>[] = [
  { value: BORDER_WIDTHS.thin, label: "Thin", icon: <StrokeWidthThinIcon /> },
  { value: BORDER_WIDTHS.bold, label: "Bold", icon: <StrokeWidthBoldIcon /> },
  { value: BORDER_WIDTHS.extraBold, label: "Extra bold", icon: <StrokeWidthExtraBoldIcon /> },
];
const STYLES: Option<BorderStyle>[] = [
  { value: "solid", label: "Solid", icon: <StrokeStyleSolidIcon /> },
  { value: "dashed", label: "Dashed", icon: <StrokeStyleDashedIcon /> },
  { value: "dotted", label: "Dotted", icon: <StrokeStyleDottedIcon /> },
];
const SLOPPINESS: Option<BorderRoughness>[] = [
  { value: 0, label: "Architect", icon: <SloppinessArchitectIcon /> },
  { value: 1, label: "Artist", icon: <SloppinessArtistIcon /> },
  { value: 2, label: "Cartoonist", icon: <SloppinessCartoonistIcon /> },
];
/** The border extension as a native-looking Stroke section. */
export function StrokeSection({ groups, label, busy, run }: ImageSectionProps) {
  const border = groups.get("border")!;
  const hasBorder = border.removable;
  const color = !hasBorder
    ? TRANSPARENT
    : typeof border.common.color === "string"
      ? border.common.color
      : null;
  const apply = (patch: Record<string, unknown>) =>
    run(border, { kind: "apply", params: patchParams(border, patch) });
  const row = <V,>(name: string, testId: string, param: string, options: Option<V>[]) => (
    <ButtonRow legend={label(name)} testId={testId}>
      {options.map((o) => (
        <IconButton
          key={String(o.value)}
          label={o.label}
          icon={o.icon}
          active={border.common[param] === o.value}
          disabled={busy}
          onClick={() => apply({ [param]: o.value })}
        />
      ))}
    </ButtonRow>
  );

  return (
    <>
      <StrokeColorPicker
        label={label("Stroke")}
        value={color}
        disabled={busy}
        onChange={(c) =>
          c === TRANSPARENT ? hasBorder && run(border, { kind: "remove" }) : apply({ color: c })
        }
      />
      {hasBorder && (
        <>
          {row("Stroke width", "image-stroke-width", "width", WIDTHS)}
          {row("Stroke style", "image-stroke-style", "style", STYLES)}
          {row("Sloppiness", "image-sloppiness", "roughness", SLOPPINESS)}
        </>
      )}
    </>
  );
}

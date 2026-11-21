import type { ReactNode } from "react";
import { MaskCircleIcon, MaskNoneIcon, MaskRoundedIcon } from "../icons";
import { ButtonRow, IconButton } from "../propertiesPanel/controls";
import type { ImageSectionProps } from "./types";

const MASK_ICONS: Record<string, ReactNode> = {
  circle: <MaskCircleIcon />,
  roundedRect: <MaskRoundedIcon />,
};

export function MaskSection({ groups, label, busy, run }: ImageSectionProps) {
  const mask = groups.get("mask")!;
  return (
    <ButtonRow legend={label("Mask")} testId="image-mask">
      <IconButton
        label="No mask"
        icon={<MaskNoneIcon />}
        active={!mask.removable}
        disabled={busy}
        onClick={() => mask.removable && run(mask, { kind: "remove" })}
      />
      {mask.presets.map((p) => (
        <IconButton
          key={p.id}
          label={p.label}
          icon={MASK_ICONS[p.id] ?? <MaskNoneIcon />}
          active={p.active}
          disabled={busy}
          onClick={() => run(mask, { kind: "apply", params: p.params })}
        />
      ))}
    </ButtonRow>
  );
}

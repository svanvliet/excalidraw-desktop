/**
 * Inline SVG icon set. Lucide-style stroke icons, sized at 16px by
 * default. Tint via CSS `color` (icons use `stroke="currentColor"`).
 *
 * All icons are decorative by default. When an icon stands alone (no
 * adjacent text label) the parent button MUST carry an `aria-label`.
 */
import type { ReactNode, SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size, className, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      className={["icon", className].filter(Boolean).join(" ")}
      {...rest}
    >
      {children}
    </svg>
  );
}

export const FolderOpenIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1" />
    <path d="m3 9 1.8 9.4A2 2 0 0 0 6.77 20h10.46a2 2 0 0 0 1.97-1.6L21 11H5a2 2 0 0 0-1.97 1.6L3 13" />
  </Icon>
);

export const SaveIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z" />
    <path d="M17 21v-8H7v8" />
    <path d="M7 3v5h8" />
  </Icon>
);

export const SaveAsIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M19 21H8a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h8l5 5v8a2 2 0 0 1-2 2Z" />
    <path d="M17 21v-7H10v7" />
    <path d="M10 6V3h6" />
  </Icon>
);

export const ExportIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="M7 10l5-5 5 5" />
    <path d="M12 5v12" />
  </Icon>
);

/** Auto-layout / Layout menu: a small org chart (parent, bus, two children). */
export const LayoutIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="9" y="3" width="6" height="5" rx="1" />
    <rect x="3" y="16" width="6" height="5" rx="1" />
    <rect x="15" y="16" width="6" height="5" rx="1" />
    <path d="M12 8v4M6 16v-4h12v4" />
  </Icon>
);

export const SettingsIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
  </Icon>
);

export const ClockIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </Icon>
);

export const ChevronDownIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m6 9 6 6 6-6" />
  </Icon>
);

export const SunIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2" />
    <path d="M12 20v2" />
    <path d="m4.93 4.93 1.41 1.41" />
    <path d="m17.66 17.66 1.41 1.41" />
    <path d="M2 12h2" />
    <path d="M20 12h2" />
    <path d="m4.93 19.07 1.41-1.41" />
    <path d="m17.66 6.34 1.41-1.41" />
  </Icon>
);

export const MoonIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
  </Icon>
);

export const MonitorIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path d="M8 20h8" />
    <path d="M12 16v4" />
  </Icon>
);

export const PlusIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 5v14" />
    <path d="M5 12h14" />
  </Icon>
);

export const CloseIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </Icon>
);

export const UsersIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </Icon>
);

export const LinkIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
  </Icon>
);

/** "Broadcasting" glyph: a dot with radiating arcs, used for live sessions. */
export const LiveIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="2" fill="currentColor" />
    <path d="M16.24 7.76a6 6 0 0 1 0 8.49" />
    <path d="M7.76 16.24a6 6 0 0 1 0-8.49" />
    <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
    <path d="M4.93 19.07a10 10 0 0 1 0-14.14" />
  </Icon>
);

export const CopyIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="9" y="9" width="13" height="13" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </Icon>
);

export const SparklesIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9Z" />
    <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8Z" />
  </Icon>
);

export const RefreshIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M21 12a9 9 0 0 1-15.5 6.2L3 16" />
    <path d="M3 12a9 9 0 0 1 15.5-6.2L21 8" />
    <path d="M21 3v5h-5" />
    <path d="M3 21v-5h5" />
  </Icon>
);

export const SendIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m22 2-7 20-4-9-9-4Z" />
    <path d="M22 2 11 13" />
  </Icon>
);

export const StopIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </Icon>
);

export const UndoIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M9 14 4 9l5-5" />
    <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
  </Icon>
);

export const PaperclipIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5" />
  </Icon>
);

/*
 * Excalidraw's own property-panel icons (MIT, copied from @excalidraw/excalidraw 0.18.1) so the
 * image stroke controls match the native ones. Sized by Excalidraw's `.buttonList svg` rule.
 */
function NativeIcon({ grid = 20, children }: { grid?: 20 | 24; children: ReactNode }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${grid} ${grid}`}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={grid === 24 ? 2 : undefined}
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const StrokeWidthThinIcon = () => (
  <NativeIcon>
    <path d="M4.167 10h11.666" strokeWidth="1.25" />
  </NativeIcon>
);

export const StrokeWidthBoldIcon = () => (
  <NativeIcon>
    <path d="M5 10h10" strokeWidth="2.5" />
  </NativeIcon>
);

export const StrokeWidthExtraBoldIcon = () => (
  <NativeIcon>
    <path d="M5 10h10" strokeWidth="3.75" />
  </NativeIcon>
);

export const StrokeStyleSolidIcon = StrokeWidthThinIcon;

export const StrokeStyleDashedIcon = () => (
  <NativeIcon grid={24}>
    <g strokeWidth="2">
      <path stroke="none" d="M0 0h24v24H0z" fill="none" />
      <path d="M5 12h2" />
      <path d="M17 12h2" />
      <path d="M11 12h2" />
    </g>
  </NativeIcon>
);

export const StrokeStyleDottedIcon = () => (
  <NativeIcon grid={24}>
    <g strokeWidth="2">
      <path stroke="none" d="M0 0h24v24H0z" fill="none" />
      <path d="M4 12v.01" />
      <path d="M8 12v.01" />
      <path d="M12 12v.01" />
      <path d="M16 12v.01" />
      <path d="M20 12v.01" />
    </g>
  </NativeIcon>
);

export const SloppinessArchitectIcon = () => (
  <NativeIcon>
    <path
      d="M2.5 12.038c1.655-.885 5.9-3.292 8.568-4.354 2.668-1.063.101 2.821 1.32 3.104 1.218.283 5.112-1.814 5.112-1.814"
      strokeWidth="1.25"
    />
  </NativeIcon>
);

export const SloppinessArtistIcon = () => (
  <NativeIcon>
    <path
      d="M2.5 12.563c1.655-.886 5.9-3.293 8.568-4.355 2.668-1.062.101 2.822 1.32 3.105 1.218.283 5.112-1.814 5.112-1.814m-13.469 2.23c2.963-1.586 6.13-5.62 7.468-4.998 1.338.623-1.153 4.11-.132 5.595 1.02 1.487 6.133-1.43 6.133-1.43"
      strokeWidth="1.25"
    />
  </NativeIcon>
);

export const SloppinessCartoonistIcon = () => (
  <NativeIcon>
    <path
      d="M2.5 11.936c1.737-.879 8.627-5.346 10.42-5.268 1.795.078-.418 5.138.345 5.736.763.598 3.53-1.789 4.235-2.147M2.929 9.788c1.164-.519 5.47-3.28 6.987-3.114 1.519.165 1 3.827 2.121 4.109 1.122.281 3.839-2.016 4.606-2.42"
      strokeWidth="1.25"
    />
  </NativeIcon>
);

/** Mask: none (full rectangle), circle, rounded rectangle — drawn in the native icon style. */
export const MaskNoneIcon = () => (
  <NativeIcon>
    <rect x="3.75" y="3.75" width="12.5" height="12.5" strokeWidth="1.25" />
  </NativeIcon>
);

export const MaskCircleIcon = () => (
  <NativeIcon>
    <circle cx="10" cy="10" r="6.25" strokeWidth="1.25" />
  </NativeIcon>
);

export const MaskRoundedIcon = () => (
  <NativeIcon>
    <rect x="3.75" y="3.75" width="12.5" height="12.5" rx="3.5" strokeWidth="1.25" />
  </NativeIcon>
);

/** Sidebar / Layers tab icons, drawn in the native 24px stroke style; sized by the caller's CSS. */
export const LayersIcon = () => (
  <NativeIcon grid={24}>
    <path d="M12 4 4 8l8 4 8-4-8-4" />
    <path d="m4 12 8 4 8-4" />
    <path d="m4 16 8 4 8-4" />
  </NativeIcon>
);

/** Styles tab: a paint palette. */
export const StylesIcon = () => (
  <NativeIcon grid={24}>
    <path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.7-.8 1.7-1.7 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-.9.8-1.7 1.7-1.7H16a5 5 0 0 0 5-5C21 6.4 17 3 12 3Z" />
    <circle cx="7.5" cy="11.5" r="1" />
    <circle cx="10.5" cy="7.5" r="1" />
    <circle cx="15.5" cy="8.5" r="1" />
  </NativeIcon>
);

/** Components tab: a master diamond over an instance. */
export const ComponentsIcon = () => (
  <NativeIcon grid={24}>
    <path d="m12 3 4 4-4 4-4-4 4-4" />
    <path d="m12 13 4 4-4 4-4-4 4-4" strokeDasharray="2 2" />
  </NativeIcon>
);

export const LockIcon = () => (
  <NativeIcon grid={24}>
    <rect x="5" y="11" width="14" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 1 1 8 0v4" />
  </NativeIcon>
);

export const UnlockIcon = () => (
  <NativeIcon grid={24}>
    <rect x="5" y="11" width="14" height="10" rx="2" />
    <path d="M8 11V6a4 4 0 0 1 8 0" />
  </NativeIcon>
);

export const ChevronRightIcon = () => (
  <NativeIcon grid={24}>
    <path d="m9 6 6 6-6 6" />
  </NativeIcon>
);

/** Elbow-arrow anchors: a box with the pinned point marked. */
const AnchorIcon = ({ cx, cy }: { cx: number; cy: number }) => (
  <NativeIcon>
    <rect x="4.5" y="4.5" width="11" height="11" rx="1.5" strokeWidth="1.25" />
    <circle cx={cx} cy={cy} r="2" fill="currentColor" strokeWidth="0" />
  </NativeIcon>
);

export const AnchorNorthIcon = () => <AnchorIcon cx={10} cy={4.5} />;
export const AnchorEastIcon = () => <AnchorIcon cx={15.5} cy={10} />;
export const AnchorSouthIcon = () => <AnchorIcon cx={10} cy={15.5} />;
export const AnchorWestIcon = () => <AnchorIcon cx={4.5} cy={10} />;
export const AnchorCenterIcon = () => <AnchorIcon cx={10} cy={10} />;

/** Line anchors: an end free to slide around the outline (no pin). */
export const AnchorFreeIcon = () => (
  <NativeIcon>
    <rect
      x="4.5"
      y="4.5"
      width="11"
      height="11"
      rx="1.5"
      strokeWidth="1.25"
      strokeDasharray="2 2"
    />
  </NativeIcon>
);

/** Smart containers: stack direction, cross-axis alignment and main-axis distribution. */
export const StackVerticalIcon = () => (
  <NativeIcon>
    <rect x="5" y="3.5" width="10" height="3.5" rx="1" strokeWidth="1.25" />
    <rect x="5" y="8.25" width="10" height="3.5" rx="1" strokeWidth="1.25" />
    <rect x="5" y="13" width="10" height="3.5" rx="1" strokeWidth="1.25" />
  </NativeIcon>
);

export const StackHorizontalIcon = () => (
  <NativeIcon>
    <rect x="3.5" y="5" width="3.5" height="10" rx="1" strokeWidth="1.25" />
    <rect x="8.25" y="5" width="3.5" height="10" rx="1" strokeWidth="1.25" />
    <rect x="13" y="5" width="3.5" height="10" rx="1" strokeWidth="1.25" />
  </NativeIcon>
);

type Pos = "start" | "center" | "end";

/** Two bars of different lengths pushed to `pos` across a vertical stack (rotated for a row). */
export const StackAlignIcon = ({ pos, vertical }: { pos: Pos; vertical: boolean }) => {
  const x = (w: number) => (pos === "start" ? 4 : pos === "end" ? 16 - w : 10 - w / 2);
  const line = pos === "start" ? 3 : pos === "end" ? 17 : 10;
  return (
    <NativeIcon>
      <g transform={vertical ? undefined : "rotate(90 10 10)"} strokeWidth="1.25">
        <path d={`M${line} 3v14`} strokeDasharray={pos === "center" ? "2 2" : undefined} />
        <rect x={x(10)} y="5" width="10" height="4" rx="1" />
        <rect x={x(6)} y="11" width="6" height="4" rx="1" />
      </g>
    </NativeIcon>
  );
};

/** Three small items placed at `pos` (or spread) along a vertical stack (rotated for a row). */
export const StackJustifyIcon = ({
  pos,
  vertical,
}: {
  pos: Pos | "space-between";
  vertical: boolean;
}) => {
  const ys =
    pos === "start"
      ? [3.5, 7, 10.5]
      : pos === "end"
        ? [6.5, 10, 13.5]
        : pos === "center"
          ? [5, 8.5, 12]
          : [3.5, 8.5, 13.5];
  return (
    <NativeIcon>
      <g transform={vertical ? undefined : "rotate(-90 10 10)"} strokeWidth="1.25">
        <rect x="3" y="2" width="14" height="16" rx="1.5" strokeDasharray="2 2" />
        {ys.map((y) => (
          <rect key={y} x="6" y={y} width="8" height="2.5" rx="0.75" />
        ))}
      </g>
    </NativeIcon>
  );
};

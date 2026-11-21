/**
 * Image controls in Excalidraw's own properties panel (docs/extensions.md § "UI surface").
 *
 * Excalidraw 0.18.1 has no API to add panel sections, and its panel hides stroke controls for
 * images. So while images are selected this portals native-looking sections (stroke colour /
 * width / style / sloppiness for the border extension, the mask shape, and the grayscale / tint /
 * shadow effects) into the panel's
 * `.panelColumn`, right after its first slot — where Stroke sits for shapes. React only moves its
 * own nodes, so a foreign node there survives panel re-renders; a MutationObserver re-attaches
 * it when the panel remounts. When no panel is in the DOM (e.g. the mobile layout with its
 * properties sheet closed) the same sections show in a small docked island instead.
 *
 * The DOM contract (PANEL_SELECTOR) is pinned by e2e/extensions.spec.ts.
 * Every click runs `runExtension`: one undo step, the same path the agent tools use.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { AppState, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { BORDER_WIDTHS, type BorderRoughness, type BorderStyle } from "../../extensions/border";
import { extensionGroups, patchParams, type ExtensionGroup } from "../../extensions/groups";
import { runExtension, type ExtensionAction } from "../../extensions/runner";
import { log } from "../../lib/logger";
import {
  MaskCircleIcon,
  MaskNoneIcon,
  MaskRoundedIcon,
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
import { EffectsSection } from "./EffectsSection";
import { StrokeColorPicker } from "./StrokeColorPicker";
import { TRANSPARENT } from "./palette";

export type ImagePanelApi = Pick<
  ExcalidrawImperativeAPI,
  | "getSceneElements"
  | "getSceneElementsIncludingDeleted"
  | "getAppState"
  | "getFiles"
  | "updateScene"
  | "scrollToContent"
  | "addFiles"
  | "onChange"
>;

/** Where the sections go in Excalidraw 0.18.1's DOM: the desktop panel or the mobile sheet. */
export const PANEL_SELECTOR = ".App-menu__left .panelColumn, .App-mobile-menu .panelColumn";

/** Hidden while the user is mid-gesture or typing, and in view / zen mode. */
function isBusy(s: AppState): boolean {
  return Boolean(
    s.viewModeEnabled ||
    s.zenModeEnabled ||
    s.newElement ||
    s.editingTextElement ||
    s.resizingElement ||
    s.selectedElementsAreBeingDragged ||
    s.isResizing ||
    s.isRotating ||
    s.multiElement,
  );
}

interface View {
  border?: ExtensionGroup;
  mask?: ExtensionGroup;
  grayscale?: ExtensionGroup;
  tint?: ExtensionGroup;
  shadow?: ExtensionGroup;
  /** Every selected element is an image (labels can drop the "Image" prefix). */
  onlyImages: boolean;
}

function computeView(api: ImagePanelApi): View | null {
  const appState = api.getAppState();
  if (isBusy(appState)) return null;
  const selected = api
    .getSceneElements()
    .filter((el) => appState.selectedElementIds[el.id] && !el.isDeleted);
  const groups = extensionGroups(selected);
  const group = (id: string) => groups.find((g) => g.id === id);
  const view: View = {
    border: group("border"),
    mask: group("mask"),
    grayscale: group("grayscale"),
    tint: group("tint"),
    shadow: group("shadow"),
    onlyImages: selected.every((el) => el.type === "image"),
  };
  const { onlyImages: _, ...sections } = view;
  if (!Object.values(sections).some(Boolean)) return null;
  return view;
}

/** The effect groups of a view, keyed by extension id like the panel host's `groups`. */
function effectGroups({ grayscale, tint, shadow }: View) {
  const entries = Object.entries({ grayscale, tint, shadow });
  return new Map(entries.filter((e): e is [string, ExtensionGroup] => !!e[1]));
}

const viewKey = (v: View | null) => JSON.stringify(v);

/**
 * The node the sections render into: a host kept right after the panel's first slot, or null
 * when the native panel is absent. Tracks remounts with a MutationObserver on the editor root.
 */
function usePanelHost(root: HTMLElement | null, active: boolean): HTMLElement | null {
  const host = useMemo(() => {
    const el = document.createElement("div");
    el.className = "image-props";
    el.dataset.testid = "image-props-native";
    return el;
  }, []);
  const [attached, setAttached] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (!root || !active) return;
    const sync = () => {
      const panel = root.querySelector<HTMLElement>(PANEL_SELECTOR);
      if (!panel) {
        host.remove();
        setAttached(null);
        return;
      }
      const first = panel.firstElementChild === host ? null : panel.firstElementChild;
      const before = first ? first.nextSibling : panel.firstChild;
      if (host.parentElement !== panel || host.previousElementSibling !== first) {
        panel.insertBefore(host, before === host ? host.nextSibling : before);
      }
      setAttached(host);
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      host.remove();
      setAttached(null);
    };
  }, [root, active, host]);

  return active ? attached : null;
}

export function ImagePropertiesPanel({
  api,
  container,
}: {
  api: ImagePanelApi;
  /** Wrapper around `<Excalidraw>`; the panel looks for `.excalidraw` inside it. */
  container: RefObject<HTMLElement | null>;
}) {
  const [view, setView] = useState<View | null>(() => computeView(api));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [root, setRoot] = useState<HTMLElement | null>(null);

  useEffect(() => {
    let last = viewKey(computeView(api));
    setView(computeView(api));
    return api.onChange(() => {
      const next = computeView(api);
      const key = viewKey(next);
      if (key === last) return;
      last = key;
      setView(next);
      setError(null);
    });
  }, [api]);

  useEffect(() => {
    setRoot(container.current?.querySelector<HTMLElement>(".excalidraw") ?? null);
  }, [container, view]);

  const host = usePanelHost(root, view !== null);

  const run = useCallback(
    async (group: ExtensionGroup, action: ExtensionAction) => {
      setBusy(true);
      setError(null);
      try {
        const res = await runExtension(api, group.ids, group.id, action);
        if (!res.applied.length && res.skipped.length) setError(res.skipped[0]!.reason);
      } catch (err) {
        log.warn(`extensions: ${group.id} ${action.kind} failed`, err);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [api],
  );

  if (!view || !root) return null;
  const sections = (
    <Sections view={view} busy={busy} error={error} run={(g, a) => void run(g, a)} />
  );
  if (host) return createPortal(sections, host);
  return createPortal(
    <div className="Island image-props-dock" data-testid="image-props-dock">
      <div className="panelColumn image-props">{sections}</div>
    </div>,
    root,
  );
}

interface Option<V> {
  value: V;
  label: string;
  icon: ReactNode;
}

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
const MASK_ICONS: Record<string, ReactNode> = {
  circle: <MaskCircleIcon />,
  roundedRect: <MaskRoundedIcon />,
};

/** Keeps Excalidraw's canvas focused so its shortcuts (undo!) keep working after a click. */
const keepFocus = (e: { preventDefault(): void }) => e.preventDefault();

/** Excalidraw's `<fieldset><legend/><div class="buttonList">` icon-button row. */
function ButtonRow({
  legend,
  testId,
  children,
}: {
  legend: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <fieldset data-testid={testId}>
      <legend>{legend}</legend>
      <div className="buttonList">{children}</div>
    </fieldset>
  );
}

function IconButton(props: {
  label: string;
  icon: ReactNode;
  active: boolean;
  disabled: boolean;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      className={props.active ? "active" : undefined}
      title={props.label}
      aria-label={props.label}
      aria-pressed={props.active}
      disabled={props.disabled}
      onMouseDown={keepFocus}
      onClick={props.onClick}
    >
      {props.icon}
    </button>
  );
}

function Sections({
  view,
  busy,
  error,
  run,
}: {
  view: View;
  busy: boolean;
  error: string | null;
  run(group: ExtensionGroup, action: ExtensionAction): void;
}) {
  const { border, mask, onlyImages } = view;
  const prefix = onlyImages ? "" : "Image ";
  const label = (s: string) => (prefix ? prefix + s.toLowerCase() : s);
  const hasBorder = !!border?.removable;
  const color = !border
    ? null
    : !hasBorder
      ? TRANSPARENT
      : typeof border.common.color === "string"
        ? border.common.color
        : null;
  const apply = (g: ExtensionGroup, patch: Record<string, unknown>) =>
    run(g, { kind: "apply", params: patchParams(g, patch) });
  const row = <V,>(name: string, testId: string, param: string, options: Option<V>[]) =>
    border && (
      <ButtonRow legend={label(name)} testId={testId}>
        {options.map((o) => (
          <IconButton
            key={String(o.value)}
            label={o.label}
            icon={o.icon}
            active={border.common[param] === o.value}
            disabled={busy}
            onClick={() => apply(border, { [param]: o.value })}
          />
        ))}
      </ButtonRow>
    );

  return (
    <>
      {border && (
        <StrokeColorPicker
          label={label("Stroke")}
          value={color}
          disabled={busy}
          onChange={(c) =>
            c === TRANSPARENT
              ? hasBorder && run(border, { kind: "remove" })
              : apply(border, { color: c })
          }
        />
      )}
      {hasBorder && (
        <>
          {row("Stroke width", "image-stroke-width", "width", WIDTHS)}
          {row("Stroke style", "image-stroke-style", "style", STYLES)}
          {row("Sloppiness", "image-sloppiness", "roughness", SLOPPINESS)}
        </>
      )}
      {mask && (
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
      )}
      <EffectsSection
        groups={effectGroups(view)}
        onlyImages={view.onlyImages}
        busy={busy}
        label={label}
        run={run}
      />
      {error && (
        <div className="image-props__error" role="alert">
          {error}
        </div>
      )}
    </>
  );
}

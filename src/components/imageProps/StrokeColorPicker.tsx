/**
 * A copy of Excalidraw's stroke colour picker for image borders: the quick-pick row, the active
 * colour trigger and a popover with the palette, its shades and a hex input. Excalidraw 0.18 does
 * not export its ColorPicker, so this renders the same markup and class names, and the native
 * stylesheet does the rest (light and dark themes included). The popover is portaled into the
 * `.excalidraw` root because every picker style is scoped under it.
 */
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import {
  DEFAULT_SHADE,
  PALETTE_HOTKEYS,
  STROKE_PALETTE,
  STROKE_TOP_PICKS,
  TRANSPARENT,
  contrastText,
  findInPalette,
  parseHex,
  swatchOf,
} from "./palette";

export interface StrokeColorPickerProps {
  /** `#rrggbb`, `transparent` (no stroke) or null when the selection is mixed. */
  value: string | null;
  label: string;
  disabled?: boolean;
  onChange(color: string): void;
}

const swatch = (color: string) => ({ "--swatch-color": color }) as CSSProperties;
const cls = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(" ");

/** Keeps Excalidraw's canvas focused (so its shortcuts and undo keep working) on clicks. */
const keepFocus = (e: { preventDefault(): void }) => e.preventDefault();

export function StrokeColorPicker({ value, label, disabled, onChange }: StrokeColorPickerProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const current = value ?? TRANSPARENT;

  return (
    <div>
      <h3 aria-hidden="true">{label}</h3>
      <div role="dialog" aria-label={label} className="color-picker-container">
        <div className="color-picker__top-picks">
          {STROKE_TOP_PICKS.map((color) => (
            <button
              key={color}
              type="button"
              className={cls("color-picker__button", value === color && "active")}
              style={swatch(color)}
              title={color}
              aria-label={`${label} ${color}`}
              aria-pressed={value === color}
              data-testid={`image-stroke-top-pick-${color}`}
              disabled={disabled}
              onMouseDown={keepFocus}
              onClick={() => onChange(color)}
            >
              <div className="color-picker__button-outline" />
            </button>
          ))}
        </div>
        <div className="image-props__separator" />
        <button
          ref={triggerRef}
          type="button"
          className={cls(
            "color-picker__button active-color properties-trigger",
            current === TRANSPARENT && "is-transparent",
          )}
          style={swatch(current)}
          title={`Show ${label.toLowerCase()} colour picker`}
          aria-label={`Show ${label.toLowerCase()} colour picker`}
          aria-expanded={open}
          data-testid="image-stroke-trigger"
          disabled={disabled}
          onMouseDown={keepFocus}
          onClick={() => setOpen((o) => !o)}
        >
          <div className="color-picker__button-outline" />
        </button>
      </div>
      {open && triggerRef.current && (
        <PickerPopover
          anchor={triggerRef.current}
          value={current}
          label={label}
          onChange={onChange}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

interface PopoverProps {
  anchor: HTMLElement;
  value: string;
  label: string;
  onChange(color: string): void;
  onClose(): void;
}

/** Same placement as Excalidraw's Radix popover: right of the trigger, 20px out, 16px up. */
function placement(anchor: HTMLElement, root: HTMLElement): CSSProperties {
  const a = anchor.getBoundingClientRect();
  const r = root.getBoundingClientRect();
  return { left: a.right - r.left + 20, top: Math.max(8, a.top - r.top - 16) };
}

function PickerPopover({ anchor, value, label, onChange, onClose }: PopoverProps) {
  const root = anchor.closest<HTMLElement>(".excalidraw") ?? document.body;
  const ref = useRef<HTMLDivElement>(null);
  const hit = findInPalette(value);
  // Like Excalidraw, the palette shows every colour at the current colour's shade.
  const shade = hit?.shade ?? DEFAULT_SHADE;
  const shades = hit ? STROKE_PALETTE[hit.name] : undefined;
  // What the user is typing; null shows the current value.
  const [draft, setDraft] = useState<string | null>(null);
  const hex = draft ?? (value === TRANSPARENT ? "" : value.slice(1));

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
    const outside = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !anchor.contains(t)) onCloseRef.current();
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [anchor]);

  const close = () => {
    onClose();
    // Hand focus back to the editor so its shortcuts (undo, delete…) apply again.
    const editor = root.querySelector<HTMLElement>(".excalidraw-container") ?? root;
    editor.focus({ preventScroll: true });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    // Typing in the hex field stays there; otherwise let modified keys (undo, redo…) through.
    if (e.target instanceof HTMLInputElement) {
      e.stopPropagation();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // Plain keys are picker hotkeys, never Excalidraw tool shortcuts.
    e.stopPropagation();
    const names = Object.keys(STROKE_PALETTE);
    const i = PALETTE_HOTKEYS.indexOf(e.key.toLowerCase());
    if (i >= 0 && names[i]) {
      e.preventDefault();
      onChange(swatchOf(names[i]!, shade));
    } else if (Array.isArray(shades) && /^Digit[1-5]$/.test(e.code)) {
      e.preventDefault();
      onChange(shades[Number(e.code.slice(5)) - 1]!);
    }
  };

  // Full 6-digit codes apply as typed; short ones (#abc) on Enter or blur, so typing "1971c2"
  // doesn't first apply #119977.
  const commitHex = (text: string) => {
    const parsed = parseHex(text);
    if (parsed && parsed !== value) onChange(parsed);
  };

  return createPortal(
    <div
      className="image-props__popover"
      style={placement(anchor, root)}
      onKeyDown={onKeyDown}
      data-testid="image-stroke-popover"
    >
      <div className="Island image-props__popover-island">
        <div role="dialog" aria-label={`${label} colour picker`}>
          <div ref={ref} className="color-picker-content properties-content" tabIndex={-1}>
            <div>
              <div className="color-picker__heading">Colors</div>
              <div className="color-picker-content--default">
                {Object.keys(STROKE_PALETTE).map((name, i) => {
                  const color = swatchOf(name, shade);
                  const active = hit?.name === name;
                  return (
                    <button
                      key={name}
                      type="button"
                      tabIndex={-1}
                      className={cls(
                        "color-picker__button color-picker__button--large",
                        active && "active",
                        color === TRANSPARENT && "is-transparent",
                      )}
                      style={swatch(color)}
                      title={name}
                      aria-label={name}
                      aria-pressed={active}
                      onMouseDown={keepFocus}
                      onClick={() => onChange(color)}
                    >
                      <div className="color-picker__button-outline" />
                      <div
                        className="color-picker__button__hotkey-label"
                        style={{ color: contrastText(color) }}
                      >
                        {PALETTE_HOTKEYS[i]}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
            <div>
              <div className="color-picker__heading">Shades</div>
              {Array.isArray(shades) ? (
                <div className="color-picker-content--default shades">
                  {shades.map((color, i) => (
                    <button
                      key={color}
                      type="button"
                      tabIndex={-1}
                      className={cls(
                        "color-picker__button color-picker__button--large",
                        hit?.shade === i && "active",
                      )}
                      style={swatch(color)}
                      title={`${hit!.name} - ${i + 1}`}
                      aria-label={`Shade ${i + 1}`}
                      aria-pressed={hit?.shade === i}
                      onMouseDown={keepFocus}
                      onClick={() => onChange(color)}
                    >
                      <div className="color-picker__button-outline" />
                      <div
                        className="color-picker__button__hotkey-label"
                        style={{ color: contrastText(color) }}
                      >
                        ⇧{i + 1}
                      </div>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="color-picker-content--default image-props__no-shades">
                  <button
                    type="button"
                    tabIndex={-1}
                    className="color-picker__button color-picker__button--large color-picker__button--no-focus-visible"
                  />
                  <div className="image-props__no-shades-text">
                    No shades available for this color
                  </div>
                </div>
              )}
            </div>
            <div>
              <div className="color-picker__heading">Hex code</div>
              <label className="color-picker__input-label">
                <div className="color-picker__input-hash">#</div>
                <input
                  className="color-picker-input image-props__hex"
                  aria-label={`${label} hex code`}
                  spellCheck={false}
                  value={hex}
                  onChange={(e) => {
                    setDraft(e.target.value);
                    if (e.target.value.replace("#", "").trim().length === 6) {
                      commitHex(e.target.value);
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitHex(e.currentTarget.value);
                  }}
                  onBlur={(e) => {
                    commitHex(e.currentTarget.value);
                    setDraft(null);
                  }}
                />
              </label>
            </div>
          </div>
        </div>
      </div>
    </div>,
    root,
  );
}

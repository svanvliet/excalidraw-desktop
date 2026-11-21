/**
 * A copy of Excalidraw's opacity slider (`components/Range.tsx`, not exported in 0.18): the same
 * `control-label` / `range-wrapper` / `range-input` markup so the native stylesheet themes it.
 * Unlike the native one it commits on release (pointer up, key up, blur), not on every input
 * event, so a drag re-renders the image once and is one undo step.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

export interface RangeControlProps {
  label: string;
  /** Current value, or null when the selection is mixed (shown at `fallback`). */
  value: number | null;
  fallback: number;
  min: number;
  max: number;
  step: number;
  testId: string;
  disabled?: boolean;
  onCommit(value: number): void;
}

const THUMB = 15;
const KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

export function RangeControl(props: RangeControlProps) {
  const { label, value, fallback, min, max, step, testId, disabled, onCommit } = props;
  const inputRef = useRef<HTMLInputElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<number | null>(null);
  const shown = draft ?? value ?? fallback;

  // A new value from the scene (or the end of a run) replaces the local draft.
  useEffect(() => {
    if (!disabled) setDraft(null);
  }, [value, disabled]);

  useEffect(() => {
    const input = inputRef.current;
    const bubble = bubbleRef.current;
    if (!input || !bubble) return;
    const pct = ((shown - min) / (max - min)) * 100;
    bubble.style.left = `${(pct / 100) * (input.offsetWidth - THUMB) + THUMB / 2}px`;
    input.style.background = `linear-gradient(to right, var(--color-slider-track) 0%, var(--color-slider-track) ${pct}%, var(--button-bg) ${pct}%, var(--button-bg) 100%)`;
  }, [shown, min, max]);

  const commit = () => {
    if (!disabled && draft !== null && draft !== value) onCommit(draft);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // Arrow keys adjust the slider, never nudge the selected elements.
    if (KEYS.has(e.key)) return e.stopPropagation();
    // The panel portals into Excalidraw's DOM but sits outside its React tree, so its container
    // `onKeyDown` never sees our synthetic events: forward shortcuts (Ctrl/Cmd+Z after a slide)
    // like Excalidraw's own sliders get them.
    if (!(e.ctrlKey || e.metaKey)) return;
    const host = e.currentTarget.closest<HTMLElement>(".excalidraw-container");
    if (!host) return;
    const { key, code, ctrlKey, metaKey, shiftKey, altKey } = e;
    const forwarded = new globalThis.KeyboardEvent("keydown", {
      key,
      code,
      ctrlKey,
      metaKey,
      shiftKey,
      altKey,
      bubbles: true,
      cancelable: true,
    });
    if (!host.dispatchEvent(forwarded)) e.preventDefault();
  };

  return (
    <label className="control-label">
      {label}
      <div className="range-wrapper">
        <input
          ref={inputRef}
          type="range"
          min={min}
          max={max}
          step={step}
          value={shown}
          className="range-input"
          data-testid={testId}
          aria-label={label}
          // Not `disabled`: that drops focus to <body>, outside Excalidraw's container-scoped
          // keydown handler, so Ctrl+Z after a slide would stop working while the run finishes.
          aria-disabled={disabled || undefined}
          onChange={(e) => !disabled && setDraft(+e.target.value)}
          onPointerUp={commit}
          onKeyDown={onKeyDown}
          onKeyUp={(e) => KEYS.has(e.key) && commit()}
          onBlur={commit}
        />
        <div className="value-bubble" ref={bubbleRef}>
          {shown !== min ? shown : null}
        </div>
        <div className="zero-label">{min}</div>
      </div>
    </label>
  );
}

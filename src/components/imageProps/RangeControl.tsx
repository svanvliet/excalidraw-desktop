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
    // Ctrl/Cmd shortcuts reach Excalidraw via the panel host's bridge (propertiesPanel/keyboard.ts).
    if (KEYS.has(e.key)) e.stopPropagation();
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
          // Not `disabled`, so focus (and the slider's position in tab order) survives a run.
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

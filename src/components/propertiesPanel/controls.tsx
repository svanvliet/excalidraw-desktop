/** Excalidraw-native-looking controls shared by our properties-panel sections. */
import type { ReactNode } from "react";

export interface Option<V> {
  value: V;
  label: string;
  icon: ReactNode;
}

/** Keeps Excalidraw's canvas focused so its shortcuts (undo!) keep working after a click. */
const keepFocus = (e: { preventDefault(): void }) => e.preventDefault();

/** Excalidraw's `<fieldset><legend/><div class="buttonList">` icon-button row. */
export function ButtonRow({
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

export function IconButton(props: {
  label: string;
  icon: ReactNode;
  active: boolean;
  disabled?: boolean;
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

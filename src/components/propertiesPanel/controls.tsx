/** Excalidraw-native-looking controls shared by our properties-panel sections. */
import { useId, type ReactNode } from "react";
import { ChevronRightIcon } from "../icons";
import type { PanelApi, PanelSection } from "./panel";

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

/**
 * One row of the properties-panel strip (FR-63): icon, title, summary and chevron in a toggle,
 * an optional inline primary action, and the section's body when open. Rendered inside the
 * section's host node (PropertiesPanelHost), which carries the `-native` / `-dock` test id.
 */
export function StripRow<V>({
  section,
  view,
  api,
  open,
  onToggle,
}: {
  section: PanelSection<V>;
  view: V;
  api: PanelApi;
  open: boolean;
  onToggle(): void;
}) {
  const bodyId = useId();
  const { icon: Icon, Component: Body, testId, title } = section;
  const summary = section.summary(view);
  const primary = section.primary?.(view) ?? null;
  const expanded = open && !!Body;
  return (
    <>
      <div className="props-strip__head">
        <button
          type="button"
          className="props-strip__toggle"
          data-testid={`${testId}-toggle`}
          aria-expanded={Body ? expanded : undefined}
          aria-controls={expanded ? bodyId : undefined}
          title={summary ? `${title}: ${summary}` : title}
          onMouseDown={keepFocus}
          onClick={Body ? onToggle : undefined}
        >
          <span className="props-strip__icon">
            <Icon />
          </span>
          <span className="props-strip__title">{title}</span>
          <span className="props-strip__summary">{summary}</span>
          {Body && (
            <span className="props-strip__chevron">
              <ChevronRightIcon />
            </span>
          )}
        </button>
        {primary && (
          <button
            type="button"
            className="props-strip__primary"
            data-testid={`${testId}-primary`}
            title={primary.title}
            disabled={primary.disabled}
            onMouseDown={keepFocus}
            onClick={() => primary.run(api)}
          >
            {primary.label}
          </button>
        )}
      </div>
      {expanded && (
        <div id={bodyId} className={`props-section props-strip__body ${testId}`}>
          <Body view={view} api={api} />
        </div>
      )}
    </>
  );
}

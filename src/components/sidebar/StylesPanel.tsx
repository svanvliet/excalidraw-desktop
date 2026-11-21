/**
 * Styles tab (docs/styles.md): the canvas's named styles. Create one from the selection, apply
 * it, select its elements, rename (double-click or F2), edit its properties (linked elements
 * update live), or delete it (elements keep their look). Every change is one undo step.
 * Read-only in view mode. Rows reuse Excalidraw's search-panel classes like the Layers tab.
 */
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import {
  applyStyleToSelection,
  createStyleFromSelection,
  deleteSceneStyle,
  selectStyleElements,
  updateSceneStyle,
  useSceneStyles,
  useStyleSelection,
} from "../../extensions/styles/host";
import type { StyleInfo, StyleKey } from "../../extensions/styles/model";
import { CloseIcon, PlusIcon } from "../icons";
import {
  formatProp,
  missingProps,
  parseProp,
  PROP_CONTROLS,
  PROP_DEFAULTS,
  PROP_LABELS,
  swatchOf,
} from "../styles/stylesView";

export function StylesPanel({
  api,
  readOnly,
}: {
  api: ExcalidrawImperativeAPI;
  readOnly?: boolean;
}) {
  const styles = useSceneStyles(api);
  const selection = useStyleSelection(api);
  const [open, setOpen] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const canApply = !readOnly && selection.count > 0;

  return (
    <div className="layer-ui__search desktop-styles" data-testid="styles-panel">
      <div className="layer-ui__search-header desktop-layers__header desktop-styles__header">
        <span className="desktop-layers__title">Styles</span>
        {!readOnly && (
          <button
            type="button"
            className="desktop-styles__btn"
            data-testid="styles-new"
            disabled={!canApply}
            title={canApply ? "New style from the selection" : "Select elements to make a style"}
            onClick={() => {
              const made = createStyleFromSelection(api);
              if (made && "name" in made) setOpen(made.styleId);
            }}
          >
            <PlusIcon size={14} />
            New
          </button>
        )}
      </div>
      {styles.length === 0 ? (
        <div className="desktop-layers__empty">
          No styles yet. Select elements and choose New to save their look as a style.
        </div>
      ) : (
        <div className="layer-ui__search-result-container desktop-layers__list" role="list">
          {styles.map((s) => (
            <StyleRow
              key={s.id}
              api={api}
              style={s}
              readOnly={!!readOnly}
              canApply={canApply}
              applied={selection.elements.some((e) => e.styleId === s.id && !e.fromMaster)}
              open={open === s.id}
              renaming={renaming === s.id}
              onToggle={() => setOpen(open === s.id ? null : s.id)}
              onStartRename={() => !readOnly && setRenaming(s.id)}
              onRename={(name) => {
                setRenaming(null);
                if (name !== null && name.trim() && name.trim() !== s.name)
                  updateSceneStyle(api, s.id, { name });
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface RowProps {
  api: ExcalidrawImperativeAPI;
  style: StyleInfo;
  readOnly: boolean;
  canApply: boolean;
  applied: boolean;
  open: boolean;
  renaming: boolean;
  onToggle(): void;
  onStartRename(): void;
  onRename(name: string | null): void;
}

function StyleRow({
  api,
  style,
  readOnly,
  canApply,
  applied,
  open,
  renaming,
  onToggle,
  onStartRename,
  onRename,
}: RowProps) {
  const sw = swatchOf(style.props);
  const count = style.elementIds.length;
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onToggle();
    } else if (e.key === "F2") {
      e.preventDefault();
      onStartRename();
    }
  };
  return (
    <div role="listitem" className="desktop-styles__item" data-style-id={style.id}>
      <div
        tabIndex={0}
        className={`layer-ui__result-item desktop-layers__row desktop-styles__row${
          applied ? " active" : ""
        }`}
        aria-expanded={open}
        data-testid="styles-row"
        onClick={onToggle}
        onDoubleClick={onStartRename}
        onKeyDown={onKeyDown}
      >
        <span
          className="desktop-styles__swatch"
          aria-hidden="true"
          // Each style's own colours, fed to the swatch's CSS.
          style={{ "--style-stroke": sw.stroke, "--style-fill": sw.fill } as CSSProperties}
        />
        {renaming ? (
          <RenameInput initial={style.name} onDone={onRename} />
        ) : (
          <span className="preview-text desktop-layers__label" title={style.name}>
            {style.name}
          </span>
        )}
        <span className="desktop-layers__kind" title={`${count} linked element(s)`}>
          {count}
        </span>
      </div>
      {open && (
        <div className="desktop-styles__details" data-testid="styles-details">
          <div className="desktop-styles__actions">
            {!readOnly && (
              <button
                type="button"
                className="desktop-styles__btn"
                disabled={!canApply}
                title={canApply ? "Link the selection to this style" : "Select elements first"}
                onClick={() => applyStyleToSelection(api, style.id)}
              >
                Apply to selection
              </button>
            )}
            <button
              type="button"
              className="desktop-styles__btn"
              onClick={() => selectStyleElements(api, style.id)}
            >
              Select elements
            </button>
            {!readOnly && (
              <button
                type="button"
                className="desktop-styles__btn desktop-styles__btn--danger"
                title="Delete the style; linked elements keep their look"
                onClick={() => deleteSceneStyle(api, style.id)}
              >
                Delete
              </button>
            )}
          </div>
          <StyleEditor api={api} style={style} readOnly={readOnly} />
        </div>
      )}
    </div>
  );
}

function StyleEditor({
  api,
  style,
  readOnly,
}: {
  api: ExcalidrawImperativeAPI;
  style: StyleInfo;
  readOnly: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const keys = (Object.keys(PROP_LABELS) as StyleKey[]).filter(
    (k) => style.props[k] !== undefined && style.props[k] !== null,
  );
  const missing = missingProps(style.props);
  const set = (key: StyleKey, value: unknown) => {
    setError(null);
    updateSceneStyle(api, style.id, { props: { [key]: value } });
  };
  const commit = (key: StyleKey, raw: string) => {
    if (raw === formatProp(key, style.props[key])) return;
    try {
      set(key, parseProp(key, raw));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="desktop-styles__editor" data-testid="styles-editor">
      {keys.map((key) => (
        <div key={key} className="desktop-styles__prop" data-testid={`styles-prop-${key}`}>
          <span className="desktop-styles__prop-label">{PROP_LABELS[key]}</span>
          <PropInput
            styleKey={key}
            value={formatProp(key, style.props[key])}
            readOnly={readOnly}
            onCommit={(raw) => commit(key, raw)}
          />
          {!readOnly && (
            <button
              type="button"
              className="desktop-styles__icon"
              title={`Remove ${PROP_LABELS[key]} from the style`}
              aria-label={`Remove ${PROP_LABELS[key]}`}
              disabled={keys.length === 1}
              onClick={() => set(key, null)}
            >
              <CloseIcon size={12} />
            </button>
          )}
        </div>
      ))}
      {!readOnly && missing.length > 0 && (
        <select
          className="desktop-styles__input desktop-styles__add"
          aria-label="Add a property"
          value=""
          onChange={(e) => {
            const key = e.currentTarget.value as StyleKey;
            if (key) set(key, PROP_DEFAULTS[key]);
          }}
        >
          <option value="">Add property…</option>
          {missing.map((k) => (
            <option key={k} value={k}>
              {PROP_LABELS[k]}
            </option>
          ))}
        </select>
      )}
      {error && (
        <div className="desktop-styles__error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

function PropInput({
  styleKey,
  value,
  readOnly,
  onCommit,
}: {
  styleKey: StyleKey;
  value: string;
  readOnly: boolean;
  onCommit(raw: string): void;
}) {
  const control = PROP_CONTROLS[styleKey];
  const label = PROP_LABELS[styleKey];
  if (control.kind === "select") {
    return (
      <select
        className="desktop-styles__input"
        aria-label={label}
        value={value}
        disabled={readOnly}
        onChange={(e) => onCommit(e.currentTarget.value)}
      >
        {control.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }
  return (
    <span className="desktop-styles__field">
      {control.kind === "color" && (
        <span
          className="desktop-styles__chip"
          aria-hidden="true"
          style={{ "--style-fill": value } as CSSProperties}
        />
      )}
      <input
        // Remount when the style changes elsewhere (undo, a collaborator) so the field follows.
        key={value}
        className="desktop-styles__input"
        aria-label={label}
        defaultValue={value}
        readOnly={readOnly}
        spellCheck={false}
        {...(control.kind === "number"
          ? { type: "number", min: control.min, max: control.max, step: control.step }
          : { type: "text" })}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") e.currentTarget.blur();
          else if (e.key === "Escape") {
            e.currentTarget.value = value;
            e.currentTarget.blur();
          }
        }}
        onBlur={(e) => onCommit(e.currentTarget.value)}
      />
    </span>
  );
}

function RenameInput({
  initial,
  onDone,
}: {
  initial: string;
  onDone: (name: string | null) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (value: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(value);
  };
  return (
    <input
      ref={ref}
      className="desktop-layers__rename"
      defaultValue={initial}
      aria-label="Style name"
      maxLength={80}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(e.currentTarget.value);
        else if (e.key === "Escape") finish(null);
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
    />
  );
}

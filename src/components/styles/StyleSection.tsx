import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { useState, type KeyboardEvent } from "react";
import {
  applyStyleToSelection,
  createStyleFromSelection,
  deleteSceneStyle,
  pushElementOverridesToStyle,
  resetSelectionStyleOverrides,
  updateSceneStyle,
} from "../../extensions/styles/host";
import type { PanelApi } from "../propertiesPanel/panel";
import { PROP_LABELS, type StyleSectionView } from "./stylesView";

const NEW = "__new__";
const MIXED = "__mixed__";

/** Keeps Excalidraw's canvas focused so its shortcuts keep working after a click. */
const keepFocus = (e: { preventDefault(): void }) => e.preventDefault();

/** Renames a style in place: Enter / blur commits, Escape cancels. */
function RenameField({ name, onDone }: { name: string; onDone(name: string | null): void }) {
  const keys = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.currentTarget.blur();
    } else if (e.key === "Escape") {
      e.stopPropagation();
      e.currentTarget.value = name;
      onDone(null);
    }
  };
  return (
    <input
      className="shape-data__input"
      aria-label="Style name"
      data-testid="style-section-name"
      defaultValue={name}
      autoFocus
      spellCheck={false}
      onKeyDown={keys}
      onBlur={(e) => onDone(e.currentTarget.value)}
    />
  );
}

export function StyleSection({ view, api: panelApi }: { view: StyleSectionView; api: PanelApi }) {
  // The host passes the editor's full imperative API; the panel type only narrows it.
  const api = panelApi as ExcalidrawImperativeAPI;
  const [renaming, setRenaming] = useState(false);

  if (view.master) {
    return (
      <fieldset className="style-section">
        <div className="style-section__note" data-testid="style-section-master">
          {view.master.name
            ? `Follows its component master (${view.master.name})`
            : "Follows its component master"}
        </div>
      </fieldset>
    );
  }

  const value = view.current === "mixed" ? MIXED : (view.current ?? "");
  const onChange = (next: string) => {
    if (next === NEW) createStyleFromSelection(api);
    else if (next !== MIXED) applyStyleToSelection(api, next || null);
  };
  const single = view.overrideIds.length === 1 && view.ids.length === 1;
  const linked = view.styles.find((st) => st.id === view.current) ?? null;

  return (
    <fieldset className="style-section">
      <select
        className="style-section__select"
        aria-label="Named style"
        data-testid="style-section-picker"
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
      >
        <option value="">None</option>
        {view.current === "mixed" && (
          <option value={MIXED} disabled>
            Mixed
          </option>
        )}
        {view.styles.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
        <option value={NEW}>New style from selection…</option>
      </select>
      {linked &&
        (renaming ? (
          <RenameField
            name={linked.name}
            onDone={(name) => {
              setRenaming(false);
              if (name?.trim() && name.trim() !== linked.name) {
                updateSceneStyle(api, linked.id, { name });
              }
            }}
          />
        ) : (
          <div className="style-section__actions">
            <button
              type="button"
              className="style-section__btn"
              data-testid="style-section-rename"
              onMouseDown={keepFocus}
              onClick={() => setRenaming(true)}
            >
              Rename
            </button>
            <button
              type="button"
              className="style-section__btn"
              data-testid="style-section-delete"
              title="Delete the style; its elements keep their look"
              onMouseDown={keepFocus}
              onClick={() => deleteSceneStyle(api, linked.id)}
            >
              Delete style
            </button>
          </div>
        ))}
      {view.overrides.length > 0 && (
        <div className="style-section__overrides" data-testid="style-section-overrides">
          <div className="style-section__note">
            Overridden: {view.overrides.map((k) => PROP_LABELS[k]).join(", ")}
          </div>
          <div className="style-section__actions">
            <button
              type="button"
              className="style-section__btn"
              onMouseDown={keepFocus}
              onClick={() => resetSelectionStyleOverrides(api, view.overrideIds)}
            >
              Reset overrides
            </button>
            {single && (
              <button
                type="button"
                className="style-section__btn"
                title="Make this element's overrides part of the style"
                onMouseDown={keepFocus}
                onClick={() => pushElementOverridesToStyle(api, view.overrideIds[0])}
              >
                Update style
              </button>
            )}
          </div>
        </div>
      )}
    </fieldset>
  );
}

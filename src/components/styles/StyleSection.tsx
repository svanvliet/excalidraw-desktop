import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import {
  applyStyleToSelection,
  createStyleFromSelection,
  pushElementOverridesToStyle,
  resetSelectionStyleOverrides,
} from "../../extensions/styles/host";
import type { PanelApi } from "../propertiesPanel/panel";
import { PROP_LABELS, type StyleSectionView } from "./stylesView";

const NEW = "__new__";
const MIXED = "__mixed__";

/** Keeps Excalidraw's canvas focused so its shortcuts keep working after a click. */
const keepFocus = (e: { preventDefault(): void }) => e.preventDefault();

export function StyleSection({ view, api: panelApi }: { view: StyleSectionView; api: PanelApi }) {
  // The host passes the editor's full imperative API; the panel type only narrows it.
  const api = panelApi as ExcalidrawImperativeAPI;

  if (view.master) {
    return (
      <fieldset className="style-section">
        <legend>Style</legend>
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

  return (
    <fieldset className="style-section">
      <legend>Style</legend>
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

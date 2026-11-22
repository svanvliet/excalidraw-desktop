import { useEffect, useState, type KeyboardEvent } from "react";
import { normaliseKey, normaliseValue, patchEntries, renameKey } from "../../lib/shapeData";
import { log } from "../../lib/logger";
import { CloseIcon, CopyIcon, PlusIcon } from "../icons";
import type { PanelApi } from "../propertiesPanel/panel";
import { shapeDataCsv, updateShapeData } from "./commit";
import type { DataView } from "./dataPanelSection";

/** Enter commits (via blur); Escape reverts. Both stay away from Excalidraw's shortcuts. */
function commitKeys(e: KeyboardEvent<HTMLInputElement>, original: string) {
  if (e.key === "Enter") {
    e.preventDefault();
    e.currentTarget.blur();
  } else if (e.key === "Escape") {
    e.stopPropagation();
    e.currentTarget.value = original;
    e.currentTarget.blur();
  }
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function DataSection({ view, api }: { view: DataView; api: PanelApi }) {
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const viewKey = JSON.stringify(view);
  useEffect(() => setError(null), [viewKey]);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const apply = (what: string, fn: Parameters<typeof updateShapeData>[2]): boolean => {
    try {
      updateShapeData(api, view.ids, fn);
      setError(null);
      return true;
    } catch (err) {
      log.warn(`shape-data: ${what} failed`, err);
      setError(errorText(err));
      return false;
    }
  };

  const add = () => {
    if (!newKey.trim()) return;
    try {
      const key = normaliseKey(newKey);
      const value = normaliseValue(newValue);
      if (apply("add", (e) => patchEntries(e, { [key]: value }))) {
        setNewKey("");
        setNewValue("");
      }
    } catch (err) {
      setError(errorText(err));
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shapeDataCsv(api, view.ids));
      setCopied(true);
    } catch (err) {
      log.warn("shape-data: clipboard write failed", err);
      setError("Couldn't copy to the clipboard");
    }
  };

  const multi = view.ids.length > 1;
  return (
    <fieldset className="shape-data__fieldset">
      {multi && <legend>{`${view.ids.length} elements`}</legend>}
      <div className="shape-data__rows" role="list">
        {view.rows.map((row) => (
          <div
            key={`${row.key}\u0000${row.value ?? "\u0001"}`}
            className="shape-data__row"
            role="listitem"
            data-testid="shape-data-row"
          >
            <input
              className="shape-data__input"
              aria-label={`Key ${row.key}`}
              defaultValue={row.key}
              readOnly={view.readOnly}
              spellCheck={false}
              onKeyDown={(e) => commitKeys(e, row.key)}
              onBlur={(e) => {
                const raw = e.currentTarget.value;
                if (raw === row.key) return;
                try {
                  const to = normaliseKey(raw);
                  if (to !== row.key) apply("rename", (en) => renameKey(en, row.key, to));
                } catch (err) {
                  e.currentTarget.value = row.key;
                  setError(errorText(err));
                }
              }}
            />
            <input
              className="shape-data__input"
              aria-label={`Value of ${row.key}`}
              defaultValue={row.value ?? ""}
              placeholder={row.value === null ? "Mixed" : undefined}
              readOnly={view.readOnly}
              spellCheck={false}
              onKeyDown={(e) => commitKeys(e, row.value ?? "")}
              onBlur={(e) => {
                const raw = e.currentTarget.value;
                if (raw === (row.value ?? "") && !(row.value === null && raw)) return;
                apply("edit", (en) => patchEntries(en, { [row.key]: normaliseValue(raw) }));
              }}
            />
            <button
              type="button"
              className="shape-data__icon"
              title={`Remove ${row.key}`}
              aria-label={`Remove ${row.key}`}
              disabled={view.readOnly}
              onClick={() => apply("remove", (en) => patchEntries(en, { [row.key]: null }))}
            >
              <CloseIcon size={14} />
            </button>
          </div>
        ))}
        {!view.readOnly && (
          <div className="shape-data__row" data-testid="shape-data-new">
            <input
              className="shape-data__input"
              aria-label="New key"
              placeholder="Key"
              value={newKey}
              spellCheck={false}
              onChange={(e) => setNewKey(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && add()}
            />
            <input
              className="shape-data__input"
              aria-label="New value"
              placeholder="Value"
              value={newValue}
              spellCheck={false}
              onChange={(e) => setNewValue(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && add()}
            />
            <button
              type="button"
              className="shape-data__icon"
              title="Add data"
              aria-label="Add data"
              disabled={!newKey.trim()}
              onClick={add}
            >
              <PlusIcon size={14} />
            </button>
          </div>
        )}
      </div>
      {view.partial > 0 && (
        <div className="shape-data__note">
          {view.partial === 1 ? "+1 key not shared" : `+${view.partial} keys not shared`}
        </div>
      )}
      {view.readOnly && (
        <div className="shape-data__note">
          Written by a newer version, so it&apos;s read-only here.
        </div>
      )}
      <button
        type="button"
        className="shape-data__copy"
        data-testid="shape-data-copy"
        onClick={() => void copy()}
      >
        <CopyIcon size={14} />
        {copied ? "Copied" : "Copy data as CSV"}
      </button>
      {error && (
        <div className="props-section__error" role="alert">
          {error}
        </div>
      )}
    </fieldset>
  );
}

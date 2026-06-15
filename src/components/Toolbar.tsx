import { useCallback } from "react";

export interface ToolbarProps {
  documentPath: string | null;
  dirty: boolean;
  onOpen: () => void;
  onSave: () => void;
  onSaveAs: () => void;
}

/**
 * Temporary in-window toolbar so M2 has a way to invoke open/save before
 * the native menu bar arrives in M5. The native menu will dispatch into
 * the same handlers.
 */
export function Toolbar({ documentPath, dirty, onOpen, onSave, onSaveAs }: ToolbarProps) {
  const titleLabel = documentPath ?? "Untitled";
  const dirtyMark = dirty ? " •" : "";

  const handleOpen = useCallback(() => onOpen(), [onOpen]);
  const handleSave = useCallback(() => onSave(), [onSave]);
  const handleSaveAs = useCallback(() => onSaveAs(), [onSaveAs]);

  return (
    <header className="toolbar" data-testid="toolbar">
      <div className="toolbar__title" title={titleLabel}>
        <span className="toolbar__name">{basename(titleLabel)}</span>
        <span className="toolbar__dirty">{dirtyMark}</span>
      </div>
      <div className="toolbar__actions">
        <button type="button" onClick={handleOpen}>
          Open…
        </button>
        <button type="button" onClick={handleSave} disabled={!dirty && documentPath !== null}>
          Save
        </button>
        <button type="button" onClick={handleSaveAs}>
          Save As…
        </button>
      </div>
    </header>
  );
}

function basename(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

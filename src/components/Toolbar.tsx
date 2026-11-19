import { useCallback, type ReactNode } from "react";
import {
  ExportIcon,
  FolderOpenIcon,
  LinkIcon,
  SaveAsIcon,
  SaveIcon,
  SettingsIcon,
  UsersIcon,
} from "./icons";
import { ThemeToggle } from "./ThemeToggle";

export interface ToolbarProps {
  documentPath: string | null;
  dirty: boolean;
  onOpen: () => void;
  onSave: () => void;
  onSaveAs: () => void;
  onExportPng?: () => void;
  onOpenSettings?: () => void;
  /** Opens the live-collaboration Share dialog. */
  onShare?: () => void;
  /** Opens the Join-session dialog. */
  onJoin?: () => void;
  /**
   * Participant count while a live session is active (shown as a badge on
   * Share). `null`/omitted = no session.
   */
  livePeerCount?: number | null;
  /** Slot rendered between Open and Save — used for the Recent menu. */
  children?: ReactNode;
}

/**
 * Compact icon-first toolbar. Buttons carry visible labels for the
 * primary actions (Open, Save, Save As) and become icon-only for
 * secondary actions (Export, Settings, Theme) where the icon is
 * unambiguous. All icon-only buttons carry `aria-label` for
 * accessibility and tests.
 *
 * The native menu bar (M5) exposes the same actions; this in-window
 * toolbar is the quick-access affordance.
 */
export function Toolbar({
  documentPath,
  dirty,
  onOpen,
  onSave,
  onSaveAs,
  onExportPng,
  onOpenSettings,
  onShare,
  onJoin,
  livePeerCount,
  children,
}: ToolbarProps) {
  const live = livePeerCount !== null && livePeerCount !== undefined;
  const titleLabel = documentPath ?? "Untitled";

  const handleOpen = useCallback(() => onOpen(), [onOpen]);
  const handleSave = useCallback(() => onSave(), [onSave]);
  const handleSaveAs = useCallback(() => onSaveAs(), [onSaveAs]);
  const handleExportPng = useCallback(() => onExportPng?.(), [onExportPng]);
  const handleOpenSettings = useCallback(() => onOpenSettings?.(), [onOpenSettings]);

  return (
    <header className="toolbar" data-testid="toolbar">
      <div className="toolbar__title" title={titleLabel}>
        <span className="toolbar__name">{basename(titleLabel)}</span>
        {dirty ? (
          <span className="toolbar__dirty" aria-label="Unsaved changes" title="Unsaved changes">
            •
          </span>
        ) : null}
      </div>
      <div className="toolbar__actions">
        <button type="button" className="icon-btn" onClick={handleOpen} title="Open file">
          <FolderOpenIcon />
          <span>Open</span>
        </button>
        {children}
        <span className="toolbar__divider" aria-hidden="true" />
        <button
          type="button"
          className="icon-btn"
          onClick={handleSave}
          disabled={!dirty && documentPath !== null}
          title="Save"
          aria-label="Save"
        >
          <SaveIcon />
          <span>Save</span>
        </button>
        <button
          type="button"
          className="icon-btn"
          onClick={handleSaveAs}
          title="Save As…"
          aria-label="Save As"
        >
          <SaveAsIcon />
          <span>Save As</span>
        </button>
        {onExportPng ? (
          <button
            type="button"
            className="icon-btn icon-btn--icon-only"
            onClick={handleExportPng}
            title="Export PNG"
            aria-label="Export PNG"
          >
            <ExportIcon />
          </button>
        ) : null}
        {onShare || onJoin ? <span className="toolbar__divider" aria-hidden="true" /> : null}
        {onShare ? (
          <button
            type="button"
            className="icon-btn"
            onClick={onShare}
            data-testid="toolbar-share"
            data-pressed={live || undefined}
            title={
              live ? `Live session — ${livePeerCount} connected` : "Share (live collaboration)"
            }
            aria-label={live ? `Share, live session with ${livePeerCount} connected` : "Share"}
          >
            <UsersIcon />
            <span>Share</span>
            {live ? (
              <span className="toolbar__live-badge" data-testid="toolbar-live-badge">
                {livePeerCount}
              </span>
            ) : null}
          </button>
        ) : null}
        {onJoin ? (
          <button
            type="button"
            className="icon-btn icon-btn--icon-only"
            onClick={onJoin}
            data-testid="toolbar-join"
            aria-label="Join session…"
            title="Join session…"
          >
            <LinkIcon />
          </button>
        ) : null}
        <span className="toolbar__divider" aria-hidden="true" />
        <ThemeToggle />
        {onOpenSettings ? (
          <button
            type="button"
            className="icon-btn icon-btn--icon-only"
            onClick={handleOpenSettings}
            data-testid="toolbar-settings"
            aria-label="Settings"
            title="Settings"
          >
            <SettingsIcon />
          </button>
        ) : null}
      </div>
    </header>
  );
}

function basename(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

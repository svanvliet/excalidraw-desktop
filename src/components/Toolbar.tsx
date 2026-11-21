import { useCallback, type ReactNode } from "react";
import {
  ExportIcon,
  FolderOpenIcon,
  LinkIcon,
  LiveIcon,
  SaveAsIcon,
  SaveIcon,
  SettingsIcon,
  SparklesIcon,
  UsersIcon,
} from "./icons";
import { ThemeToggle } from "./ThemeToggle";
import { LayoutMenu } from "./LayoutMenu";
import { displayName } from "../lib/fileFormat";

function isMac(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
}

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
  /** A live session is bound to a different tab than the active one. */
  liveElsewhere?: boolean;
  /** Toggles the AI agent panel. Omit to hide the button (AI setting off). */
  onToggleAgent?: () => void;
  /** AI agent panel is open. */
  agentOpen?: boolean;
  /** Runs a Layout command (src/layout/commands.json). Omit to hide the Layout dropdown. */
  onLayoutCommand?: (id: string) => void;
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
  liveElsewhere = false,
  onToggleAgent,
  agentOpen = false,
  onLayoutCommand,
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
        <span className="toolbar__name">{displayName(titleLabel)}</span>
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
        {onLayoutCommand ? (
          <>
            <span className="toolbar__divider" aria-hidden="true" />
            <LayoutMenu onRun={onLayoutCommand} />
          </>
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
              live
                ? `Live session — ${livePeerCount} connected`
                : liveElsewhere
                  ? "A different tab is being shared"
                  : "Share (live collaboration)"
            }
            aria-label={
              live
                ? `Share, live session with ${livePeerCount} connected`
                : liveElsewhere
                  ? "Share, a different tab is being shared"
                  : "Share"
            }
          >
            <UsersIcon />
            <span>Share</span>
            {live ? (
              <span className="toolbar__live-badge" data-testid="toolbar-live-badge">
                {livePeerCount}
              </span>
            ) : liveElsewhere ? (
              <span className="toolbar__live-elsewhere" data-testid="toolbar-live-elsewhere">
                <LiveIcon className="icon icon--sm" />
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
        {onToggleAgent ? (
          <button
            type="button"
            className="icon-btn"
            onClick={onToggleAgent}
            data-testid="toolbar-agent"
            data-pressed={agentOpen || undefined}
            aria-pressed={agentOpen}
            aria-label="AI agent"
            title={`${agentOpen ? "Hide" : "Show"} AI agent (${isMac() ? "⌘⇧A" : "Ctrl+Shift+A"})`}
          >
            <SparklesIcon />
            <span>AI</span>
          </button>
        ) : null}
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

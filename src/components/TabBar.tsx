import type { Tab } from "../stores/tabsStore";
import { CloseIcon, LiveIcon, PlusIcon } from "./icons";

export interface TabBarProps {
  tabs: Tab[];
  activeTabId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  /** Tab bound to the live collaboration session, if any. */
  liveTabId?: string | null;
}

export function TabBar({ tabs, activeTabId, onSelect, onClose, onNew, liveTabId }: TabBarProps) {
  return (
    <div className="tabbar" role="tablist" data-testid="tabbar">
      <div className="tabbar__tabs">
        {tabs.map((tab) => (
          <TabEntry
            key={tab.id}
            tab={tab}
            active={tab.id === activeTabId}
            live={tab.id === liveTabId}
            onSelect={() => onSelect(tab.id)}
            onClose={() => onClose(tab.id)}
          />
        ))}
      </div>
      <button
        type="button"
        className="tabbar__new"
        onClick={onNew}
        title="New tab"
        aria-label="New tab"
      >
        <PlusIcon className="icon icon--sm" />
      </button>
    </div>
  );
}

function TabEntry({
  tab,
  active,
  live,
  onSelect,
  onClose,
}: {
  tab: Tab;
  active: boolean;
  live: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const label = tab.path ? basename(tab.path) : "Untitled";
  return (
    <div
      role="tab"
      aria-selected={active}
      data-active={active || undefined}
      className="tabbar__tab"
      onClick={onSelect}
      onMouseDown={(e) => {
        // Middle-click closes
        if (e.button === 1) {
          e.preventDefault();
          onClose();
        }
      }}
      title={tab.path ?? "Untitled"}
    >
      {live ? (
        <span
          className="tabbar__live"
          data-testid="tab-live"
          role="img"
          aria-label="Live session"
          title="Live session: people in the session can see this drawing"
        >
          <LiveIcon className="icon icon--sm" />
        </span>
      ) : null}
      <span className="tabbar__label">{label}</span>
      {tab.dirty ? <span className="tabbar__dirty" aria-label="unsaved changes" /> : null}
      <button
        type="button"
        className="tabbar__close"
        aria-label={`Close ${label}`}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
      >
        <CloseIcon className="icon icon--sm" />
      </button>
    </div>
  );
}

function basename(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

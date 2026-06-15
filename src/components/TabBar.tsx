import type { Tab } from "../stores/tabsStore";

export interface TabBarProps {
  tabs: Tab[];
  activeTabId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
}

export function TabBar({ tabs, activeTabId, onSelect, onClose, onNew }: TabBarProps) {
  return (
    <div className="tabbar" role="tablist" data-testid="tabbar">
      <div className="tabbar__tabs">
        {tabs.map((tab) => (
          <TabEntry
            key={tab.id}
            tab={tab}
            active={tab.id === activeTabId}
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
        +
      </button>
    </div>
  );
}

function TabEntry({
  tab,
  active,
  onSelect,
  onClose,
}: {
  tab: Tab;
  active: boolean;
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
      <span className="tabbar__label">{label}</span>
      {tab.dirty ? (
        <span className="tabbar__dirty" aria-label="unsaved changes">
          •
        </span>
      ) : null}
      <button
        type="button"
        className="tabbar__close"
        aria-label={`Close ${label}`}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
      >
        ×
      </button>
    </div>
  );
}

function basename(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

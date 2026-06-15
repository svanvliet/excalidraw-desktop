import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDownIcon, ClockIcon } from "./icons";

export interface RecentMenuProps {
  paths: readonly string[];
  onOpen: (path: string) => void;
  onClear: () => void;
}

/**
 * Lightweight popover for Open Recent. Visually mirrors the toolbar's
 * icon-first buttons but expands into a vertical list of recent file
 * basenames + paths.
 *
 * Behavior preserved from M3: click-outside closes, Escape closes,
 * Clear Recent appears as a separator-divided menuitem.
 */
export function RecentMenu({ paths, onOpen, onClear }: RecentMenuProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const container = containerRef.current;
      if (container && event.target instanceof Node && !container.contains(event.target)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const handleSelect = useCallback(
    (path: string) => {
      setOpen(false);
      onOpen(path);
    },
    [onOpen],
  );

  const handleClear = useCallback(() => {
    setOpen(false);
    onClear();
  }, [onClear]);

  return (
    <div className="popover" ref={containerRef}>
      <button
        type="button"
        className="icon-btn"
        onClick={() => setOpen((prev) => !prev)}
        disabled={paths.length === 0}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Open recent file"
      >
        <ClockIcon />
        <span>Recent</span>
        <ChevronDownIcon className="icon icon--sm" />
      </button>
      {open ? (
        <ul className="popover__panel" role="menu" data-testid="recent-menu-list">
          {paths.map((path) => (
            <li key={path} role="none">
              <button
                type="button"
                role="menuitem"
                className="popover__item"
                onClick={() => handleSelect(path)}
                title={path}
              >
                <span className="popover__item-name">{basename(path)}</span>
                <span className="popover__item-path">{path}</span>
              </button>
            </li>
          ))}
          <li role="separator" className="popover__separator" />
          <li role="none">
            <button type="button" role="menuitem" className="popover__item" onClick={handleClear}>
              <span className="popover__item-name">Clear Recent</span>
            </button>
          </li>
        </ul>
      ) : null}
    </div>
  );
}

function basename(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

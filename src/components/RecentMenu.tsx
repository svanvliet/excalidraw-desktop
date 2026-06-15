import { useCallback, useEffect, useRef, useState } from "react";

export interface RecentMenuProps {
  paths: readonly string[];
  onOpen: (path: string) => void;
  onClear: () => void;
}

/**
 * Lightweight dropdown for Open Recent. The native menu in M5 will surface
 * the same list — this in-window control is the toolbar-side affordance.
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
    <div className="recent-menu" ref={containerRef}>
      <button
        type="button"
        className="recent-menu__trigger"
        onClick={() => setOpen((prev) => !prev)}
        disabled={paths.length === 0}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        Recent ▾
      </button>
      {open ? (
        <ul className="recent-menu__list" role="menu" data-testid="recent-menu-list">
          {paths.map((path) => (
            <li key={path} role="none">
              <button
                type="button"
                role="menuitem"
                className="recent-menu__item"
                onClick={() => handleSelect(path)}
                title={path}
              >
                <span className="recent-menu__name">{basename(path)}</span>
                <span className="recent-menu__path">{path}</span>
              </button>
            </li>
          ))}
          <li role="separator" className="recent-menu__separator" />
          <li role="none">
            <button
              type="button"
              role="menuitem"
              className="recent-menu__clear"
              onClick={handleClear}
            >
              Clear Recent
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

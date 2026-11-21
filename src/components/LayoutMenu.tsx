import { useEffect, useRef, useState } from "react";
import { ChevronDownIcon, LayoutIcon } from "./icons";
import spec from "../layout/commands.json";
import { formatShortcut } from "../layout/format";

export interface LayoutMenuProps {
  /** Runs a Layout command by id (see src/layout/commands.ts). */
  onRun: (id: string) => void;
  disabled?: boolean;
}

type Entry = { id?: string; label?: string; shortcut?: string; separator?: boolean };

const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * Toolbar dropdown with the same commands, in the same order, as the native Layout menu: both
 * come from src/layout/commands.json. Click-outside and Escape close it, like the Recent menu.
 */
export function LayoutMenu({ onRun, disabled = false }: LayoutMenuProps) {
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

  return (
    <div className="popover" ref={containerRef}>
      <button
        type="button"
        className="icon-btn icon-btn--icon-only"
        onClick={() => setOpen((prev) => !prev)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Layout"
        title="Layout"
        data-testid="toolbar-layout"
      >
        <LayoutIcon />
        <ChevronDownIcon className="icon icon--sm" />
      </button>
      {open ? (
        <ul
          className="popover__panel popover__panel--compact"
          role="menu"
          aria-label="Layout"
          data-testid="layout-menu-list"
        >
          {(spec as Entry[]).map((e, i) =>
            e.separator ? (
              <li key={`sep-${i}`} role="separator" className="popover__separator" />
            ) : (
              <li key={e.id} role="none">
                <button
                  type="button"
                  role="menuitem"
                  className="popover__item popover__item--row"
                  onClick={() => {
                    setOpen(false);
                    onRun(e.id!);
                  }}
                >
                  <span className="popover__item-name">{e.label}</span>
                  {e.shortcut ? (
                    <span className="popover__item-shortcut">
                      {formatShortcut(e.shortcut, mac)}
                    </span>
                  ) : null}
                </button>
              </li>
            ),
          )}
        </ul>
      ) : null}
    </div>
  );
}

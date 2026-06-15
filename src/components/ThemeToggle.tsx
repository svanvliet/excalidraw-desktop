/**
 * Tri-state theme toggle. Cycles system → light → dark → system.
 *
 * The icon reflects the *user preference*, not the resolved theme, so
 * the button is honest about what mode you're in:
 *   - system: Monitor icon
 *   - light:  Sun icon
 *   - dark:   Moon icon
 *
 * Accessible name announces both the current mode and what the next
 * click will switch to.
 */
import { useCallback } from "react";
import { useThemeStore, type ThemeMode } from "../stores/themeStore";
import { MonitorIcon, MoonIcon, SunIcon } from "./icons";

const NEXT: Record<ThemeMode, ThemeMode> = {
  system: "light",
  light: "dark",
  dark: "system",
};

const LABEL: Record<ThemeMode, string> = {
  system: "System theme",
  light: "Light theme",
  dark: "Dark theme",
};

export function ThemeToggle() {
  const mode = useThemeStore((s) => s.mode);
  const cycle = useThemeStore((s) => s.cycle);

  const handleClick = useCallback(() => {
    void cycle();
  }, [cycle]);

  const next = NEXT[mode];
  const title = `${LABEL[mode]} — click for ${LABEL[next].toLowerCase()}`;

  return (
    <button
      type="button"
      className="icon-btn icon-btn--icon-only"
      onClick={handleClick}
      aria-label={title}
      title={title}
      data-testid="theme-toggle"
      data-theme-mode={mode}
    >
      {mode === "system" ? <MonitorIcon /> : mode === "light" ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}

/** "Alt+Shift+L" → "⌥⇧L" on macOS; unchanged elsewhere. */
export function formatShortcut(shortcut: string, mac: boolean): string {
  if (!mac) return shortcut;
  const sym: Record<string, string> = { Alt: "⌥", Shift: "⇧", Ctrl: "⌃", Cmd: "⌘", Mod: "⌘" };
  return shortcut
    .split("+")
    .map((k) => sym[k] ?? k)
    .join("");
}

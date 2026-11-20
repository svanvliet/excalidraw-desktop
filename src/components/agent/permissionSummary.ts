/**
 * What a permission card shows: a one-line heading and the full command or input once.
 * Older records carry JSON-escaped tool input, and Copilot titles shell requests with the
 * whole (possibly multi-line) script, so both are normalised here.
 */
export function permissionSummary(title: string, detail: string | null) {
  const heading =
    title
      .split("\n")
      .find((l) => l.trim() !== "")
      ?.trim() ?? title;
  let body = detail?.trim() ? detail : null;
  if (body) {
    try {
      const parsed: unknown = JSON.parse(body);
      if (parsed && typeof parsed === "object" && "command" in parsed) {
        const cmd = (parsed as { command: unknown }).command;
        if (typeof cmd === "string") body = cmd;
        else if (Array.isArray(cmd) && cmd.every((x) => typeof x === "string"))
          body = cmd.join(" ");
      }
    } catch {
      // Not JSON: already readable.
    }
  }
  if (!body && title.trim() !== heading) body = title.trim();
  return { heading, body };
}

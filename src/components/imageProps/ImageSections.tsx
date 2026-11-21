import { useCallback, useEffect, useState } from "react";
import type { ExtensionGroup } from "../../extensions/groups";
import { runExtension, type ExtensionAction } from "../../extensions/runner";
import { log } from "../../lib/logger";
import type { PanelApi } from "../propertiesPanel/panel";
import { IMAGE_SECTIONS } from "./registry";
import type { ImageView } from "./types";

/** Renders IMAGE_SECTIONS for the selection, with their shared busy / error state. */
export function ImageSections({ view, api }: { view: ImageView; api: PanelApi }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify(view);
  useEffect(() => setError(null), [key]);

  const run = useCallback(
    async (group: ExtensionGroup, action: ExtensionAction) => {
      setBusy(true);
      setError(null);
      try {
        const res = await runExtension(api, group.ids, group.id, action);
        if (!res.applied.length && res.skipped.length) setError(res.skipped[0]!.reason);
      } catch (err) {
        log.warn(`extensions: ${group.id} ${action.kind} failed`, err);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [api],
  );

  const all = new Map(view.groups.map((g) => [g.id, g]));
  const prefix = view.onlyImages ? "" : "Image ";
  const label = (s: string) => (prefix ? prefix + s.toLowerCase() : s);
  return (
    <>
      {IMAGE_SECTIONS.map(({ id, extensions, Component }) => {
        const groups = new Map(
          extensions.flatMap((e) => (all.has(e) ? [[e, all.get(e)!] as const] : [])),
        );
        if (!groups.size) return null;
        return (
          <Component
            key={id}
            groups={groups}
            onlyImages={view.onlyImages}
            label={label}
            busy={busy}
            run={(g, a) => void run(g, a)}
          />
        );
      })}
      {error && (
        <div className="image-props__error" role="alert">
          {error}
        </div>
      )}
    </>
  );
}

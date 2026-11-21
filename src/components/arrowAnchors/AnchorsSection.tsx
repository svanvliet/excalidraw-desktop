import { useEffect, useState } from "react";
import type { Anchor } from "../../lib/elbowAnchors";
import { log } from "../../lib/logger";
import {
  AnchorCenterIcon,
  AnchorEastIcon,
  AnchorNorthIcon,
  AnchorSouthIcon,
  AnchorWestIcon,
} from "../icons";
import { ButtonRow, IconButton, type Option } from "../propertiesPanel/controls";
import type { PanelApi } from "../propertiesPanel/panel";
import type { AnchorsView, EndView } from "./anchorsPanelSection";
import { setElbowAnchors } from "./commit";

const OPTIONS: readonly Option<Anchor>[] = [
  { value: "n", label: "Top", icon: <AnchorNorthIcon /> },
  { value: "e", label: "Right", icon: <AnchorEastIcon /> },
  { value: "s", label: "Bottom", icon: <AnchorSouthIcon /> },
  { value: "w", label: "Left", icon: <AnchorWestIcon /> },
  { value: "center", label: "Side facing the other end", icon: <AnchorCenterIcon /> },
];

export function AnchorsSection({ view, api }: { view: AnchorsView; api: PanelApi }) {
  const [error, setError] = useState<string | null>(null);
  const viewKey = JSON.stringify(view);
  useEffect(() => setError(null), [viewKey]);

  const pin = (which: "start" | "end", anchor: Anchor) => {
    try {
      setElbowAnchors(api, view.id, { [which]: anchor });
      setError(null);
    } catch (err) {
      log.warn(`arrow-anchors: pin ${which} failed`, err);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const row = (which: "start" | "end", end: EndView) =>
    end.bound && (
      <ButtonRow
        legend={which === "start" ? "Start anchor" : "End anchor"}
        testId={`anchor-${which}`}
      >
        {OPTIONS.map((o) => (
          <IconButton
            key={o.value}
            label={`${which === "start" ? "Start" : "End"}: ${o.label}`}
            icon={o.icon}
            active={end.side === o.value}
            onClick={() => pin(which, o.value)}
          />
        ))}
      </ButtonRow>
    );

  return (
    <>
      {row("start", view.start)}
      {row("end", view.end)}
      {error && <div className="props-section__error">{error}</div>}
    </>
  );
}

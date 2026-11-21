/**
 * Shown while a library-backed master is on the canvas for editing ("Edit master…"): Done saves
 * it to My components and takes it off the canvas; Cancel puts everything back.
 */
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { useState } from "react";
import { cancelMasterEdit, finishMasterEdit, useMasterEdit } from "./libraryMasters";

export function MasterEditBanner({ api }: { api: ExcalidrawImperativeAPI | null }) {
  const edit = useMasterEdit(api);
  const [busy, setBusy] = useState(false);
  if (!api || !edit) return null;
  return (
    <div className="desktop-master-edit" role="status" data-testid="master-edit-banner">
      <span className="desktop-master-edit__text">
        Editing the master of <strong>{edit.name}</strong>. Changes show in its instances.
      </span>
      <button
        type="button"
        className="desktop-master-edit__btn"
        data-testid="master-edit-cancel"
        disabled={busy}
        onClick={() => cancelMasterEdit(api)}
      >
        Cancel
      </button>
      <button
        type="button"
        className="desktop-master-edit__btn desktop-master-edit__btn--primary"
        data-testid="master-edit-done"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void finishMasterEdit(api).finally(() => setBusy(false));
        }}
      >
        Done
      </button>
    </div>
  );
}

/**
 * Three-button confirmation modal for "this tab has unsaved changes" flows.
 *
 * Native dialogs from @tauri-apps/plugin-dialog only support yes/no; we need
 * Save / Don't Save / Cancel to satisfy FR-10, so we render an in-app modal.
 * The same component will be reused by the native File menu in M5.
 */
import { useEffect, useRef } from "react";

export interface ConfirmCloseDialogProps {
  open: boolean;
  tabLabel: string;
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}

export function ConfirmCloseDialog({
  open,
  tabLabel,
  onSave,
  onDiscard,
  onCancel,
}: ConfirmCloseDialogProps) {
  const saveRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) saveRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onCancel]);

  if (!open) return null;
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-close-title"
        className="modal"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="confirm-close-title" className="modal__title">
          {tabLabel} has unsaved changes
        </h2>
        <p className="modal__body">Save your changes before closing?</p>
        <div className="modal__actions">
          <button type="button" onClick={onDiscard}>
            Don&rsquo;t Save
          </button>
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" onClick={onSave} ref={saveRef} className="modal__primary">
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

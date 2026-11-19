/**
 * Join a live-collaboration session by pasting a share link. Joining
 * connects to someone else's relay, so it is gated by the same collab
 * toggle as hosting.
 */
import { useEffect, useRef, useState } from "react";
import type { RoomLink } from "../collab/protocol";
import { parseShareLink } from "../stores/collabStore";
import { useSettingsStore } from "../stores/settingsStore";
import { CloseIcon } from "./icons";

export interface JoinDialogProps {
  open: boolean;
  onClose: () => void;
  onJoin: (link: RoomLink) => void;
  onOpenSettings: () => void;
}

export function JoinDialog({ open, onClose, onJoin, onOpenSettings }: JoinDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const collabEnabled = useSettingsStore((s) => s.collab);
  const [value, setValue] = useState("");

  useEffect(() => {
    if (open) {
      setValue("");
      inputRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  const parsed = parseShareLink(value);
  const showInvalid = value.trim() !== "" && !parsed;

  const submit = () => {
    if (!parsed) return;
    onJoin(parsed);
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose} data-testid="join-backdrop">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="join-title"
        className="modal"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal__header">
          <div>
            <h2 id="join-title" className="modal__title">
              Join session
            </h2>
            <p className="modal__subtitle">Opens the shared drawing in a new tab.</p>
          </div>
          <button
            type="button"
            className="icon-btn icon-btn--icon-only"
            onClick={onClose}
            aria-label="Close"
            title="Close"
          >
            <CloseIcon />
          </button>
        </header>
        <div className="modal__body share__body">
          {collabEnabled ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                submit();
              }}
            >
              <label className="settings__field">
                <span>Session link</span>
                <input
                  ref={inputRef}
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  aria-invalid={showInvalid || undefined}
                  placeholder="https://…/#room=…"
                  data-testid="join-link"
                />
                {showInvalid ? (
                  <span className="settings__error" role="alert">
                    That doesn&rsquo;t look like a session link. It should end with
                    #room=&lt;id&gt;,&lt;key&gt;.
                  </span>
                ) : null}
              </label>
            </form>
          ) : (
            <p className="share__text" data-testid="join-disabled">
              Live collaboration is off. Turn it on in Settings to join a session.
            </p>
          )}
        </div>
        <div className="modal__actions">
          <span className="spacer" />
          {collabEnabled ? (
            <>
              <button type="button" className="modal__secondary" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="modal__primary"
                disabled={!parsed}
                onClick={submit}
                data-testid="join-submit"
              >
                Join
              </button>
            </>
          ) : (
            <button
              type="button"
              className="modal__primary"
              onClick={() => {
                onClose();
                onOpenSettings();
              }}
              data-testid="join-open-settings"
            >
              Open Settings
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

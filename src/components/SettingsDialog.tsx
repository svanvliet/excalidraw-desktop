/**
 * Settings dialog. Surfaces the three online-feature toggles and the two
 * secret fields they depend on.
 *
 * **Privacy contract:** every toggle defaults to `false`, the dialog
 * makes it visually obvious that turning anything on hands data to a
 * third party, and the secrets section ships with a warning that the
 * values are stored unencrypted on disk (until a native keychain
 * integration lands post-v1 — see docs/plan.md §M6 follow-ups).
 *
 * The component is purely presentational; persistence is owned by
 * `useSettingsStore`.
 */
import { useEffect, useRef } from "react";
import { useSettingsStore } from "../stores/settingsStore";
import { CloseIcon } from "./icons";

export interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

export function SettingsDialog({ open, onClose }: SettingsDialogProps) {
  const closeRef = useRef<HTMLButtonElement>(null);

  const collab = useSettingsStore((s) => s.collab);
  const library = useSettingsStore((s) => s.library);
  const ai = useSettingsStore((s) => s.ai);
  const openAiKey = useSettingsStore((s) => s.openAiKey);
  const firebaseConfig = useSettingsStore((s) => s.firebaseConfig);
  const setFlag = useSettingsStore((s) => s.setFlag);
  const setSecret = useSettingsStore((s) => s.setSecret);
  const resetAll = useSettingsStore((s) => s.resetAll);

  useEffect(() => {
    if (open) closeRef.current?.focus();
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
  return (
    <div className="modal-backdrop" onClick={onClose} data-testid="settings-backdrop">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        className="modal modal--wide"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal__header">
          <div>
            <h2 id="settings-title" className="modal__title">
              Settings
            </h2>
            <p className="modal__subtitle">
              Excalidraw Desktop is fully offline by default. Toggle features below to opt in. No
              data leaves your machine until you turn one on.
            </p>
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

        <div className="modal__body">
          <section className="settings__section">
            <h3>Online features</h3>

            <label className="settings__row">
              <input
                type="checkbox"
                className="switch"
                checked={collab}
                onChange={(e) => void setFlag("collab", e.target.checked)}
                data-testid="toggle-collab"
              />
              <span className="settings__row-text">
                <strong>Live collaboration</strong>
                <span className="settings__hint">
                  Connects to a Firebase backend. Requires the Firebase config below.
                </span>
              </span>
            </label>

            <label className="settings__row">
              <input
                type="checkbox"
                className="switch"
                checked={library}
                onChange={(e) => void setFlag("library", e.target.checked)}
                data-testid="toggle-library"
              />
              <span className="settings__row-text">
                <strong>Library browser</strong>
                <span className="settings__hint">
                  Opens libraries.excalidraw.com in your system browser. No in-app webview is
                  loaded.
                </span>
              </span>
            </label>

            <label className="settings__row">
              <input
                type="checkbox"
                className="switch"
                checked={ai}
                onChange={(e) => void setFlag("ai", e.target.checked)}
                data-testid="toggle-ai"
              />
              <span className="settings__row-text">
                <strong>AI text-to-diagram</strong>
                <span className="settings__hint">
                  Sends prompts you type to OpenAI. Requires your own API key below.
                </span>
              </span>
            </label>
          </section>

          <section className="settings__section">
            <h3>Secrets</h3>
            <p className="settings__warning" role="note">
              Values below are stored unencrypted in <code>settings.json</code>. Treat this file
              like a credentials file on your machine.
            </p>

            <label className="settings__field">
              <span>OpenAI API key</span>
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={openAiKey}
                onChange={(e) => void setSecret("openAiKey", e.target.value)}
                data-testid="secret-openai"
                placeholder="sk-…"
              />
            </label>

            <label className="settings__field">
              <span>Firebase config (JSON)</span>
              <textarea
                spellCheck={false}
                value={firebaseConfig}
                onChange={(e) => void setSecret("firebaseConfig", e.target.value)}
                data-testid="secret-firebase"
                rows={4}
                placeholder='{"apiKey":"…","authDomain":"…"}'
              />
            </label>
          </section>
        </div>

        <div className="modal__actions">
          <button
            type="button"
            onClick={() => void resetAll()}
            data-testid="settings-reset"
            className="modal__danger"
          >
            Reset all
          </button>
          <span className="spacer" />
          <button
            type="button"
            onClick={onClose}
            ref={closeRef}
            className="modal__primary"
            data-testid="settings-close"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

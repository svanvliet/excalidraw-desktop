/**
 * Auto-update UI: the one-time consent prompt, the "Restart to update"
 * toast, and the "Check for Updates…" menu handler. Mounted once in App.
 *
 * Nothing here contacts the network by itself — checks go through
 * `useUpdateStore`, gated on the `autoUpdate` setting (see updateStore.ts).
 */
import { useEffect, useRef, useState } from "react";
import { onMenuEvent } from "../ipc/menuEvents";
import { log } from "../lib/logger";
import { useCollabStore } from "../stores/collabStore";
import { useSettingsStore } from "../stores/settingsStore";
import {
  selectShowReady,
  setBeforeInstall,
  startUpdateScheduler,
  useUpdateStore,
} from "../stores/updateStore";

export interface UpdateControllerProps {
  /** Flush autosaves etc. before the app restarts into the update. */
  onBeforeRestart?: () => Promise<void>;
}

export function UpdateController({ onBeforeRestart }: UpdateControllerProps) {
  const loaded = useSettingsStore((s) => s.loaded);
  const autoUpdate = useSettingsStore((s) => s.autoUpdate);
  const setAutoUpdate = useSettingsStore((s) => s.setAutoUpdate);
  const enabled = useUpdateStore((s) => s.enabled);
  const status = useUpdateStore((s) => s.status);
  const version = useUpdateStore((s) => s.version);
  const error = useUpdateStore((s) => s.error);
  const showReady = useUpdateStore(selectShowReady);
  const hosting = useCollabStore((s) => s.session?.role === "host");
  const [manualPending, setManualPending] = useState(false);
  const enableRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void useUpdateStore
      .getState()
      .init()
      .then((u) => (cancelled ? u() : (unlisten = u)));
    const stopScheduler = startUpdateScheduler();
    const menu = onMenuEvent((id) => {
      if (id !== "excalidraw:help:checkUpdates") return;
      setManualPending(true);
      void useUpdateStore.getState().checkNow(true);
    }).catch((e) => {
      log.warn("UpdateController: menu subscription unavailable", e);
      return null;
    });
    return () => {
      cancelled = true;
      unlisten?.();
      stopScheduler();
      void menu.then((u) => u?.());
    };
  }, []);

  useEffect(() => {
    setBeforeInstall(onBeforeRestart ?? null);
    return () => setBeforeInstall(null);
  }, [onBeforeRestart]);

  // Only offer the prompt in builds that can actually update.
  const askConsent = loaded && enabled && autoUpdate === null;

  useEffect(() => {
    if (askConsent) enableRef.current?.focus();
  }, [askConsent]);

  useEffect(() => {
    if (!askConsent) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        void setAutoUpdate(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [askConsent, setAutoUpdate]);

  // A menu-triggered check reports its outcome once it settles.
  const manualResult =
    manualPending && (status === "upToDate" || status === "error") ? status : null;

  return (
    <>
      {askConsent ? (
        <div className="modal-backdrop" data-testid="update-consent">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="update-consent-title"
            className="modal"
          >
            <h2 id="update-consent-title" className="modal__title">
              Keep Excalidraw Desktop up to date?
            </h2>
            <p className="modal__body">
              The app can check GitHub for new releases a few times a day and download them in the
              background. Only the app version and platform are sent — never your drawings. You can
              change this anytime in Settings.
            </p>
            <div className="modal__actions">
              <button
                type="button"
                className="modal__secondary"
                onClick={() => void setAutoUpdate(false)}
                data-testid="update-consent-no"
              >
                Not now
              </button>
              <span className="spacer" />
              <button
                type="button"
                ref={enableRef}
                className="modal__primary"
                onClick={() => void setAutoUpdate(true)}
                data-testid="update-consent-yes"
              >
                Check automatically
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showReady ? (
        <div className="update-toast" role="status" data-testid="update-ready">
          <span className="update-toast__text">
            <strong>Version {version} is ready.</strong>
            {hosting ? " Restarting ends your live session." : null}
            {error ? <span className="update-toast__error">{error}</span> : null}
          </span>
          <button
            type="button"
            className="modal__secondary"
            onClick={() => useUpdateStore.getState().dismiss()}
            disabled={status === "installing"}
          >
            Later
          </button>
          <button
            type="button"
            className="modal__primary"
            onClick={() => void useUpdateStore.getState().install()}
            disabled={status === "installing"}
            data-testid="update-restart"
          >
            {status === "installing" ? "Installing…" : "Restart to update"}
          </button>
        </div>
      ) : manualResult ? (
        <div className="update-toast" role="status" data-testid="update-manual-result">
          <span className="update-toast__text">
            {manualResult === "upToDate"
              ? "You’re on the latest version."
              : (error ?? "Couldn’t check for updates.")}
          </span>
          <button
            type="button"
            className="modal__secondary"
            onClick={() => setManualPending(false)}
          >
            OK
          </button>
        </div>
      ) : null}
    </>
  );
}

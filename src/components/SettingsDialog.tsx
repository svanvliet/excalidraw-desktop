/**
 * Settings dialog. Surfaces the three online-feature toggles, the
 * live-collaboration preferences, and the OpenAI key.
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
import { useEffect, useRef, useState } from "react";
import { osUserName, type TunnelMode } from "../ipc/commands";
import { isHttpUrl, isValidPort, useSettingsStore } from "../stores/settingsStore";
import { UpdatesSection } from "./UpdatesSection";
import { CloseIcon } from "./icons";

export interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

const TUNNEL_OPTIONS: { mode: TunnelMode; label: string; hint: string }[] = [
  {
    mode: "auto",
    label: "Auto (Dev Tunnels)",
    hint: "Uses the devtunnel CLI on this machine to create a public HTTPS link for this session.",
  },
  {
    mode: "manual",
    label: "Manual",
    hint: "Paste the public URL of a tunnel you run yourself (e.g. Tunnel Bar) that forwards to the port below.",
  },
  {
    mode: "local",
    label: "Local only",
    hint: "This machine only — useful for testing with a browser or a second app instance.",
  },
];

export function SettingsDialog({ open, onClose }: SettingsDialogProps) {
  const closeRef = useRef<HTMLButtonElement>(null);

  const collab = useSettingsStore((s) => s.collab);
  const library = useSettingsStore((s) => s.library);
  const ai = useSettingsStore((s) => s.ai);
  const openAiKey = useSettingsStore((s) => s.openAiKey);
  const displayName = useSettingsStore((s) => s.collabDisplayName);
  const tunnelMode = useSettingsStore((s) => s.collabTunnelMode);
  const manualUrl = useSettingsStore((s) => s.collabManualUrl);
  const port = useSettingsStore((s) => s.collabPort);
  const setFlag = useSettingsStore((s) => s.setFlag);
  const setSecret = useSettingsStore((s) => s.setSecret);
  const setCollab = useSettingsStore((s) => s.setCollab);
  const autosave = useSettingsStore((s) => s.autosave);
  const setAutosave = useSettingsStore((s) => s.setAutosave);

  // Port is edited as text so the user can clear/retype it; only valid
  // values are committed to the store.
  const [osName, setOsName] = useState("");
  useEffect(() => {
    osUserName()
      .then(setOsName)
      .catch(() => {});
  }, []);
  const [portDraft, setPortDraft] = useState(String(port));
  useEffect(() => setPortDraft(String(port)), [port]);
  const portValid = isValidPort(Number(portDraft)) && /^\d+$/.test(portDraft);
  const manualUrlValid = manualUrl === "" || isHttpUrl(manualUrl);
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
            <h3>Saving</h3>

            <label className="settings__row">
              <input
                type="checkbox"
                className="switch"
                checked={autosave}
                onChange={(e) => void setAutosave(e.target.checked)}
                data-testid="toggle-autosave"
              />
              <span className="settings__row-text">
                <strong>Autosave</strong>
                <span className="settings__hint">
                  Saves changes to the open file a couple of seconds after you stop editing. When
                  off, files change only when you Save. Untitled drawings are always backed up so
                  they survive a restart.
                </span>
              </span>
            </label>
          </section>

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
                  Lets you share a drawing with others through a relay built into this app. Every
                  change and cursor is end-to-end encrypted with a key that only lives in the share
                  link. A session exists only while you host it and this app is running.
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

          <section className="settings__section" data-testid="settings-collab">
            <h3>Live collaboration</h3>

            <label className="settings__field">
              <span>Display name</span>
              <input
                type="text"
                autoComplete="off"
                spellCheck={false}
                maxLength={64}
                value={displayName}
                onChange={(e) => void setCollab("collabDisplayName", e.target.value)}
                data-testid="collab-display-name"
                placeholder={osName || "Shown to other participants"}
                title="Shown to other participants. Defaults to your name on this computer."
              />
            </label>

            <fieldset className="settings__radio-group">
              <legend>Connection</legend>
              {TUNNEL_OPTIONS.map((opt) => (
                <label key={opt.mode} className="settings__row">
                  <input
                    type="radio"
                    name="collab-tunnel-mode"
                    value={opt.mode}
                    checked={tunnelMode === opt.mode}
                    onChange={() => void setCollab("collabTunnelMode", opt.mode)}
                    data-testid={`collab-tunnel-${opt.mode}`}
                  />
                  <span className="settings__row-text">
                    <strong>{opt.label}</strong>
                    <span className="settings__hint">{opt.hint}</span>
                  </span>
                </label>
              ))}
            </fieldset>

            {tunnelMode === "manual" ? (
              <label className="settings__field">
                <span>Public tunnel URL</span>
                <input
                  type="url"
                  autoComplete="off"
                  spellCheck={false}
                  value={manualUrl}
                  onChange={(e) => void setCollab("collabManualUrl", e.target.value.trim())}
                  aria-invalid={!manualUrlValid || undefined}
                  data-testid="collab-manual-url"
                  placeholder="https://my-tunnel.example.com"
                />
                {!manualUrlValid ? (
                  <span className="settings__error" role="alert">
                    Enter an http:// or https:// URL.
                  </span>
                ) : null}
              </label>
            ) : null}

            <label className="settings__field">
              <span>Local port</span>
              <input
                type="text"
                inputMode="numeric"
                autoComplete="off"
                value={portDraft}
                onChange={(e) => {
                  const next = e.target.value.trim();
                  setPortDraft(next);
                  const n = Number(next);
                  if (/^\d+$/.test(next) && isValidPort(n)) void setCollab("collabPort", n);
                }}
                aria-invalid={!portValid || undefined}
                data-testid="collab-port"
              />
              {portValid ? (
                <span className="settings__hint">
                  The relay listens on 127.0.0.1 only; remote participants reach it through the
                  tunnel.
                </span>
              ) : (
                <span className="settings__error" role="alert">
                  Port must be a whole number between 1024 and 65535.
                </span>
              )}
            </label>
          </section>

          <UpdatesSection />

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

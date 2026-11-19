/**
 * "Updates" section of the Settings dialog: the automatic-check toggle,
 * the running version, and a manual "Check now".
 */
import { useSettingsStore } from "../stores/settingsStore";
import { useUpdateStore } from "../stores/updateStore";

function describe(
  status: string,
  version: string | null,
  progress: number | null,
  error: string | null,
): string | null {
  switch (status) {
    case "checking":
      return "Checking for updates…";
    case "upToDate":
      return "You’re on the latest version.";
    case "downloading":
      return progress === null
        ? `Downloading ${version ?? "update"}…`
        : `Downloading ${version ?? "update"}… ${Math.round(progress * 100)}%`;
    case "ready":
      return `Version ${version} is downloaded and ready to install.`;
    case "installing":
      return "Installing…";
    case "error":
      return error ?? "Couldn’t check for updates.";
    default:
      return null;
  }
}

export function UpdatesSection() {
  const autoUpdate = useSettingsStore((s) => s.autoUpdate);
  const setAutoUpdate = useSettingsStore((s) => s.setAutoUpdate);
  const { enabled, currentVersion, status, version, progress, error, install, checkNow } =
    useUpdateStore();
  const busy = status === "checking" || status === "downloading" || status === "installing";
  const message = enabled
    ? describe(status, version, progress, error)
    : "Updates are unavailable in development builds.";

  return (
    <section className="settings__section" data-testid="settings-updates">
      <h3>Updates</h3>
      <label className="settings__row">
        <input
          type="checkbox"
          className="switch"
          checked={autoUpdate === true}
          onChange={(e) => void setAutoUpdate(e.target.checked)}
          data-testid="toggle-auto-update"
        />
        <span className="settings__row-text">
          <strong>Check for updates automatically</strong>
          <span className="settings__hint">
            Checks GitHub Releases a few times a day and downloads new versions in the background.
            Only the app version and platform are sent. You choose when to restart.
          </span>
        </span>
      </label>
      <div className="settings__row">
        <span className="settings__row-text">
          <strong>Version {currentVersion || "—"}</strong>
          {message ? (
            <span
              className={status === "error" ? "settings__error" : "settings__hint"}
              data-testid="update-status"
            >
              {message}
            </span>
          ) : null}
        </span>
        {status === "ready" ? (
          <button
            type="button"
            className="modal__primary"
            onClick={() => void install()}
            data-testid="update-install"
          >
            Restart to update
          </button>
        ) : (
          <button
            type="button"
            className="modal__secondary"
            onClick={() => void checkNow(true)}
            disabled={!enabled || busy}
            data-testid="update-check-now"
          >
            Check now
          </button>
        )}
      </div>
    </section>
  );
}

/**
 * Profile-scoped plugin-store filenames.
 *
 * When the app runs under a test profile (`--profile <name>` /
 * `EXCALIDRAW_DESKTOP_PROFILE`), every plugin-store file gets a `-<name>`
 * suffix so two instances on one machine don't share settings, recent
 * files, or session state. See docs/collab-protocol.md §6.
 */
import { appProfile } from "../ipc/commands";
import { log } from "./logger";

/** Pure: `settings.json` + `bob` → `settings-bob.json`. */
export function scopedStoreFile(base: string, profile: string | null): string {
  if (!profile) return base;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? `${base.slice(0, dot)}-${profile}${base.slice(dot)}` : `${base}-${profile}`;
}

let profilePromise: Promise<string | null> | null = null;

function profile(): Promise<string | null> {
  if (!profilePromise) {
    profilePromise = appProfile().catch((e) => {
      log.warn("storeFile: app_profile failed, using default store files", e);
      return null;
    });
  }
  return profilePromise;
}

/** Resolve the on-disk store filename for the current profile. */
export async function storeFile(base: string): Promise<string> {
  return scopedStoreFile(base, await profile());
}

/** Tests only — forget the cached profile. */
export function __resetStoreProfileForTests(): void {
  profilePromise = null;
}

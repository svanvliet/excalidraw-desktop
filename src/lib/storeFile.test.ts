import { describe, it, expect, vi, beforeEach } from "vitest";

const appProfile = vi.fn<() => Promise<string | null>>();
vi.mock("../ipc/commands", () => ({ appProfile: () => appProfile() }));

import { scopedStoreFile, storeFile, __resetStoreProfileForTests } from "./storeFile";

describe("storeFile", () => {
  beforeEach(() => {
    __resetStoreProfileForTests();
    appProfile.mockReset();
  });

  it("leaves names untouched without a profile", () => {
    expect(scopedStoreFile("settings.json", null)).toBe("settings.json");
  });

  it("inserts -<profile> before the extension", () => {
    expect(scopedStoreFile("recent-files.json", "bob")).toBe("recent-files-bob.json");
    expect(scopedStoreFile("noext", "bob")).toBe("noext-bob");
  });

  it("resolves via app_profile once and caches", async () => {
    appProfile.mockResolvedValue("alice");
    expect(await storeFile("settings.json")).toBe("settings-alice.json");
    expect(await storeFile("session.json")).toBe("session-alice.json");
    expect(appProfile).toHaveBeenCalledTimes(1);
  });

  it("falls back to the default name if app_profile fails", async () => {
    appProfile.mockRejectedValue(new Error("boom"));
    expect(await storeFile("settings.json")).toBe("settings.json");
  });
});

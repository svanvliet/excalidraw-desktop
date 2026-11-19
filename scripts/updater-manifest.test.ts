// @vitest-environment node
import { describe, expect, it } from "vitest";
import { mergeManifest } from "./updater-manifest.mjs";

const now = new Date("2026-11-19T12:00:00.123Z");
const mac = {
  version: "0.1.2",
  platforms: ["darwin-aarch64", "darwin-x86_64"],
  signature: "MACSIG\n",
  url: "https://example.test/mac.app.tar.gz",
  now,
};

describe("mergeManifest", () => {
  it("creates a manifest with the given platforms and defaults", () => {
    expect(mergeManifest(mac)).toEqual({
      version: "0.1.2",
      notes: "Excalidraw Desktop 0.1.2",
      pub_date: "2026-11-19T12:00:00Z",
      platforms: {
        "darwin-aarch64": { signature: "MACSIG", url: mac.url },
        "darwin-x86_64": { signature: "MACSIG", url: mac.url },
      },
    });
  });

  it("preserves other platforms, base notes and pub_date when merging", () => {
    const base = mergeManifest({ ...mac, notes: "Mac notes" });
    const merged = mergeManifest({
      base: { ...base, pub_date: "2026-01-01T00:00:00Z" },
      version: "0.1.2",
      platforms: ["windows-x86_64"],
      signature: "WINSIG",
      url: "https://example.test/setup.exe",
    });
    expect(merged.notes).toBe("Mac notes");
    expect(merged.pub_date).toBe("2026-01-01T00:00:00Z");
    expect(Object.keys(merged.platforms)).toEqual([
      "darwin-aarch64",
      "darwin-x86_64",
      "windows-x86_64",
    ]);
    expect(merged.platforms["darwin-aarch64"].signature).toBe("MACSIG");
  });

  it("lets explicit notes and re-merges replace the base (idempotent)", () => {
    const win = mergeManifest({
      version: "0.1.2",
      platforms: ["windows-x86_64"],
      signature: "WINSIG",
      url: "https://example.test/setup.exe",
      now,
    });
    const once = mergeManifest({ ...mac, base: win, notes: "Real notes" });
    const twice = mergeManifest({ ...mac, base: once, notes: "Real notes" });
    expect(twice).toEqual(once);
    expect(once.notes).toBe("Real notes");
    expect(once.platforms["windows-x86_64"].signature).toBe("WINSIG");
  });

  it("refuses an existing manifest for another version", () => {
    expect(() => mergeManifest({ ...mac, base: { version: "0.1.1", platforms: {} } })).toThrow(
      /version 0\.1\.1, not 0\.1\.2/,
    );
  });

  it("rejects bad platform keys, empty signatures and non-http urls", () => {
    expect(() => mergeManifest({ ...mac, platforms: ["macos"] })).toThrow(/invalid platform/);
    expect(() => mergeManifest({ ...mac, signature: " " })).toThrow(/signature is empty/);
    expect(() => mergeManifest({ ...mac, url: "file:///x" })).toThrow(/url must be http/);
  });
});

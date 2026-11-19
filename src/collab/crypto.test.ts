import { describe, expect, it } from "vitest";
import { base64ToBytes, decrypt, encrypt, generateKey, importKey, isValidKey } from "./crypto";

describe("collab crypto", () => {
  it("generates 22-char base64url keys", async () => {
    const a = await generateKey();
    const b = await generateKey();
    expect(isValidKey(a)).toBe(true);
    expect(a).not.toBe(b);
  });

  it("round-trips a payload with a fresh 12-byte iv each time", async () => {
    const key = await generateKey();
    const payload = { type: "HELLO", username: "Zoë 🎨", isHost: true };
    const one = await encrypt(key, payload);
    const two = await encrypt(await importKey(key), payload);
    expect(base64ToBytes(one.iv)).toHaveLength(12);
    expect(one.iv).not.toBe(two.iv);
    expect(one.data).not.toContain("HELLO");
    expect(await decrypt(key, one)).toEqual(payload);
    expect(await decrypt(key, two)).toEqual(payload);
  });

  it("handles payloads larger than the base64 chunk size", async () => {
    const key = await generateKey();
    const payload = { blob: "x".repeat(200_000) };
    expect(await decrypt(key, await encrypt(key, payload))).toEqual(payload);
  });

  it("rejects the wrong key and tampered ciphertext", async () => {
    const key = await generateKey();
    const blob = await encrypt(key, { a: 1 });
    await expect(decrypt(await generateKey(), blob)).rejects.toThrow();
    const bytes = base64ToBytes(blob.data);
    bytes[0] ^= 0xff;
    const tampered = { iv: blob.iv, data: btoa(String.fromCharCode(...bytes)) };
    await expect(decrypt(key, tampered)).rejects.toThrow();
  });

  it("refuses malformed keys", async () => {
    await expect(importKey("short")).rejects.toThrow(/22 base64url/);
  });
});

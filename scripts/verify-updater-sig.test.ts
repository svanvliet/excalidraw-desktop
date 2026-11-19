// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { configuredPubkey, verifyUpdaterSignature } from "./verify-updater-sig.mjs";

const tauri = join(__dirname, "..", "node_modules", ".bin", "tauri");

describe("verifyUpdaterSignature", () => {
  let dir: string;
  let pubkey: string;
  let data: Buffer;
  let signature: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "updater-sig-"));
    const env = { ...process.env, CI: "true", TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "throwaway" };
    delete env.TAURI_SIGNING_PRIVATE_KEY;
    execFileSync(tauri, ["signer", "generate", "--ci", "-p", "throwaway", "-w", join(dir, "k")], {
      env,
      stdio: "ignore",
    });
    writeFileSync(join(dir, "app.tar.gz"), "payload");
    execFileSync(
      tauri,
      ["signer", "sign", "-f", join(dir, "k"), "--app-version", "1.2.3", join(dir, "app.tar.gz")],
      { env, stdio: "ignore" },
    );
    pubkey = readFileSync(join(dir, "k.pub"), "utf8");
    data = readFileSync(join(dir, "app.tar.gz"));
    signature = readFileSync(join(dir, "app.tar.gz.sig"), "utf8");
  }, 60_000);

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("accepts a valid signature bound to the expected version", () => {
    const { trusted } = verifyUpdaterSignature({
      data,
      signature,
      pubkey,
      expectedVersion: "1.2.3",
    });
    expect(trusted).toContain("version:1.2.3");
  });

  it("rejects a different expected version", () => {
    expect(() =>
      verifyUpdaterSignature({ data, signature, pubkey, expectedVersion: "1.2.4" }),
    ).toThrow(/lacks version:1\.2\.4/);
  });

  it("rejects tampered data", () => {
    expect(() =>
      verifyUpdaterSignature({ data: Buffer.from("tampered"), signature, pubkey }),
    ).toThrow(/file signature is invalid/);
  });

  it("rejects a signature from a different key", () => {
    expect(() => verifyUpdaterSignature({ data, signature, pubkey: configuredPubkey() })).toThrow(
      /key ID does not match/,
    );
  });
});

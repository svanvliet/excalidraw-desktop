#!/usr/bin/env node
// Verifies a Tauri updater signature (minisign format) against the public key in src-tauri/tauri.conf.json.
// Usage: node scripts/verify-updater-sig.mjs <file> [<file>.sig] [expected-version]
// Checks the key ID, the file signature and the trusted comment's signature, and (if given) that the trusted
// comment carries version:<expected-version>, which requireSignedVersion needs.
// UPDATER_PUBKEY (the base64 pubkey string, as in tauri.conf.json) overrides the configured key (tests only).
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Tauri wraps the minisign text files in base64; line 2 of each is the base64 payload.
const minisignLines = (b64) => Buffer.from(b64.trim(), "base64").toString("utf8").split(/\r?\n/);

export function configuredPubkey() {
  const conf = JSON.parse(
    readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
  );
  return conf.plugins.updater.pubkey;
}

/** Throws with a reason if the signature is invalid; returns { keyId, trusted } otherwise. */
export function verifyUpdaterSignature({ data, signature, pubkey, expectedVersion }) {
  const pk = Buffer.from(minisignLines(pubkey)[1] ?? "", "base64");
  if (pk.length !== 42 || pk.subarray(0, 2).toString() !== "Ed")
    throw new Error("unexpected public key format");
  const keyId = pk.subarray(2, 10);
  const publicKey = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: pk.subarray(10).toString("base64url") },
    format: "jwk",
  });

  const lines = minisignLines(signature);
  const sig = Buffer.from(lines[1] ?? "", "base64");
  if (sig.length !== 74) throw new Error("unexpected signature format");
  const trusted = (lines[2] ?? "").replace(/^trusted comment: /, "");
  const globalSig = Buffer.from(lines[3] ?? "", "base64");
  const alg = sig.subarray(0, 2).toString();
  if (!sig.subarray(2, 10).equals(keyId))
    throw new Error("signature key ID does not match the public key");

  const signed = alg === "ED" ? createHash("blake2b512").update(data).digest() : data;
  if (!verify(null, signed, publicKey, sig.subarray(10)))
    throw new Error("file signature is invalid");
  if (
    !verify(null, Buffer.concat([sig.subarray(10), Buffer.from(trusted)]), publicKey, globalSig)
  ) {
    throw new Error("trusted comment signature is invalid");
  }
  if (expectedVersion && !trusted.split("\t").includes(`version:${expectedVersion}`)) {
    throw new Error(`trusted comment lacks version:${expectedVersion} (${trusted})`);
  }
  return { keyId: Buffer.from(keyId).reverse().toString("hex").toUpperCase(), trusted };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [file, sigFile = `${file}.sig`, expectedVersion] = process.argv.slice(2);
  if (!file) {
    console.error("usage: verify-updater-sig.mjs <file> [<file>.sig] [expected-version]");
    process.exit(2);
  }
  try {
    const { keyId, trusted } = verifyUpdaterSignature({
      data: readFileSync(file),
      signature: readFileSync(sigFile, "utf8"),
      pubkey: process.env.UPDATER_PUBKEY || configuredPubkey(),
      expectedVersion,
    });
    console.log(`OK: key ${keyId}, ${trusted}`);
  } catch (err) {
    console.error(`FAIL: ${err.message}`);
    process.exit(1);
  }
}

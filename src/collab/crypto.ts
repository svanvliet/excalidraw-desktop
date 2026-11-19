/**
 * End-to-end encryption for collab payloads (docs/collab-protocol.md §2, §4).
 *
 * AES-GCM-128 with a fresh 12-byte IV per message. The raw key travels only in
 * the share-link fragment as base64url (22 chars, no padding); `iv` and `data`
 * on the wire are standard base64.
 */

const ALGORITHM = "AES-GCM";
const KEY_BITS = 128;
const IV_BYTES = 12;

export interface EncryptedBlob {
  iv: string;
  data: string;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("WebCrypto (crypto.subtle) is unavailable in this context");
  return s;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Generates a new room key: AES-GCM-128 raw key as base64url (22 chars). */
export async function generateKey(): Promise<string> {
  const key = await subtle().generateKey({ name: ALGORITHM, length: KEY_BITS }, true, [
    "encrypt",
    "decrypt",
  ]);
  const jwk = await subtle().exportKey("jwk", key);
  if (!jwk.k) throw new Error("generateKey: exported JWK has no key material");
  return jwk.k;
}

export function isValidKey(key: string): boolean {
  return /^[A-Za-z0-9_-]{22}$/.test(key);
}

/** Imports a base64url room key for encrypt/decrypt. */
export async function importKey(key: string): Promise<CryptoKey> {
  if (!isValidKey(key)) throw new Error("importKey: key must be 22 base64url chars");
  return subtle().importKey(
    "jwk",
    { kty: "oct", k: key, alg: "A128GCM", ext: true, key_ops: ["encrypt", "decrypt"] },
    { name: ALGORITHM },
    false,
    ["encrypt", "decrypt"],
  );
}

async function resolveKey(key: CryptoKey | string): Promise<CryptoKey> {
  return typeof key === "string" ? importKey(key) : key;
}

/** Encrypts `utf8(JSON(payload))`. */
export async function encrypt(key: CryptoKey | string, payload: unknown): Promise<EncryptedBlob> {
  const cryptoKey = await resolveKey(key);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plaintext = textEncoder.encode(JSON.stringify(payload));
  const cipher = await subtle().encrypt({ name: ALGORITHM, iv }, cryptoKey, plaintext);
  return { iv: bytesToBase64(iv), data: bytesToBase64(new Uint8Array(cipher)) };
}

/** Decrypts a blob produced by {@link encrypt}. Throws on tampering / wrong key. */
export async function decrypt<T = unknown>(
  key: CryptoKey | string,
  blob: EncryptedBlob,
): Promise<T> {
  const cryptoKey = await resolveKey(key);
  const iv = base64ToBytes(blob.iv);
  if (iv.length !== IV_BYTES) throw new Error("decrypt: iv must be 12 bytes");
  const plain = await subtle().decrypt(
    { name: ALGORITHM, iv },
    cryptoKey,
    base64ToBytes(blob.data),
  );
  return JSON.parse(textDecoder.decode(plain)) as T;
}

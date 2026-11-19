#!/usr/bin/env node
// Creates or merges the Tauri updater manifest (latest.json) for one release.
//
// Usage:
//   node scripts/updater-manifest.mjs --version X.Y.Z --platform <key> [--platform <key> …] \
//     --sig <file.sig> --url <download-url> --out <latest.json> \
//     [--base <existing latest.json>] [--notes <text> | --notes-file <file>]
//
// --base is optional and may point at a missing file (treated as "no manifest yet"), so the macOS script and
// the Windows CI job can each merge their own platforms in whichever order they run. Merging refuses a base
// manifest for a different version and keeps every platform entry it doesn't replace. Explicit notes replace
// the base's notes; otherwise the base's notes (or a default) are kept. pub_date is kept from the base.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const PLATFORM_RE = /^(darwin|linux|windows)-(aarch64|x86_64|i686|armv7)$/;

export function defaultNotes(version) {
  return `Excalidraw Desktop ${version}`;
}

/**
 * Returns a new manifest with `platforms` set to `{ signature, url }`, merged over `base` (or created).
 * Throws on a version mismatch or malformed input.
 */
export function mergeManifest({
  base,
  version,
  platforms,
  signature,
  url,
  notes,
  now = new Date(),
}) {
  if (!version) throw new Error("version is required");
  if (!Array.isArray(platforms) || platforms.length === 0)
    throw new Error("at least one platform is required");
  for (const p of platforms) {
    if (!PLATFORM_RE.test(p)) throw new Error(`invalid platform key: ${p}`);
  }
  if (!signature || !signature.trim()) throw new Error("signature is empty");
  if (!/^https?:\/\//.test(url ?? "")) throw new Error(`url must be http(s): ${url}`);

  if (base != null) {
    if (typeof base !== "object" || Array.isArray(base))
      throw new Error("existing manifest is not an object");
    if (base.version !== version) {
      throw new Error(`existing manifest is for version ${base.version}, not ${version}`);
    }
    if (base.platforms != null && typeof base.platforms !== "object") {
      throw new Error("existing manifest has malformed platforms");
    }
  }

  const entry = { signature: signature.trim(), url };
  const merged = { ...(base?.platforms ?? {}) };
  for (const p of platforms) merged[p] = { ...entry };

  return {
    version,
    notes: notes ?? base?.notes ?? defaultNotes(version),
    pub_date: base?.pub_date ?? now.toISOString().replace(/\.\d+Z$/, "Z"),
    platforms: Object.fromEntries(Object.entries(merged).sort(([a], [b]) => a.localeCompare(b))),
  };
}

function parseArgs(argv) {
  const opts = { platforms: [] };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`missing value for ${flag}`);
    i++;
    switch (flag) {
      case "--version":
        opts.version = value.replace(/^v/, "");
        break;
      case "--platform":
        opts.platforms.push(value);
        break;
      case "--sig":
        opts.sig = value;
        break;
      case "--url":
        opts.url = value;
        break;
      case "--base":
        opts.base = value;
        break;
      case "--out":
        opts.out = value;
        break;
      case "--notes":
        opts.notes = value;
        break;
      case "--notes-file":
        opts.notesFile = value;
        break;
      default:
        throw new Error(`unknown flag: ${flag}`);
    }
  }
  for (const k of ["version", "sig", "url", "out"]) {
    if (!opts[k]) throw new Error(`--${k} is required`);
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const base =
    opts.base && existsSync(opts.base) ? JSON.parse(readFileSync(opts.base, "utf8")) : null;
  const notes = opts.notesFile ? readFileSync(opts.notesFile, "utf8").trim() : opts.notes;
  const manifest = mergeManifest({
    base,
    version: opts.version,
    platforms: opts.platforms,
    signature: readFileSync(opts.sig, "utf8"),
    url: opts.url,
    notes,
  });
  writeFileSync(opts.out, JSON.stringify(manifest, null, 2) + "\n");
  console.log(
    `${base ? "Merged" : "Created"} ${opts.out}: ${manifest.version} [${Object.keys(manifest.platforms).join(", ")}]`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (err) {
    console.error(`updater-manifest: ${err.message}`);
    process.exit(1);
  }
}

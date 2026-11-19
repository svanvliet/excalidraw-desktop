# macOS release runbook (signed + notarized)

> How to cut an Excalidraw Desktop release. The macOS DMG and the signed
> auto-update tarball are built, signed, notarized, and stapled **locally**
> on the release Mac by
> [`scripts/release-macos.sh`](../scripts/release-macos.sh) — Apple
> credentials and the updater key stay on that Mac. Windows installers are
> built (Authenticode-unsigned, updater-signed) by
> [`.github/workflows/release.yml`](../.github/workflows/release.yml) and
> attached to the same **draft** GitHub Release. Both sides merge their
> entries into the release's `latest.json` (see §7).
>
> All commands run from the repo root.

---

## 1. How it fits together

```
release Mac                                         GitHub
───────────                                         ──────
npm run release:mac -- X.Y.Z --bump --publish
  preflight (tree, versions, identity, notary,
             updater key + password, gh)
  tauri build --target universal-apple-darwin --bundles app
    └─ .app signed (Developer ID, hardened runtime, timestamp)
  notarize zip of .app → staple .app
  hdiutil DMG from stapled .app → codesign → notarize → staple
  tar.gz of stapled .app → tauri signer sign --app-version X.Y.Z
  latest.json (darwin-aarch64 + darwin-x86_64)
  gh release create vX.Y.Z --draft ───────────────▶ draft release
  upload DMG, .app.tar.gz(.sig), latest.json ─────▶ (merged, see §7)
  git push tag vX.Y.Z ────────────────────────────▶ release.yml (Windows)
                                                     build nsis+msi with
                                                     updater artifacts,
                                                     re-sign setup .exe,
                                                     upload, merge
                                                     windows-x86_64 into
                                                     latest.json
you: review the draft → Publish
```

The draft is created **before** the tag is pushed, so the Windows job
always finds it by tag name and never creates a duplicate. The DMG is
built by the script with `hdiutil` (not by Tauri) so that the `.app` inside
it is already stapled, and because Tauri's DMG step drives Finder via
AppleScript, which fails outside an interactive GUI session.

---

## 2. Prerequisites

| Need                                            | Check                                                                                             |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Active Apple Developer Program membership       | Account Holder has accepted the **latest** agreements (see §6, HTTP 403).                         |
| Developer ID Application cert in login keychain | `security find-identity -p codesigning -v \| grep "Developer ID Application"`                     |
| Xcode Command Line Tools (notarytool, stapler)  | `xcrun notarytool --version`                                                                      |
| Rust targets for a universal binary             | `rustup target add aarch64-apple-darwin x86_64-apple-darwin`                                      |
| Node + npm (deps installed or installable)      | The script runs `npm ci` if `node_modules` is missing.                                            |
| `gh` logged in as the publishing account        | `env -u GH_TOKEN gh auth token --user svanvliet >/dev/null && echo ok`                            |
| A `notarytool` keychain profile                 | `xcrun notarytool history --keychain-profile spicewood-notary`                                    |
| Updater private key (see §7)                    | `test -f ~/repos/certs/excalidraw-desktop-updater.key && echo ok`                                 |
| Updater key password in the login keychain      | `security find-generic-password -s excalidraw-desktop-updater-key-password >/dev/null && echo ok` |
| GitHub secrets for the Windows job (see §7)     | `gh secret list -R svanvliet/excalidraw-desktop \| grep TAURI_SIGNING`                            |

Defaults (override via environment variables):

| Variable                 | Default                                                           |
| ------------------------ | ----------------------------------------------------------------- |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: Scott Van Vliet (97379Y67S5)`          |
| `NOTARY_PROFILE`         | `spicewood-notary`                                                |
| `GH_RELEASE_USER`        | `svanvliet`                                                       |
| `GH_REPO`                | `svanvliet/excalidraw-desktop`                                    |
| `UPDATER_KEY`            | `~/repos/certs/excalidraw-desktop-updater.key`                    |
| `NOTES_FILE`             | unset → notes in `latest.json` are `Excalidraw Desktop <version>` |

---

## 3. One-time setup

**Developer ID certificate.** Xcode → Settings → Accounts → Manage
Certificates → `+` → _Developer ID Application_ (or create it at
developer.apple.com and double-click the `.cer`). It must show up in
`security find-identity -p codesigning -v`.

**Notary credentials.** Store them once in the keychain; `notarytool`
prompts for the app-specific password (create one at
https://appleid.apple.com → Sign-In and Security → App-Specific Passwords),
so it never appears in shell history:

```bash
xcrun notarytool store-credentials spicewood-notary \
  --apple-id "<apple-id-email>" --team-id 97379Y67S5
```

Any profile name works; point the script at it with `NOTARY_PROFILE=…`.
An App Store Connect API key (`--key`, `--key-id`, `--issuer`) is an
equally valid alternative.

**GitHub account.** The publishing account needs push access to the repo.
If your shell exports a different `GH_TOKEN`, the script bypasses it and
asks `gh` for the `svanvliet` token explicitly; make sure that account is
logged in: `env -u GH_TOKEN gh auth login`.

---

## 4. Cut a release

1. Merge everything for the release into `main` and check out a clean
   `main` (the script refuses a dirty tree and warns if `HEAD` isn't on
   origin).
2. Rehearse without publishing (builds, signs, notarizes, staples, verifies):

   ```bash
   npm run release:mac -- 0.2.0 --bump --dry-run
   ```

   `--bump` writes the version to `package.json`, `package-lock.json`,
   `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and `Cargo.lock`
   and commits `chore: release v0.2.0`. Without `--bump` the three
   manifests must already match the version argument.

3. Release for real (if you already bumped in step 2, drop `--bump`):

   ```bash
   NOTES_FILE=notes.md npm run release:mac -- 0.2.0 --publish
   ```

   This creates the annotated tag `v0.2.0`, creates the draft release,
   uploads `Excalidraw-Desktop_0.2.0_universal.dmg`,
   `Excalidraw-Desktop_0.2.0_universal.app.tar.gz` + `.sig` (+ `.sha256`
   files), merges/uploads `latest.json`, and pushes the tag, which starts
   the Windows CI job. `NOTES_FILE` (optional) is the text the in-app
   update prompt shows.

4. Push the version-bump commit to `main` (`git push origin main`).
5. When the Windows job finishes, open
   https://github.com/svanvliet/excalidraw-desktop/releases and review the
   draft: DMG, `.app.tar.gz` + `.sig`, `Excalidraw-Desktop_<v>_x64-setup.exe`
   - `.sig`, `.msi`, and a `latest.json` with **three** platforms:

   ```bash
   gh release download v0.2.0 -R svanvliet/excalidraw-desktop -p latest.json -O - \
     | node -e 'const m=JSON.parse(require("fs").readFileSync(0));console.log(m.version,Object.keys(m.platforms))'
   # 0.2.0 [ 'darwin-aarch64', 'darwin-x86_64', 'windows-x86_64' ]
   ```

   Then click **Publish**. Installed apps only see the release once it is
   published (see §7).

Everything is also kept locally in `src-tauri/target/release-artifacts/`.

### Flags

| Flag              | Effect                                                                    |
| ----------------- | ------------------------------------------------------------------------- |
| `--bump`          | Update all version manifests and commit before building.                  |
| `--dry-run`       | Build + sign + notarize + staple + verify. No tag, no release, no push.   |
| `--skip-notarize` | Signed build only (local smoke). Gatekeeper will reject it on other Macs. |
| `--publish`       | Create the draft, upload DMG + updater assets, push the tag.              |

All modes produce the DMG, the updater tarball + `.sig`, and `latest.json`
locally. Without `--publish` nothing leaves the machine except the
notarization upload to Apple.

### What the script verifies

- `.app`: `codesign --verify --deep --strict`, signed by the expected
  Developer ID, `flags=…(runtime)` (hardened runtime), secure `Timestamp=`.
- `.app`: notarized (as a zip) and stapled before it is packaged, so the
  copy inside the DMG and inside the updater tarball both carry the ticket
  (`stapler validate`, `spctl -t exec`).
- DMG: signed with `--timestamp`, notarized (`status: Accepted`), stapled
  (`stapler validate`), `spctl -a -vv -t install` reports
  `source=Notarized Developer ID`, and the app inside it validates.
- Updater tarball: signature checked against the `pubkey` in
  `src-tauri/tauri.conf.json`, with `version:<version>` in the trusted
  comment (`scripts/verify-updater-sig.mjs`).

Tauri signs the `.app` itself during `tauri build` because
`APPLE_SIGNING_IDENTITY` is set; `bundle.macOS.hardenedRuntime` is `true`
and `minimumSystemVersion` is `11.0` in `src-tauri/tauri.conf.json`. No
custom entitlements are needed: WKWebView runs JavaScript (and its JIT) in
Apple's own WebContent process, not in our binary.

---

## 5. Manual commands (for debugging)

```bash
APP="src-tauri/target/universal-apple-darwin/release/bundle/macos/Excalidraw Desktop.app"
DMG="src-tauri/target/release-artifacts/Excalidraw-Desktop_0.2.0_universal.dmg"

codesign -dv --verbose=4 "$APP"              # Authority, flags=0x10000(runtime), Timestamp
codesign --verify --deep --strict --verbose=2 "$APP"
xcrun notarytool submit "$DMG" --keychain-profile spicewood-notary --wait
xcrun notarytool log <submission-id> --keychain-profile spicewood-notary
xcrun stapler staple "$DMG" && xcrun stapler validate "$DMG"
spctl -a -vv -t install "$DMG"              # accepted, source=Notarized Developer ID
```

---

## 6. Troubleshooting

| Symptom                                                                                                      | Fix                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HTTP status code: 403. A required agreement is missing or has expired.` (preflight or `notarytool history`) | Apple published a new Program License Agreement. The **Account Holder** signs in at https://developer.apple.com/account and accepts it (also check App Store Connect → Business for pending agreements). Wait a few minutes, re-run. Use `--skip-notarize` meanwhile. |
| `notarytool profile '…' not found`                                                                           | Run `xcrun notarytool store-credentials` (§3) or set `NOTARY_PROFILE`.                                                                                                                                                                                                |
| `signing identity not found in keychain`                                                                     | Cert missing/expired or keychain locked: `security unlock-keychain login.keychain`; renew at developer.apple.com → Certificates.                                                                                                                                      |
| `errSecInternalComponent` from `codesign`                                                                    | Keychain locked (common over SSH): `security unlock-keychain login.keychain`.                                                                                                                                                                                         |
| Notarization `status: Invalid`                                                                               | The script prints `notarytool log`; read the `issues` array. Usual causes: unsigned nested binary, missing hardened runtime, or missing timestamp.                                                                                                                    |
| `tag vX.Y.Z already exists on origin`                                                                        | Versions are immutable once tagged; pick the next version with `--bump`.                                                                                                                                                                                              |
| `gh has no token for 'svanvliet'` / `no push access`                                                         | `env -u GH_TOKEN gh auth login` as the publishing account (or set `GH_RELEASE_USER`).                                                                                                                                                                                 |
| Two releases for the same tag                                                                                | Shouldn't happen (draft is created before the tag push). Delete the empty one; re-run the Windows job with **Run workflow** → tag.                                                                                                                                    |
| `updater private key not found` / `keychain item … not found`                                                | See §7 one-time setup, or set `UPDATER_KEY`.                                                                                                                                                                                                                          |
| `refusing to build a release with EXCALIDRAW_UPDATE_ENDPOINT …`                                              | A test-only override is in your shell. `unset EXCALIDRAW_UPDATE_ENDPOINT EXTRA_CONFIG DOWNLOAD_BASE` (or `ALLOW_TEST_BUILD=1` for a local test build, §8).                                                                                                            |
| `latest.json` on the draft lacks `windows-x86_64`                                                            | The Windows job hasn't finished or failed; re-run it (below). It merges into the existing manifest.                                                                                                                                                                   |
| Rust target missing                                                                                          | `rustup target add aarch64-apple-darwin x86_64-apple-darwin`.                                                                                                                                                                                                         |

If the Windows job fails, fix and re-run it from the Actions tab
(**release → Run workflow**, input the existing tag); it reattaches to the
same draft.

---

## 7. Auto-update (updater key, `latest.json`)

Installed apps poll
`https://github.com/svanvliet/excalidraw-desktop/releases/latest/download/latest.json`
(`plugins.updater` in `src-tauri/tauri.conf.json`). Updates are verified
against the minisign `pubkey` in that file, and `requireSignedVersion`
means the signature's trusted comment must say `version:<version>` — the
scripts always sign with `tauri signer sign --app-version`.

**0.1.0 shipped without an updater**, so its users must install 0.1.1 by
hand. The first real auto-update is **0.1.1 → 0.1.2**.

### The key

| What                | Where                                                                          |
| ------------------- | ------------------------------------------------------------------------------ |
| Private key         | `~/repos/certs/excalidraw-desktop-updater.key` (outside every repo)            |
| Key password        | login Keychain, generic password `excalidraw-desktop-updater-key-password`     |
| Public key          | `plugins.updater.pubkey` in `src-tauri/tauri.conf.json` (committed)            |
| CI copies (Windows) | repo secrets `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` |

> **Back the key and password up** (e.g. a password manager / offline
> storage). If the key is lost, every installed copy can **never** be
> updated again — new releases can't be signed with a key they trust, and
> users would have to reinstall by hand. Never commit it, paste it into an
> issue, or print it in logs.

**One-time: add the GitHub secrets** (neither value is echoed or put on a
command line):

```bash
gh secret set TAURI_SIGNING_PRIVATE_KEY -R svanvliet/excalidraw-desktop \
  < ~/repos/certs/excalidraw-desktop-updater.key
security find-generic-password -s excalidraw-desktop-updater-key-password -w \
  | gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD -R svanvliet/excalidraw-desktop
```

The Windows job fails in its preflight step if either secret is missing.

### How `latest.json` is assembled

- `scripts/updater-manifest.mjs` creates or merges a manifest: it refuses
  a base manifest for a different version, keeps every other platform's
  entry, and only sets `notes` when told to (macOS owns the notes; the
  Windows job keeps them).
- `scripts/publish-updater-manifest.sh` is the shared, race-safe upload
  used by both sides: download the draft's `latest.json` (if any) → merge
  → check that nobody replaced the asset meanwhile → `gh release upload
--clobber` → re-download and confirm our signatures survived; retry on
  conflict.
- **macOS** (`release-macos.sh --publish`) adds `darwin-aarch64` and
  `darwin-x86_64`, both pointing at the universal
  `Excalidraw-Desktop_<v>_universal.app.tar.gz`, then pushes the tag.
- **Windows** (`release.yml`) builds with
  `--config '{"bundle":{"createUpdaterArtifacts":true}}'`, re-signs
  `Excalidraw-Desktop_<v>_x64-setup.exe` with `--app-version`, verifies
  it, uploads it, waits (up to ~5 min) for the macOS `latest.json`, and
  merges `windows-x86_64`. If it runs first (tag pushed by hand), it writes
  a Windows-only manifest that the macOS script later merges into.
- URLs point at `releases/download/v<version>/<asset>`; asset names are
  hyphenated, so GitHub doesn't rename them (it turns spaces into dots).

**Drafts update nobody.** `releases/latest/download/…` only resolves to
the newest **published** release, so you can inspect, re-run, or delete a
draft freely. Publishing is what ships the update.

---

## 8. Testing an update locally

Build two versions that point at a local server instead of GitHub. The
test-only knobs are refused unless `ALLOW_TEST_BUILD=1`, which in turn
refuses `--publish` and `--bump`. A separate identifier keeps the test app
away from your real app's data. The script needs a clean tree; the version
override in `EXTRA_CONFIG` replaces the manifest version check.

```bash
# 1. Common settings (http needs dangerousInsecureTransportProtocol)
export ALLOW_TEST_BUILD=1
export EXCALIDRAW_UPDATE_ENDPOINT=http://127.0.0.1:8765/latest.json
export DOWNLOAD_BASE=http://127.0.0.1:8765
cfg() { printf '{"version":"%s","identifier":"com.svanvliet.excalidrawdesktop.updatetest","plugins":{"updater":{"dangerousInsecureTransportProtocol":true}}}' "$1"; }

# 2. Old version: build it and copy the app somewhere writable
EXTRA_CONFIG="$(cfg 0.1.90)" npm run release:mac -- 0.1.90 --skip-notarize
mkdir -p /tmp/updatetest && rm -rf "/tmp/updatetest/Excalidraw Desktop.app"
ditto "src-tauri/target/universal-apple-darwin/release/bundle/macos/Excalidraw Desktop.app" \
  "/tmp/updatetest/Excalidraw Desktop.app"

# 3. New version: its tarball, .sig, and latest.json land in release-artifacts
EXTRA_CONFIG="$(cfg 0.1.91)" npm run release:mac -- 0.1.91 --skip-notarize

# 4. Serve the new version
(cd src-tauri/target/release-artifacts && python3 -m http.server 8765 --bind 127.0.0.1)

# 5. In another terminal, run the OLD app with a throwaway profile
"/tmp/updatetest/Excalidraw Desktop.app/Contents/MacOS/excalidraw-desktop" --profile updatetest
```

The old app should offer 0.1.91, download it from the local server,
verify the signature, replace `/tmp/updatetest/Excalidraw Desktop.app`,
and relaunch as 0.1.91. Delete `/tmp/updatetest` and
`unset ALLOW_TEST_BUILD EXCALIDRAW_UPDATE_ENDPOINT DOWNLOAD_BASE` afterwards
(the release script refuses to run with the overrides set).

---

## References

- Tauri 2 macOS signing: https://v2.tauri.app/distribute/sign/macos/
- Tauri 2 updater: https://v2.tauri.app/plugin/updater/
- Notarizing macOS software: https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution
- `codesign(1)`, `notarytool(1)`, `stapler(1)`, `spctl(8)`.

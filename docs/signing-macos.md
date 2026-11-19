# macOS release runbook (signed + notarized)

> How to cut an Excalidraw Desktop release. The macOS DMG is built,
> signed, notarized, and stapled **locally** on the release Mac by
> [`scripts/release-macos.sh`](../scripts/release-macos.sh) — Apple
> credentials stay in the login keychain and never go to GitHub. Windows
> installers are built (unsigned) by
> [`.github/workflows/release.yml`](../.github/workflows/release.yml) and
> attached to the same **draft** GitHub Release.
>
> All commands run from the repo root.

---

## 1. How it fits together

```
release Mac                                         GitHub
───────────                                         ──────
npm run release:mac -- X.Y.Z --bump --publish
  preflight (tree, versions, identity, notary, gh)
  tauri build --target universal-apple-darwin
    └─ .app signed (Developer ID, hardened runtime, timestamp)
  codesign DMG → notarytool submit --wait → stapler staple
  spctl / codesign verify
  gh release create vX.Y.Z --draft ───────────────▶ draft release + DMG
  git push tag vX.Y.Z ────────────────────────────▶ release.yml (Windows)
                                                     tauri-action finds the
                                                     draft by tag, attaches
                                                     .msi / -setup.exe
you: review the draft → Publish
```

The draft is created **before** the tag is pushed, so the Windows job
always finds it (tauri-action with `releaseDraft: true` looks up drafts by
tag name) and never creates a duplicate.

---

## 2. Prerequisites

| Need                                            | Check                                                                         |
| ----------------------------------------------- | ----------------------------------------------------------------------------- |
| Active Apple Developer Program membership       | Account Holder has accepted the **latest** agreements (see §6, HTTP 403).     |
| Developer ID Application cert in login keychain | `security find-identity -p codesigning -v \| grep "Developer ID Application"` |
| Xcode Command Line Tools (notarytool, stapler)  | `xcrun notarytool --version`                                                  |
| Rust targets for a universal binary             | `rustup target add aarch64-apple-darwin x86_64-apple-darwin`                  |
| Node + npm (deps installed or installable)      | The script runs `npm ci` if `node_modules` is missing.                        |
| `gh` logged in as the publishing account        | `env -u GH_TOKEN gh auth token --user svanvliet >/dev/null && echo ok`        |
| A `notarytool` keychain profile                 | `xcrun notarytool history --keychain-profile spicewood-notary`                |

Defaults (override via environment variables):

| Variable                 | Default                                                  |
| ------------------------ | -------------------------------------------------------- |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: Scott Van Vliet (97379Y67S5)` |
| `NOTARY_PROFILE`         | `spicewood-notary`                                       |
| `GH_RELEASE_USER`        | `svanvliet`                                              |
| `GH_REPO`                | `svanvliet/excalidraw-desktop`                           |

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
   npm run release:mac -- 0.2.0 --publish
   ```

   This creates the annotated tag `v0.2.0`, creates the draft release,
   uploads `Excalidraw-Desktop_0.2.0_universal.dmg` (+ `.sha256`), and
   pushes the tag, which starts the Windows CI job.

4. Push the version-bump commit to `main` (`git push origin main`).
5. When the Windows job finishes, open
   https://github.com/svanvliet/excalidraw-desktop/releases, review the
   draft (DMG, `.msi`, `-setup.exe`, notes) and click **Publish**.

The DMG is also kept locally at
`src-tauri/target/release-artifacts/Excalidraw-Desktop_<version>_universal.dmg`.

### Flags

| Flag              | Effect                                                                       |
| ----------------- | ---------------------------------------------------------------------------- |
| `--bump`          | Update all version manifests and commit before building.                     |
| `--dry-run`       | Build + sign + notarize + staple + verify. No tag, no release, no push.      |
| `--skip-notarize` | Signed build only (local smoke). Gatekeeper will reject it on other Macs.    |
| `--publish`       | Create the draft release, upload the DMG, push the tag. Required to publish. |

Without `--publish` nothing leaves the machine except the notarization
upload to Apple.

### What the script verifies

- `.app`: `codesign --verify --deep --strict`, signed by the expected
  Developer ID, `flags=…(runtime)` (hardened runtime), secure `Timestamp=`.
- DMG: signed with `--timestamp`, notarized (`status: Accepted`), stapled
  (`stapler validate`), and `spctl -a -vv -t install` reports
  `source=Notarized Developer ID`.

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
| Rust target missing                                                                                          | `rustup target add aarch64-apple-darwin x86_64-apple-darwin`.                                                                                                                                                                                                         |

If the Windows job fails, fix and re-run it from the Actions tab
(**release → Run workflow**, input the existing tag); it reattaches to the
same draft.

---

## References

- Tauri 2 macOS signing: https://v2.tauri.app/distribute/sign/macos/
- Notarizing macOS software: https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution
- `codesign(1)`, `notarytool(1)`, `stapler(1)`, `spctl(8)`.

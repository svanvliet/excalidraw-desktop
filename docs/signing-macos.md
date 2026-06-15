# macOS code signing & notarization

> Copy-pasteable runbook for producing a distributable, double-clickable
> `.app` (and the `.dmg` Tauri bundles around it) that opens on a fresh
> macOS install without a Gatekeeper warning.
>
> All commands assume the project root as the working directory. Replace
> `<placeholders>` with your own values.

---

## 1. Prerequisites

| You need                                             | How to get it                                                                                                              |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| An active Apple Developer Program membership ($99/y) | https://developer.apple.com/programs/                                                                                      |
| A **Developer ID Application** certificate           | Xcode → Settings → Accounts → Manage Certificates → `+` → Developer ID Application. Stored in the login keychain.          |
| Xcode Command Line Tools                             | `xcode-select --install`                                                                                                   |
| Tauri build prerequisites                            | `rustup target add x86_64-apple-darwin aarch64-apple-darwin` (for a universal binary)                                      |
| `notarytool` (ships with Xcode 13+)                  | `xcrun notarytool --version` to verify.                                                                                    |
| An app-specific password OR an API key for Apple ID  | https://appleid.apple.com → Sign-In and Security → App-Specific Passwords. Or App Store Connect → Users and Access → Keys. |

Confirm your Developer ID is loaded:

```bash
security find-identity -p basic -v | grep "Developer ID Application"
# Expect: 1 valid identities found
```

Note the **Team ID** (10-character string) and the **common-name** of the cert; you'll need both.

---

## 2. Build the unsigned bundle

```bash
npm install
npm run tauri build -- --target universal-apple-darwin
```

The build drops:

- `src-tauri/target/universal-apple-darwin/release/bundle/macos/Excalidraw Desktop.app`
- `src-tauri/target/universal-apple-darwin/release/bundle/dmg/Excalidraw Desktop_0.1.0_universal.dmg`

---

## 3. Sign the `.app`

Tauri can sign automatically — wire it into `src-tauri/tauri.conf.json`:

```jsonc
{
  "bundle": {
    "macOS": {
      "signingIdentity": "Developer ID Application: <Your Name> (<TEAMID>)",
      "providerShortName": "<TEAMID>",
      "entitlements": "src-tauri/entitlements.plist",
      "hardenedRuntime": true,
    },
  },
}
```

Create the entitlements file with the minimum needed for a webview-based
desktop app:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>com.apple.security.cs.allow-jit</key>
    <true/>
    <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
    <true/>
    <key>com.apple.security.cs.disable-library-validation</key>
    <true/>
    <!-- Required for tauri-plugin-store, plugin-dialog to read/write files -->
    <key>com.apple.security.files.user-selected.read-write</key>
    <true/>
  </dict>
</plist>
```

Rebuild after editing tauri.conf.json:

```bash
npm run tauri build -- --target universal-apple-darwin
```

Or sign manually after the fact:

```bash
codesign --deep --force --options runtime \
  --entitlements src-tauri/entitlements.plist \
  --sign "Developer ID Application: <Your Name> (<TEAMID>)" \
  "src-tauri/target/universal-apple-darwin/release/bundle/macos/Excalidraw Desktop.app"
```

Verify the signature:

```bash
codesign --verify --deep --strict --verbose=2 \
  "src-tauri/target/universal-apple-darwin/release/bundle/macos/Excalidraw Desktop.app"
spctl --assess --type execute --verbose \
  "src-tauri/target/universal-apple-darwin/release/bundle/macos/Excalidraw Desktop.app"
```

`spctl` should print `accepted source=Notarized Developer ID` once
notarization (next step) completes; before notarization it'll say
`rejected source=no usable signature`.

---

## 4. Notarize with Apple

Apple notarization scans the binary on Apple's servers and returns a
"this is safe" ticket that Gatekeeper checks on first launch.

**One-time:** store credentials in the keychain (so they're never typed
on the command line):

```bash
xcrun notarytool store-credentials \
  --apple-id "<your.apple.id@example.com>" \
  --team-id "<TEAMID>" \
  --password "<app-specific-password>" \
  excalidraw-notary
```

Submit the DMG (notarytool prefers a zipped or DMG'd bundle):

```bash
xcrun notarytool submit \
  "src-tauri/target/universal-apple-darwin/release/bundle/dmg/Excalidraw Desktop_0.1.0_universal.dmg" \
  --keychain-profile excalidraw-notary \
  --wait
```

`--wait` blocks until Apple finishes (~1–5 minutes). On success you'll
see `status: Accepted`. On failure, fetch the log:

```bash
xcrun notarytool log <submission-id> --keychain-profile excalidraw-notary
```

Staple the ticket onto the DMG (and into the .app):

```bash
xcrun stapler staple \
  "src-tauri/target/universal-apple-darwin/release/bundle/dmg/Excalidraw Desktop_0.1.0_universal.dmg"
xcrun stapler staple \
  "src-tauri/target/universal-apple-darwin/release/bundle/macos/Excalidraw Desktop.app"
```

Re-verify:

```bash
spctl --assess --type execute --verbose \
  "src-tauri/target/universal-apple-darwin/release/bundle/macos/Excalidraw Desktop.app"
# accepted
# source=Notarized Developer ID
```

---

## 5. Distribute

Hand out the stapled `.dmg`. First-launch Gatekeeper sees the staple
and lets the user open the app without the "downloaded from the
internet" prompt.

---

## Troubleshooting

| Symptom                                                     | Likely cause / fix                                                                                                    |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `errSecInternalComponent` from `codesign`                   | Run `security unlock-keychain login.keychain` first; CI keychains often forget.                                       |
| `The executable does not have the hardened runtime enabled` | Add `--options runtime` to `codesign`, or `hardenedRuntime: true` in tauri.conf.json.                                 |
| `Invalid Developer ID Application certificate`              | Expired cert. Renew via developer.apple.com → Certificates.                                                           |
| `notarytool` says `Invalid`                                 | Use `notarytool log <id>` and look at the `issues` array. Most often: signed without hardened runtime + entitlements. |
| Universal build fails to find one of the arch targets       | `rustup target add x86_64-apple-darwin aarch64-apple-darwin`.                                                         |

---

## References

- Tauri 2 macOS signing: https://v2.tauri.app/distribute/sign/macos/
- Apple notarization: https://developer.apple.com/documentation/security/notarizing_macos_software_before_distribution
- `codesign(1)`, `notarytool(1)`, `stapler(1)` man pages.

# Windows code signing

> Runbook for producing a signed `.exe` / `.msi` that opens on a fresh
> Windows install without a SmartScreen "Unknown publisher" warning.
>
> All commands assume the project root as the working directory and a
> PowerShell prompt unless noted. Replace `<placeholders>` with your
> own values.

---

## 1. Pick a certificate type

| Type                                  | What you get                                                                                           | When to choose it                                                                |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| **Standard ("OV") code-signing cert** | Cheaper (~$100–300/y) but SmartScreen reputation must be earned over time + downloads.                 | Hobby / low-budget. Users will see SmartScreen the first ~hundreds of downloads. |
| **EV code-signing cert**              | Hardware-bound, instant SmartScreen reputation, costs ~$300–500/y.                                     | Distributing to enterprise or public users who shouldn't see SmartScreen.        |
| **Azure Trusted Signing**             | Microsoft-hosted EV-equivalent, $9.99/month, no hardware token. Newer service; Azure account required. | The lowest-friction option in 2025+. Recommended for new projects.               |
| **Self-signed**                       | No cost, no trust. SmartScreen blocks every install.                                                   | Internal-only testing.                                                           |

The instructions below default to **Azure Trusted Signing** because it's
the modern path; the `signtool` invocation is the same shape for any of
the cert sources.

---

## 2. Prerequisites

| You need                                                                                                                                                                 | How to get it                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows SDK with `signtool.exe`                                                                                                                                          | Install [Windows 10/11 SDK](https://developer.microsoft.com/en-us/windows/downloads/windows-sdk/). signtool is under `C:\Program Files (x86)\Windows Kits\10\bin\…\x64\signtool.exe`. |
| The Tauri build prerequisites                                                                                                                                            | Visual Studio Build Tools 2022 with the "Desktop development with C++" workload. https://v2.tauri.app/start/prerequisites/                                                            |
| **Azure Trusted Signing only**: an Azure subscription, the Trusted Signing resource provisioned, and a certificate profile.                                              | https://learn.microsoft.com/en-us/azure/trusted-signing/quickstart                                                                                                                    |
| **Standard / EV cert**: the `.pfx` file (and password) or the token-attached cert in the **My** certificate store. Plug in the hardware token before running `signtool`. | From your cert vendor.                                                                                                                                                                |

Confirm signtool is on PATH:

```powershell
where.exe signtool
signtool /?
```

---

## 3. Build the unsigned bundle

```powershell
npm install
npm run tauri build
```

Output drops (paths vary slightly with version):

- `src-tauri\target\release\Excalidraw Desktop.exe`
- `src-tauri\target\release\bundle\msi\Excalidraw Desktop_0.1.0_x64_en-US.msi`
- `src-tauri\target\release\bundle\nsis\Excalidraw Desktop_0.1.0_x64-setup.exe`

---

## 4. Sign the binaries

### Option A — Azure Trusted Signing (recommended)

Install the Trusted Signing tooling:

```powershell
dotnet tool install --global Azure.CodeSigning.Tools
```

Sign every artifact:

```powershell
$exe = "src-tauri\target\release\Excalidraw Desktop.exe"
$msi = "src-tauri\target\release\bundle\msi\Excalidraw Desktop_0.1.0_x64_en-US.msi"
$nsis = "src-tauri\target\release\bundle\nsis\Excalidraw Desktop_0.1.0_x64-setup.exe"

foreach ($f in @($exe, $msi, $nsis)) {
  azuresigntool sign `
    -kvu "https://<your-trusted-signing-account>.codesigning.azure.net" `
    -kvc "<your-cert-profile-name>" `
    -kvm `
    -tr "http://timestamp.acs.microsoft.com" `
    -td sha256 `
    -fd sha256 `
    -v `
    $f
}
```

`-kvm` uses your Azure login (Managed Identity / interactive); for CI
swap to `-kvi`/`-kvs` with a Service Principal client id + secret.

### Option B — Local `.pfx` or hardware-token cert with `signtool.exe`

```powershell
$exe = "src-tauri\target\release\Excalidraw Desktop.exe"
$msi = "src-tauri\target\release\bundle\msi\Excalidraw Desktop_0.1.0_x64_en-US.msi"
$nsis = "src-tauri\target\release\bundle\nsis\Excalidraw Desktop_0.1.0_x64-setup.exe"

foreach ($f in @($exe, $msi, $nsis)) {
  signtool sign `
    /f "C:\path\to\cert.pfx" `
    /p "<pfx-password>" `
    /tr "http://timestamp.digicert.com" `
    /td sha256 `
    /fd sha256 `
    /v `
    $f
}
```

If you're using a hardware token (most EV certs), drop the `/f`+`/p`
flags and pass `/n "<Common Name on the cert>"` so signtool finds it in
the user's certificate store, with the token plugged in.

### Option C — Wire signing into the Tauri build

Tauri can run signtool itself if you put the cert in `tauri.conf.json`:

```jsonc
{
  "bundle": {
    "windows": {
      "certificateThumbprint": "<sha1-thumbprint-of-cert>",
      "digestAlgorithm": "sha256",
      "timestampUrl": "http://timestamp.digicert.com",
    },
  },
}
```

Find the thumbprint with `Get-ChildItem Cert:\CurrentUser\My`. After
this, `npm run tauri build` produces signed artifacts directly.

---

## 5. Verify

```powershell
signtool verify /pa /v "src-tauri\target\release\Excalidraw Desktop.exe"
# Successfully verified: ...
# SignTool Successfully verified the file.
```

Right-click → Properties → Digital Signatures should show the publisher
and a valid timestamp.

---

## 6. (Optional) Submit for SmartScreen reputation

For standard OV certs, you can prime the SmartScreen reputation by
submitting the binary at:

https://www.microsoft.com/en-us/wdsi/filesubmission/

EV certs and Azure Trusted Signing get implicit reputation, so this step
is unnecessary.

---

## 7. Distribute

Hand out the signed `.msi` or `.exe` (NSIS installer). SmartScreen
should let it install silently for EV / Trusted Signing certs. For a
standard cert, expect the first hundreds of downloads to show "Unknown
publisher" until reputation builds.

---

## Troubleshooting

| Symptom                                                                       | Likely cause / fix                                                                                                                                                 |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SignTool Error: No certificates were found that met all the given criteria.` | The cert is not in the store the command is looking at. Add `/s My`, or check `Get-ChildItem Cert:\CurrentUser\My`. With a hardware token, ensure it's plugged in. |
| `SignTool Error: The timestamp server failed to sign the file.`               | Some timestamp servers throttle; retry, or swap for `http://timestamp.sectigo.com` / `http://ts.ssl.com`.                                                          |
| Signed binary still triggers SmartScreen "Unknown publisher"                  | Standard (OV) cert without enough reputation. Wait + downloads, switch to EV, or use Azure Trusted Signing.                                                        |
| `azuresigntool` cannot authenticate                                           | `az login` first, or pass `-kvi` / `-kvs` with a Service Principal.                                                                                                |

---

## References

- Tauri 2 Windows signing: https://v2.tauri.app/distribute/sign/windows/
- Azure Trusted Signing: https://learn.microsoft.com/en-us/azure/trusted-signing/
- `signtool.exe` reference: https://learn.microsoft.com/en-us/windows/win32/seccrypto/signtool

#!/usr/bin/env bash
# Build, sign, notarize, and staple the universal macOS DMG locally, then
# upload it to a DRAFT GitHub Release. Windows is built in CI
# (.github/workflows/release.yml) and attaches to the same draft.
#
# Usage:
#   scripts/release-macos.sh <version> [--bump] [--dry-run] [--skip-notarize] [--publish]
#
#   <version>        Semver without the leading "v" (e.g. 0.2.0).
#   --bump           Write <version> into package.json, package-lock.json,
#                    src-tauri/tauri.conf.json, src-tauri/Cargo.toml (+ Cargo.lock)
#                    and commit the change before building.
#   --dry-run        Build + sign + notarize + staple + verify; no tag, no upload.
#   --skip-notarize  Skip notarization/stapling (local smoke only; never uploads).
#   --publish        Create the draft release, upload the DMG, and push the
#                    annotated tag v<version>. Without it nothing is published.
#
# Environment overrides:
#   APPLE_SIGNING_IDENTITY  default "Developer ID Application: Scott Van Vliet (97379Y67S5)"
#   NOTARY_PROFILE          default "spicewood-notary" (xcrun notarytool keychain profile)
#   GH_RELEASE_USER         default "svanvliet" (gh account that publishes)
#   GH_REPO                 default "svanvliet/excalidraw-desktop"
#
# See docs/signing-macos.md for the full runbook.

set -euo pipefail

APPLE_SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:-Developer ID Application: Scott Van Vliet (97379Y67S5)}"
NOTARY_PROFILE="${NOTARY_PROFILE:-spicewood-notary}"
GH_RELEASE_USER="${GH_RELEASE_USER:-svanvliet}"
GH_REPO="${GH_REPO:-svanvliet/excalidraw-desktop}"
TARGET="universal-apple-darwin"
PRODUCT_NAME="Excalidraw Desktop"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die() {
  printf '\033[1;31merror:\033[0m %s\n' "$*" >&2
  exit 1
}

usage() {
  sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

VERSION=""
BUMP=0
DRY_RUN=0
SKIP_NOTARIZE=0
PUBLISH=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bump) BUMP=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --skip-notarize) SKIP_NOTARIZE=1 ;;
    --publish) PUBLISH=1 ;;
    -h | --help) usage 0 ;;
    -*) die "unknown flag: $1 (see --help)" ;;
    *)
      [[ -z "$VERSION" ]] || die "unexpected argument: $1"
      VERSION="${1#v}"
      ;;
  esac
  shift
done

[[ -n "$VERSION" ]] || usage 1
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || die "version must be semver (got '$VERSION')"

if [[ $PUBLISH -eq 1 && ($DRY_RUN -eq 1 || $SKIP_NOTARIZE -eq 1) ]]; then
  die "--publish cannot be combined with --dry-run or --skip-notarize"
fi

TAG="v$VERSION"
BUNDLE_DIR="$REPO_ROOT/src-tauri/target/$TARGET/release/bundle"
APP_PATH="$BUNDLE_DIR/macos/$PRODUCT_NAME.app"
OUT_DIR="$REPO_ROOT/src-tauri/target/release-artifacts"
DMG="$OUT_DIR/Excalidraw-Desktop_${VERSION}_universal.dmg"

pkg_version() { node -p "require('./package.json').version"; }
conf_version() { node -p "require('./src-tauri/tauri.conf.json').version"; }
cargo_version() { sed -n 's/^version = "\(.*\)"$/\1/p' src-tauri/Cargo.toml | head -n1; }

release_token() {
  env -u GH_TOKEN gh auth token --user "$GH_RELEASE_USER" 2>/dev/null ||
    die "gh has no token for '$GH_RELEASE_USER'. Run: env -u GH_TOKEN gh auth login (as $GH_RELEASE_USER)"
}

# Run gh as the release account without ever echoing the token.
gh_release() { GH_TOKEN="$(release_token)" gh "$@"; }

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

log "Preflight"

[[ "$(uname -s)" == "Darwin" ]] || die "this script must run on macOS"
for tool in node npm git gh xcrun codesign spctl security rustup shasum; do
  command -v "$tool" >/dev/null || die "missing required tool: $tool"
done

[[ -z "$(git status --porcelain)" ]] || die "working tree is not clean; commit or stash first"

if [[ $BUMP -eq 1 ]]; then
  log "Bumping version to $VERSION"
  npm version "$VERSION" --no-git-tag-version --allow-same-version >/dev/null
  node -e '
    const fs = require("fs");
    const p = "src-tauri/tauri.conf.json";
    const c = JSON.parse(fs.readFileSync(p, "utf8"));
    c.version = process.argv[1];
    fs.writeFileSync(p, JSON.stringify(c, null, 2) + "\n");
  ' "$VERSION"
  # Rewrite only the first top-level `version = "…"` line ([package]).
  sed -i '' -e "1,/^version = \".*\"\$/s/^version = \".*\"\$/version = \"$VERSION\"/" src-tauri/Cargo.toml
  if command -v cargo >/dev/null; then
    cargo update --manifest-path src-tauri/Cargo.toml --workspace --offline >/dev/null 2>&1 ||
      cargo update --manifest-path src-tauri/Cargo.toml --workspace >/dev/null
  fi
  if [[ -x node_modules/.bin/prettier ]]; then
    node_modules/.bin/prettier --write package.json src-tauri/tauri.conf.json >/dev/null
  fi
  git add -u
  git commit -q -m "chore: release $TAG"
  log "Committed version bump ($(git rev-parse --short HEAD))"
fi

[[ "$(pkg_version)" == "$VERSION" ]] || die "package.json version is $(pkg_version), expected $VERSION (use --bump)"
[[ "$(conf_version)" == "$VERSION" ]] || die "tauri.conf.json version is $(conf_version), expected $VERSION (use --bump)"
[[ "$(cargo_version)" == "$VERSION" ]] || die "Cargo.toml version is $(cargo_version), expected $VERSION (use --bump)"

HEAD_SHA="$(git rev-parse HEAD)"
git fetch -q origin 2>/dev/null || warn "could not fetch origin"
if [[ -z "$(git branch -r --contains "$HEAD_SHA" 2>/dev/null)" ]]; then
  warn "HEAD ${HEAD_SHA:0:12} is not on any origin branch. Push the branch (e.g. merge to main) before publishing."
fi

remote_tag_sha="$(git ls-remote origin "refs/tags/$TAG^{}" | cut -f1)"
[[ -n "$remote_tag_sha" ]] || remote_tag_sha="$(git ls-remote origin "refs/tags/$TAG" | cut -f1)"
if [[ -n "$remote_tag_sha" && "$remote_tag_sha" != "$HEAD_SHA" ]]; then
  msg="tag $TAG already exists on origin at ${remote_tag_sha:0:12} (HEAD is ${HEAD_SHA:0:12}). Pick a new version with --bump."
  if [[ $PUBLISH -eq 1 ]]; then die "$msg"; else warn "$msg"; fi
fi

security find-identity -p codesigning -v | grep -Fq "\"$APPLE_SIGNING_IDENTITY\"" ||
  die "signing identity not found in keychain: $APPLE_SIGNING_IDENTITY"
log "Signing identity: $APPLE_SIGNING_IDENTITY"

installed_targets="$(rustup target list --installed)"
for t in aarch64-apple-darwin x86_64-apple-darwin; do
  grep -qx "$t" <<<"$installed_targets" || die "rust target missing: rustup target add $t"
done

if [[ $SKIP_NOTARIZE -eq 0 ]]; then
  log "Checking notarytool profile '$NOTARY_PROFILE'"
  if ! notary_out="$(xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" 2>&1)"; then
    if grep -q "required agreement is missing or has expired" <<<"$notary_out"; then
      die "Apple notary service returned HTTP 403: a required agreement is missing or has expired.
  Fix: the Apple Developer Account Holder must sign in at https://developer.apple.com/account
  and accept the updated Apple Developer Program License Agreement (and any pending
  agreements under https://appstoreconnect.apple.com → Business). It can take a few
  minutes to propagate. Then re-run this script.
  Meanwhile, use --skip-notarize for a signed local smoke build."
    fi
    if grep -qi "no keychain password item found\|could not find" <<<"$notary_out"; then
      die "notarytool profile '$NOTARY_PROFILE' not found in the keychain. Create it once with:
  xcrun notarytool store-credentials $NOTARY_PROFILE --apple-id <apple-id> --team-id <TEAMID>"
    fi
    die "notarytool auth check failed:
$notary_out"
  fi
fi

if [[ $PUBLISH -eq 1 ]]; then
  log "Checking gh auth for '$GH_RELEASE_USER'"
  can_push="$(gh_release api "repos/$GH_REPO" --jq '.permissions.push')" ||
    die "gh as '$GH_RELEASE_USER' cannot read $GH_REPO"
  [[ "$can_push" == "true" ]] || die "'$GH_RELEASE_USER' has no push access to $GH_REPO"
fi

# ---------------------------------------------------------------------------
# Build + sign
# ---------------------------------------------------------------------------

if [[ ! -x node_modules/.bin/tauri ]]; then
  log "node_modules missing; running npm ci"
  npm ci
fi

log "Building $TARGET (Tauri signs the .app with the hardened runtime)"
# Strip Apple notarization creds from the env so Tauri only signs; we
# notarize explicitly below with the keychain profile.
env -u APPLE_ID -u APPLE_PASSWORD -u APPLE_TEAM_ID -u APPLE_API_KEY -u APPLE_API_ISSUER -u APPLE_API_KEY_PATH \
  APPLE_SIGNING_IDENTITY="$APPLE_SIGNING_IDENTITY" \
  npm run tauri build -- --target "$TARGET" --bundles app,dmg

[[ -d "$APP_PATH" ]] || die "app bundle not found at $APP_PATH"
src_dmg="$BUNDLE_DIR/dmg/${PRODUCT_NAME}_${VERSION}_universal.dmg"
[[ -f "$src_dmg" ]] || die "DMG not found at $src_dmg"

mkdir -p "$OUT_DIR"
cp -f "$src_dmg" "$DMG"

log "Verifying .app signature"
codesign --verify --deep --strict --verbose=2 "$APP_PATH"
sig_info="$(codesign -dv --verbose=4 "$APP_PATH" 2>&1)"
grep -Fq "Authority=$APPLE_SIGNING_IDENTITY" <<<"$sig_info" || die ".app is not signed by $APPLE_SIGNING_IDENTITY"
grep -Eq '^CodeDirectory .*flags=.*runtime' <<<"$sig_info" || die ".app is missing the hardened runtime flag"
grep -q '^Timestamp=' <<<"$sig_info" || die ".app signature has no secure timestamp"

log "Signing DMG"
codesign --force --timestamp --sign "$APPLE_SIGNING_IDENTITY" "$DMG"
codesign --verify --strict --verbose=2 "$DMG"

# ---------------------------------------------------------------------------
# Notarize + staple
# ---------------------------------------------------------------------------

if [[ $SKIP_NOTARIZE -eq 1 ]]; then
  warn "--skip-notarize: DMG is signed but NOT notarized; Gatekeeper will reject it on other Macs."
else
  log "Submitting to the Apple notary service (usually 1-5 minutes)"
  submit_out="$(xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait 2>&1)" || true
  printf '%s\n' "$submit_out"
  submission_id="$(sed -n 's/^ *id: \([0-9a-f-]\{36\}\).*/\1/p' <<<"$submit_out" | head -n1)"
  if ! grep -q 'status: Accepted' <<<"$submit_out"; then
    if [[ -n "$submission_id" ]]; then
      warn "Notarization not accepted; fetching log for $submission_id"
      xcrun notarytool log "$submission_id" --keychain-profile "$NOTARY_PROFILE" || true
    fi
    die "notarization was not accepted"
  fi

  log "Stapling ticket to the DMG"
  xcrun stapler staple "$DMG"
  xcrun stapler validate "$DMG"

  log "Gatekeeper assessment"
  spctl -a -vv -t install "$DMG"
fi

(cd "$OUT_DIR" && shasum -a 256 "$(basename "$DMG")" | tee "$(basename "$DMG").sha256")
log "Artifact: $DMG"

# ---------------------------------------------------------------------------
# Publish: draft release + DMG upload + tag push
# ---------------------------------------------------------------------------

if [[ $PUBLISH -eq 0 ]]; then
  log "Not publishing (pass --publish to create the draft release and push $TAG)."
  exit 0
fi

RELEASE_BODY="$(
  cat <<'EOF'
### Install
- **macOS (universal: Apple Silicon + Intel):** download `Excalidraw-Desktop_<version>_universal.dmg`, open it, and drag the app to Applications. The DMG is **signed with a Developer ID and notarized by Apple**, so it opens without Gatekeeper warnings.
- **Windows:** download the `.msi` or `-setup.exe` installer. Windows builds are **unsigned**, so SmartScreen will warn ("More info" → "Run anyway").

### Logs
The app writes a rolling log file at `~/.excalidraw-desktop/excalidraw-desktop.log` (macOS) or `%USERPROFILE%\.excalidraw-desktop\excalidraw-desktop.log` (Windows). Attach the tail when reporting issues.
EOF
)"
RELEASE_BODY="${RELEASE_BODY//<version>/$VERSION}"

if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  [[ "$(git rev-parse "$TAG^{commit}")" == "$HEAD_SHA" ]] || die "local tag $TAG does not point at HEAD"
else
  log "Creating annotated tag $TAG"
  git tag -a "$TAG" -m "Excalidraw Desktop $TAG"
fi

# Create the draft before pushing the tag so the Windows CI job
# (tauri-action, which looks up releases by tag name) reuses it.
if gh_release release view "$TAG" --repo "$GH_REPO" >/dev/null 2>&1; then
  log "Release $TAG already exists; uploading DMG to it"
else
  log "Creating draft release $TAG"
  gh_release release create "$TAG" --repo "$GH_REPO" --draft \
    --target "$HEAD_SHA" --title "Excalidraw Desktop $TAG" --notes "$RELEASE_BODY"
fi
gh_release release upload "$TAG" --repo "$GH_REPO" --clobber "$DMG" "$DMG.sha256"

log "Pushing tag $TAG as $GH_RELEASE_USER (triggers the Windows CI build)"
# The token travels via the environment to an inline credential helper, so
# it never appears on the command line or in output.
# shellcheck disable=SC2016 # $GH_PUSH_TOKEN is expanded by git's helper shell
GH_PUSH_TOKEN="$(release_token)" git \
  -c credential.helper= \
  -c 'credential.helper=!f() { echo username=x-access-token; echo "password=$GH_PUSH_TOKEN"; }; f' \
  push "https://github.com/$GH_REPO.git" "refs/tags/$TAG"

log "Done. Review the draft (Windows assets arrive when CI finishes), then publish:"
log "  https://github.com/$GH_REPO/releases"

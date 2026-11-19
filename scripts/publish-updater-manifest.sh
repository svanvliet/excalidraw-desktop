#!/usr/bin/env bash
# Merge this platform's entries into a GitHub release's latest.json and
# upload it, safely against the other platform doing the same.
#
# Usage:
#   scripts/publish-updater-manifest.sh <tag> <dir>/latest.json <updater-manifest.mjs args…>
#
#   <updater-manifest.mjs args> are --version, --platform…, --sig, --url and
#   optionally --notes/--notes-file (no --base/--out; this script sets them).
#
# Environment: GH_REPO (owner/name) and a gh token (GH_TOKEN) that can write
# releases. Works on drafts.
#
# Each attempt downloads the release's latest.json (if any), merges our
# platforms over it, re-checks that nobody replaced latest.json meanwhile,
# uploads with --clobber, then re-downloads and confirms our entries survived.
# Retries if the other platform's upload interleaved. Idempotent.

set -euo pipefail

[[ $# -ge 3 ]] || {
  sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
}
TAG="$1"
OUT="$2"
shift 2
: "${GH_REPO:?GH_REPO must be set}"
[[ "$(basename "$OUT")" == latest.json ]] || {
  echo "error: output file must be named latest.json (it becomes the asset name)" >&2
  exit 2
}

SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

sig_file=""
platforms=()
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  case "${args[i]}" in
    --sig) sig_file="${args[i + 1]}" ;;
    --platform) platforms+=("${args[i + 1]}") ;;
  esac
done
[[ -n "$sig_file" && ${#platforms[@]} -gt 0 ]] || {
  echo "error: --sig and at least one --platform are required" >&2
  exit 2
}

manifest_asset_id() {
  gh release view "$TAG" --repo "$GH_REPO" --json assets \
    --jq '[.assets[] | select(.name == "latest.json") | .id] | first // ""'
}

for attempt in 1 2 3 4 5; do
  work="$(mktemp -d)"
  before="$(manifest_asset_id)"
  base="$work/none.json"
  if [[ -n "$before" ]]; then
    gh release download "$TAG" --repo "$GH_REPO" --pattern latest.json --dir "$work"
    base="$work/latest.json"
  fi
  node "$SCRIPTS/updater-manifest.mjs" "$@" --base "$base" --out "$OUT"

  if [[ "$(manifest_asset_id)" != "$before" ]]; then
    echo "latest.json changed on $TAG while merging; retrying ($attempt/5)" >&2
  else
    gh release upload "$TAG" --repo "$GH_REPO" --clobber "$OUT"
    sleep 2
    rm -f "$work/latest.json"
    gh release download "$TAG" --repo "$GH_REPO" --pattern latest.json --dir "$work"
    if node -e '
      const fs = require("fs");
      const [file, sigFile, ...keys] = process.argv.slice(1);
      const m = JSON.parse(fs.readFileSync(file, "utf8"));
      const sig = fs.readFileSync(sigFile, "utf8").trim();
      process.exit(keys.every((k) => m.platforms?.[k]?.signature === sig) ? 0 : 1);
    ' "$work/latest.json" "$sig_file" "${platforms[@]}"; then
      cp "$work/latest.json" "$OUT"
      rm -rf "$work"
      echo "latest.json on $TAG now lists: $(node -p 'Object.keys(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).platforms).join(", ")' "$OUT")"
      exit 0
    fi
    echo "uploaded latest.json lost our entries (concurrent upload?); retrying ($attempt/5)" >&2
  fi
  rm -rf "$work"
  sleep $((attempt * 5))
done
echo "error: could not publish latest.json with ${platforms[*]} to $TAG" >&2
exit 1

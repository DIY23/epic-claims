#!/usr/bin/env bash
# Builds a distributable release archive + checksums (+ optional ed25519 signature).
#
#   scripts/package-release.sh [--out <dir>] [--sign]
#
# Result (in release/):
#   epic-claims-<version>.tar.gz
#   SHA256SUMS
#   SHA256SUMS.sig            (only with --sign and EPIC_CLAIMS_SIGNING_KEY set)
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

out="$root/release"
sign=0
while [ $# -gt 0 ]; do
  case "$1" in
    --out) out="$2"; shift 2 ;;
    --sign) sign=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

version="$(node -p "require('./package.json').version")"
name="epic-claims-$version"
stage="$out/$name"

echo "==> building epic-claims $version"
npm run build >/dev/null

echo "==> building the native notification helper"
bash native/build-helper.sh "$root/build/native" >/dev/null

echo "==> staging $stage"
rm -rf "$stage"
mkdir -p "$stage/native"

cp -R dist "$stage/dist"
cp package.json package-lock.json "$stage/"
cp -R "$root/build/native/EpicClaimsNotifier.app" "$stage/native/"
cp LICENSE README.md CHANGELOG.md "$stage/" 2>/dev/null || true

echo "==> installing production dependencies into the archive"
( cd "$stage" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null )

# Never ship source maps or dev leftovers.
find "$stage" -name "*.map" -delete 2>/dev/null || true

size_kb=$(( $(du -sk "$stage" | awk '{print $1}') ))
echo "    staged payload: ${size_kb} KB"

echo "==> creating archive"
rm -f "$out/$name.tar.gz"
tar -C "$out" -czf "$out/$name.tar.gz" "$name"

echo "==> writing checksums"
( cd "$out" && shasum -a 256 "$name.tar.gz" > SHA256SUMS )
cat "$out/SHA256SUMS"

if [ "$sign" = "1" ]; then
  echo "==> signing checksums"
  node "$root/scripts/sign-release.mjs" "$out/SHA256SUMS" "$out/SHA256SUMS.sig"
fi

echo "release artifacts in $out"

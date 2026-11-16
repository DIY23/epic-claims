#!/usr/bin/env bash
# One-time bootstrap installer.
#
#   curl -fsSL https://raw.githubusercontent.com/DIY23/epic-claims/main/scripts/install.sh | bash
#
# Afterwards everything is done through the `epic-claims` command — including
# updates (`epic-claims update`), which never touch your data.
set -euo pipefail

REPO="${EPIC_CLAIMS_REPO:-DIY23/epic-claims}"
VERSION="${EPIC_CLAIMS_VERSION:-latest}"
DATA="$HOME/Library/Application Support/Epic Claims"
INSTALL="$DATA/install"
BIN_DIR="$HOME/.local/bin"
API="https://api.github.com/repos/$REPO/releases"

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "Node.js (>= 24) is required for Epic Claims"
node -e 'const [maj]=process.versions.node.split(".").map(Number); if (maj < 24) { console.error("Node 24 or newer is required (found "+process.version+")"); process.exit(1);}'

say "==> resolving release ($VERSION)"
if [ "$VERSION" = "latest" ]; then
  ASSET_JSON="$(curl -fsSL "$API/latest")"
else
  ASSET_JSON="$(curl -fsSL "$API/tags/v$VERSION")"
fi

TARBALL_URL="$(printf '%s' "$ASSET_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);const a=(r.assets||[]).find(x=>/\.tar\.gz$/.test(x.name));if(!a){console.error("no tarball asset in release");process.exit(1);}process.stdout.write(a.browser_download_url);})')"
SUMS_URL="$(printf '%s' "$ASSET_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);const a=(r.assets||[]).find(x=>x.name==="SHA256SUMS");if(!a){console.error("release has no SHA256SUMS");process.exit(1);}process.stdout.write(a.browser_download_url);})')"
VER="$(printf '%s' "$ASSET_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);process.stdout.write(String(r.tag_name||"").replace(/^v/,""));})')"
[ -n "$VER" ] || die "could not determine the release version"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

say "==> downloading epic-claims $VER"
curl -fsSL "$TARBALL_URL" -o "$TMP/pkg.tar.gz"
curl -fsSL "$SUMS_URL" -o "$TMP/SHA256SUMS"
( cd "$TMP" && shasum -a 256 -c SHA256SUMS ) || die "checksum verification failed"

say "==> installing into $INSTALL/versions/$VER"
mkdir -p "$INSTALL/versions"
rm -rf "$INSTALL/versions/$VER"
tar -C "$TMP" -xzf "$TMP/pkg.tar.gz"
mv "$TMP/epic-claims-$VER" "$INSTALL/versions/$VER"

ln -sfn "versions/$VER" "$INSTALL/current.tmp"
mv -f "$INSTALL/current.tmp" "$INSTALL/current"

mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/epic-claims" <<EOF
#!/bin/sh
exec "$(command -v node)" "$INSTALL/current/dist/cli/index.js" "\$@"
EOF
chmod 755 "$BIN_DIR/epic-claims"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) say "note: add $BIN_DIR to your PATH to call 'epic-claims' directly" ;;
esac

say ""
say "installed epic-claims $VER"
say "next steps:"
say "  1) epic-claims auth login        # one-time Epic sign-in (opens a browser)"
say "  2) epic-claims config set claiming.mode approval"
say "  3) epic-claims service install   # run in the background via launchd"
say "  4) epic-claims update check      # and later: epic-claims update"
